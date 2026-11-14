import {
  type RawShopeeApiResponse,
  type RawShopeeOrder,
  type NormalizedOrder,
  type NormalizedItem,
  type FetchProgress,
  normalizeShopeeAmount,
  decodeOrderTimeMs,
  formatOrderDate,
} from '../types/shopee';
import { db } from '../db';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class ShopeeFetcherService {
  private abortController: AbortController | null = null;
  private isRunning: boolean = false;

  get running(): boolean {
    return this.isRunning;
  }

  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning = false;
  }

  /**
   * Checks if user has valid Shopee cookies
   */
  async checkSession(): Promise<{ loggedIn: boolean; username?: string; error?: string }> {
    try {
      const spcEc = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'SPC_EC' });
      const spcU = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'SPC_U' });

      if (spcEc?.value || spcU?.value) {
        return { loggedIn: true, username: 'Shopee User' };
      }

      return { loggedIn: false, error: 'No active session cookie found (SPC_EC). Please log in on shopee.com.my' };
    } catch (err: any) {
      return { loggedIn: false, error: err?.message || 'Error checking cookies' };
    }
  }

  /**
   * Saves a raw API response directly into the database
   */
  async saveRawPayload(json: RawShopeeApiResponse): Promise<number> {
    const { orders } = this.extractOrdersFromPayload(json, 10);
    if (orders.length > 0) {
      const normalized = orders
        .map((o) => this.normalizeOrder(o))
        .filter((o): o is NormalizedOrder => o !== null);
      if (normalized.length === 0) return 0;
      await this.fillMissingDates(normalized);
      await db.upsertOrders(normalized);
      return normalized.length;
    }
    return 0;
  }

  /**
   * Fetches all orders with dual-strategy:
   * Strategy 1: Direct fetch via declarativeNetRequest rewritten headers (fastest & cleanest).
   * Strategy 2: Tab-based content script fetch fallback.
   *
   * fullSync=false (default): newest first, stop after a page whose orders are all already saved
   * and finished (completed / cancelled / refunded). Unfinished orders keep being refreshed.
   * fullSync=true: walk the whole history again.
   * openTabIfNeeded=false: if the direct request fails, only use a Shopee tab that is already
   * open (used by the background daily sync, so it never opens tabs on its own).
   */
  async fetchAllPurchases(
    onProgress: (progress: FetchProgress) => void,
    onLog?: (log: string) => void,
    limit: number = 10,
    options: { fullSync?: boolean; openTabIfNeeded?: boolean } = {}
  ): Promise<{ success: boolean; totalFetched: number; error?: string }> {
    const fullSync = options.fullSync ?? false;
    const openTabIfNeeded = options.openTabIfNeeded ?? true;
    if (this.isRunning) {
      return { success: false, totalFetched: 0, error: 'A sync is already in progress' };
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const log = (msg: string) => {
      console.log(`[ShopeeTracker] ${msg}`);
      if (onLog) onLog(msg);
    };

    let offset = 0;
    let totalFetched = 0;
    let hasMore = true;

    try {
      log(fullSync ? 'Starting full purchase history sync...' : 'Starting sync of new and updated purchases...');
      
      // Ensure Net rules are active in background
      await chrome.runtime.sendMessage({ type: 'ENSURE_NET_RULES' }).catch(() => {});

      // Read CSRF token cookie if present
      const csrfCookie = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'csrftoken' });
      const csrfToken = csrfCookie?.value || '';
      log(csrfToken ? 'Found CSRF token.' : 'No CSRF cookie found (proceeding with session cookies).');

      let useTabFallback = false;
      let fallbackTabId: number | null = null;

      while (hasMore) {
        if (signal.aborted) {
          log('Sync cancelled by user.');
          this.isRunning = false;
          return { success: false, totalFetched, error: 'Sync was cancelled' };
        }

        onProgress({
          currentOffset: offset,
          totalFetched,
          isFinished: false,
          isError: false,
        });

        let ordersBatch: { orders: RawShopeeOrder[]; hasMore?: boolean; nextOffset?: number };

        if (!useTabFallback) {
          try {
            log(`Fetching batch: offset=${offset}, limit=${limit} (Direct API)...`);
            ordersBatch = await this.fetchPageDirect(offset, limit, csrfToken, signal);
          } catch (directErr: any) {
            log(`Direct fetch encountered: ${directErr.message}. Switching to tab-assisted fetch...`);
            useTabFallback = true;
            fallbackTabId = await this.ensureShopeeTab(log, openTabIfNeeded);
            log(`Using Shopee Tab #${fallbackTabId} for fetching...`);
            ordersBatch = await this.fetchPageFromTab(fallbackTabId, offset, limit);
          }
        } else {
          if (!fallbackTabId) {
            fallbackTabId = await this.ensureShopeeTab(log, openTabIfNeeded);
          }
          log(`Fetching batch: offset=${offset}, limit=${limit} (via Tab #${fallbackTabId})...`);
          ordersBatch = await this.fetchPageFromTab(fallbackTabId, offset, limit);
        }

        if ((!ordersBatch.orders || ordersBatch.orders.length === 0) && ordersBatch.hasMore) {
          // e.g. a page holding only unpaid checkouts: skip ahead instead of stopping
          log(`No orders at offset ${offset} (checkouts only), continuing...`);
          offset = ordersBatch.nextOffset !== undefined && ordersBatch.nextOffset > offset ? ordersBatch.nextOffset : offset + limit;
          continue;
        }

        if (!ordersBatch.orders || ordersBatch.orders.length === 0) {
          log(`No more orders returned at offset ${offset}. Reached end of order history.`);
          hasMore = false;
          break;
        }

        log(`Received ${ordersBatch.orders.length} orders in this batch.`);
        const normalizedBatch = ordersBatch.orders
          .map((o) => this.normalizeOrder(o))
          .filter((o): o is NormalizedOrder => o !== null);

        if (normalizedBatch.length > 0) {
          const existing = await db.getByIds(normalizedBatch.map((o) => o.orderId));
          // Keep dates already looked up, so old orders aren't re-fetched from order detail every sync
          normalizedBatch.forEach((o, i) => {
            const prev = existing[i];
            if (!o.createdAt && prev?.createdAt) {
              o.createdAt = prev.createdAt;
              o.createdAtFormatted = prev.createdAtFormatted;
              o.dateIsApproximate = prev.dateIsApproximate;
              if (prev.orderSn && prev.orderSn !== prev.orderId) o.orderSn = prev.orderSn;
            }
          });
          var batchAlreadyFinal =
            !fullSync &&
            existing.length === normalizedBatch.length &&
            existing.every((prev) => prev && (prev.isCompleted || prev.isCancelled || prev.isRefunded));

          await this.fillMissingDates(normalizedBatch, log, useTabFallback ? fallbackTabId : null, signal, csrfToken);
          if (signal.aborted) {
            log('Sync cancelled by user.');
            this.isRunning = false;
            return { success: false, totalFetched, error: 'Sync was cancelled' };
          }

          // Save batch immediately to IndexedDB
          await db.upsertOrders(normalizedBatch);
          totalFetched += normalizedBatch.length;
          log(`Saved to local database. Total orders cached so far: ${totalFetched}.`);
        } else {
          var batchAlreadyFinal = false;
        }

        onProgress({
          currentOffset: offset,
          totalFetched,
          isFinished: false,
          isError: false,
          currentOrderSn: normalizedBatch[normalizedBatch.length - 1]?.orderSn,
        });

        if (ordersBatch.hasMore !== undefined) {
          hasMore = ordersBatch.hasMore;
        } else {
          hasMore = ordersBatch.orders.length >= limit;
        }

        if (batchAlreadyFinal && hasMore) {
          log('Reached orders that are already saved and finished. Stopping (tick "Full sync" to re-sync everything).');
          hasMore = false;
        }

        if (ordersBatch.nextOffset !== undefined && ordersBatch.nextOffset > offset) {
          offset = ordersBatch.nextOffset;
        } else {
          offset += limit;
        }

        if (hasMore) {
          // Polite delay between pages
          const delay = 450 + Math.floor(Math.random() * 250);
          log(`Waiting ${delay}ms before next page...`);
          await sleep(delay, signal);
        }
      }

      this.isRunning = false;
      log(`Sync successfully completed! Total purchases retrieved: ${totalFetched}.`);
      onProgress({
        currentOffset: offset,
        totalFetched,
        isFinished: true,
        isError: false,
      });

      return { success: true, totalFetched };
    } catch (err: any) {
      this.isRunning = false;
      const isAbort = err.name === 'AbortError' || signal.aborted;
      const errMsg = isAbort ? 'Sync stopped' : err?.message || 'Error fetching orders';
      log(`Sync error: ${errMsg}`);

      onProgress({
        currentOffset: offset,
        totalFetched,
        isFinished: true,
        isError: !isAbort,
        errorMessage: errMsg,
      });

      return {
        success: isAbort,
        totalFetched,
        error: isAbort ? undefined : errMsg,
      };
    }
  }

  /**
   * Direct fetch leveraging declarativeNetRequest header rewrites
   */
  private async fetchPageDirect(
    offset: number,
    limit: number,
    csrfToken: string,
    signal: AbortSignal
  ): Promise<{ orders: RawShopeeOrder[]; hasMore?: boolean; nextOffset?: number }> {
    const url = `https://shopee.com.my/api/v4/order/get_all_order_and_checkout_list?limit=${limit}&offset=${offset}`;

    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      'x-api-source': 'pc',
      'x-shopee-language': 'en',
    };

    if (csrfToken) {
      headers['x-csrftoken'] = csrfToken;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal,
    });

    if (!res.ok) {
      throw new Error(`Shopee API responded with status ${res.status} (${res.statusText})`);
    }

    const json: RawShopeeApiResponse = await res.json();
    return this.extractOrdersFromPayload(json, limit);
  }

  /**
   * For orders with no usable date (pre-2019 IDs without tracking time), read the order time
   * and order SN from get_order_detail. One request per such order, so this only runs for the few
   * that need it. Tries a direct request first, then an open Shopee tab.
   */
  async fillMissingDates(
    orders: NormalizedOrder[],
    log?: (msg: string) => void,
    tabId: number | null = null,
    signal?: AbortSignal,
    csrfToken?: string
  ): Promise<void> {
    const missing = orders.filter((o) => !o.createdAt);
    if (!missing.length) return;
    log?.(`Looking up order time for ${missing.length} older order(s)...`);

    let directWorks = true;
    for (const order of missing) {
      if (signal?.aborted) return;
      let detail: any = null;
      if (directWorks) {
        try {
          detail = await this.fetchOrderDetailDirect(order.orderId, csrfToken, signal);
        } catch (err: any) {
          if (err?.name === 'AbortError' || signal?.aborted) return;
          directWorks = false;
        }
      }
      if (!detail && !signal?.aborted) {
        if (tabId === null) {
          const tabs = await chrome.tabs
            .query({ url: ['https://shopee.com.my/*', 'https://*.shopee.com.my/*'] })
            .catch(() => [] as chrome.tabs.Tab[]);
          tabId = tabs[0]?.id ?? null;
        }
        if (tabId !== null) {
          const res: any = await chrome.tabs
            .sendMessage(tabId, { type: 'FETCH_ORDER_DETAIL_FROM_TAB', orderId: order.orderId })
            .catch(() => null);
          if (res?.success && res.data?.error === 0) detail = res.data;
        }
      }

      const info = detail?.data?.processing_info;
      const row = (info?.info_rows || []).find((r: any) => r?.info_label?.text === 'label_odp_order_time');
      const seconds = Number(row?.info_value?.value);
      if (seconds > 0) {
        order.createdAt = seconds * 1000;
        order.createdAtFormatted = formatOrderDate(order.createdAt);
        order.dateIsApproximate = false;
      }
      if (info?.order_sn) order.orderSn = info.order_sn;

      await sleep(400 + Math.floor(Math.random() * 300), signal);
    }

    const still = missing.filter((o) => !o.createdAt).length;
    if (still && !signal?.aborted) {
      log?.(`Could not find the order time for ${still} order(s); they show as "Unknown date".`);
    }
  }

  private async fetchOrderDetailDirect(orderId: string, csrfToken?: string, signal?: AbortSignal): Promise<any> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      'x-api-source': 'pc',
      'x-shopee-language': 'en',
    };
    if (csrfToken) headers['x-csrftoken'] = csrfToken;

    const res = await fetch(
      `https://shopee.com.my/api/v4/order/get_order_detail?order_id=${encodeURIComponent(orderId)}`,
      {
        headers,
        credentials: 'include',
        signal,
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error !== 0) throw new Error(json?.error_msg || `Shopee error ${json?.error}`);
    return json;
  }

  /**
   * Tab-assisted fetch using content script
   */
  private async fetchPageFromTab(
    tabId: number,
    offset: number,
    limit: number
  ): Promise<{ orders: RawShopeeOrder[]; hasMore?: boolean; nextOffset?: number }> {
    const res: any = await chrome.tabs.sendMessage(tabId, {
      type: 'FETCH_ORDERS_FROM_TAB',
      offset,
      limit,
    });

    if (!res) {
      throw new Error('No response from Shopee tab.');
    }

    if (!res.success) {
      throw new Error(res.error || `Failed to fetch orders (Status ${res.status || 'unknown'})`);
    }

    return this.extractOrdersFromPayload(res.data, limit);
  }

  private extractOrdersFromPayload(
    json: RawShopeeApiResponse,
    limit: number
  ): { orders: RawShopeeOrder[]; hasMore?: boolean; nextOffset?: number } {
    if (json.error !== 0 && json.error !== undefined) {
      throw new Error(json.error_msg || `Shopee API error code: ${json.error}`);
    }

    // Current format: new_data.order_or_checkout_data[].order_list_detail
    const newData: any = json.new_data;
    if (newData && Array.isArray(newData.order_or_checkout_data)) {
      const entries: any[] = newData.order_or_checkout_data;
      // Unpaid checkouts have no order_list_detail; skip them
      const orders = entries.map((e) => e?.order_list_detail).filter(Boolean);
      // Base hasMore on raw entries so skipped checkouts don't end paging early
      const hasMore = newData.has_more ?? entries.length >= limit;
      return { orders, hasMore, nextOffset: newData.next_offset };
    }

    const data: any = json.data;
    if (!data) {
      return { orders: [], hasMore: false };
    }

    let orders: RawShopeeOrder[] = [];
    if (data.orders_data && !Array.isArray(data.orders_data) && Array.isArray(data.orders_data.order_list)) {
      orders = data.orders_data.order_list;
    } else if (Array.isArray(data.details_list)) {
      orders = data.details_list;
    } else if (Array.isArray(data.order_list_cards)) {
      orders = data.order_list_cards;
    } else if (Array.isArray(data.order_list)) {
      orders = data.order_list;
    } else if (Array.isArray(data.orders)) {
      orders = data.orders;
    } else if (Array.isArray(data.orders_data)) {
      orders = data.orders_data;
    }

    const hasMore = data.has_more ?? orders.length >= limit;
    const nextOffset = data.next_offset;

    return { orders, hasMore, nextOffset };
  }

  /**
   * Ensures an active Shopee tab exists and has content script loaded
   */
  private async ensureShopeeTab(log: (msg: string) => void, allowOpen: boolean = true): Promise<number> {
    const tabs = await chrome.tabs.query({ url: ['https://shopee.com.my/*', 'https://*.shopee.com.my/*'] });
    let tab = tabs[0];

    if ((!tab || !tab.id) && !allowOpen) {
      throw new Error('Direct request was blocked and no Shopee tab is open');
    }

    if (!tab || !tab.id) {
      log('Opening Shopee MY tab in background...');
      tab = await chrome.tabs.create({
        url: 'https://shopee.com.my/user/purchase',
        active: false,
      });

      // Wait for tab to load
      await new Promise<void>((resolve) => {
        const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 5000); // Safety fallback timeout
      });
    }

    const tabId = tab.id!;

    // Test ping or inject script
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING_SHOPEE_TAB' });
      if (ping?.active) {
        return tabId;
      }
    } catch {
      log('Injecting helper into Shopee tab...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await new Promise((r) => setTimeout(r, 600));
      } catch (err: any) {
        log(`Script injection warning: ${err.message}`);
      }
    }

    return tabId;
  }

  private normalizeOrder(raw: any): NormalizedOrder | null {
    if (raw?.order_list_detail) raw = raw.order_list_detail;
    if (raw?.info_card?.order_list_cards && raw.status && typeof raw.status === 'object') {
      return this.normalizeListDetail(raw);
    }

    const infoCard = raw.info_card || {};
    const rawId = raw.order_id ?? infoCard.order_id ?? raw.order_sn ?? infoCard.order_sn;
    if (rawId === undefined || rawId === null || rawId === '') return null;
    const orderId = String(rawId);
    const orderSn = raw.order_sn || infoCard.order_sn || orderId;

    const createTimeSeconds =
      raw.create_time ||
      infoCard.create_time ||
      raw.paid_time ||
      infoCard.paid_time ||
      0;
    const createdAtMs = createTimeSeconds ? createTimeSeconds * 1000 : decodeOrderTimeMs(orderId) ?? 0;
    const createdAtFormatted = formatOrderDate(createdAtMs);

    const statusRaw = raw.status ?? infoCard.status ?? raw.status_label ?? 'Unknown';
    const statusDesc = (
      raw.status_description ||
      infoCard.status_description ||
      raw.status_label ||
      infoCard.status_label ||
      String(statusRaw)
    ).toLowerCase();

    const isCompleted =
      statusRaw === 4 ||
      statusDesc.includes('completed') ||
      statusDesc.includes('delivered');

    const isCancelled =
      statusRaw === 5 ||
      statusDesc.includes('cancelled') ||
      statusDesc.includes('canceled');

    const isRefunded =
      statusRaw === 6 ||
      statusDesc.includes('refund') ||
      statusDesc.includes('return');

    let displayStatus = 'Processing';
    if (isCompleted) displayStatus = 'Completed';
    else if (isCancelled) displayStatus = 'Cancelled';
    else if (isRefunded) displayStatus = 'Return/Refund';
    else if (raw.status_description || infoCard.status_description) {
      displayStatus = raw.status_description || infoCard.status_description;
    }

    const totalPrice = normalizeShopeeAmount(
      raw.final_total ?? infoCard.final_total ?? raw.total_price ?? raw.paid_amount
    );
    const shippingFee = normalizeShopeeAmount(raw.shipping_fee ?? infoCard.shipping_fee);

    // Items extraction: handle raw.item_list, info_card.order_list_cards, items
    const rawItems: any[] =
      raw.item_list ||
      infoCard.order_list_cards ||
      raw.items ||
      infoCard.items ||
      [];

    let itemCount = 0;
    const items: NormalizedItem[] = rawItems.map((item) => {
      const q = item.amount || item.item_amount || item.quantity || 1;
      itemCount += q;
      const unitPrice = normalizeShopeeAmount(item.item_price || item.price || item.unit_price);

      let imageUrl = item.image || item.item_image || item.image_url;
      if (imageUrl && !imageUrl.startsWith('http')) {
        imageUrl = `https://down-my.img.susercontent.com/file/${imageUrl}`;
      }

      return {
        itemId: String(item.item_id || item.id || Math.random()),
        name: item.name || item.item_name || item.title || 'Shopee Product',
        modelName: item.model_name || item.variation || '',
        quantity: q,
        unitPrice,
        totalPrice: Math.round(unitPrice * q * 100) / 100,
        imageUrl,
      };
    });

    if (itemCount === 0) itemCount = 1;

    const shopName =
      raw.shop_info?.shop_name ||
      infoCard.shop_name ||
      raw.shop_info?.username ||
      'Shopee Seller';
    const shopId = raw.shop_info?.shop_id ? String(raw.shop_info.shop_id) : undefined;

    return {
      orderId,
      orderSn,
      createdAt: createdAtMs,
      createdAtFormatted,
      status: displayStatus,
      statusRaw,
      isCompleted,
      isCancelled,
      isRefunded,
      totalPrice,
      shippingFee,
      shopName,
      shopId,
      itemCount,
      items,
    };
  }

  /**
   * Normalizes the current order_list_detail format:
   * { status: { status_label: { text: 'label_order_completed' } }, shipping: { tracking_info: { ctime } },
   *   info_card: { order_id, final_total, order_list_cards: [{ shop_info, product_info: { item_groups: [{ items }] } }] } }
   * The list no longer carries create_time or order_sn, so the date is the last tracking update.
   */
  private normalizeListDetail(raw: any): NormalizedOrder | null {
    const infoCard = raw.info_card || {};
    const cards: any[] = Array.isArray(infoCard.order_list_cards) ? infoCard.order_list_cards : [];
    const rawId = infoCard.order_id ?? cards[0]?.order_id;
    if (rawId === undefined || rawId === null || rawId === '') return null;
    const orderId = String(rawId);

    // 1) exact: decode from the order ID; 2) approximate: last tracking update; 3) unknown (filled later via order detail)
    const decoded = decodeOrderTimeMs(orderId);
    const ctime = Number(raw.shipping?.tracking_info?.ctime) || 0;
    const createdAtMs = decoded ?? (ctime > 0 ? ctime * 1000 : 0);
    const dateIsApproximate = decoded === null;
    const createdAtFormatted = formatOrderDate(createdAtMs);

    const statusKey: string = raw.status?.status_label?.text || '';
    const listKey: string = raw.status?.list_view_status_label?.text || '';
    const keys = `${statusKey} ${listKey}`.toLowerCase();

    const isCancelled = keys.includes('cancel');
    const isRefunded = !isCancelled && (keys.includes('refund') || keys.includes('return'));
    // 'label_order_delivered' is still "To Receive", so only an explicit completed label counts
    const isCompleted = !isCancelled && !isRefunded && keys.includes('completed');

    let displayStatus: string;
    if (isCompleted) displayStatus = 'Completed';
    else if (isCancelled) displayStatus = 'Cancelled';
    else if (isRefunded) displayStatus = 'Return/Refund';
    else displayStatus = this.labelToText(listKey || statusKey) || 'Processing';

    const totalPrice = normalizeShopeeAmount(infoCard.final_total ?? infoCard.subtotal);

    const items: NormalizedItem[] = [];
    let itemCount = 0;
    for (const card of cards) {
      for (const group of card?.product_info?.item_groups || []) {
        for (const item of group?.items || []) {
          const q = Number(item.amount) || 1;
          itemCount += q;
          const unitPrice = normalizeShopeeAmount(item.item_price ?? item.order_price);
          let imageUrl: string | undefined = item.image;
          if (imageUrl && !imageUrl.startsWith('http')) {
            imageUrl = `https://down-my.img.susercontent.com/file/${imageUrl}`;
          }
          items.push({
            itemId: String(item.item_id ?? Math.random()),
            name: item.name || 'Shopee Product',
            modelName: item.model_name || '',
            quantity: q,
            unitPrice,
            totalPrice: Math.round(unitPrice * q * 100) / 100,
            imageUrl,
          });
        }
      }
    }
    if (itemCount === 0) itemCount = Number(infoCard.product_count) || 1;

    const shop = cards[0]?.shop_info || {};

    return {
      orderId,
      orderSn: orderId, // order_sn is only in get_order_detail
      createdAt: createdAtMs,
      createdAtFormatted,
      dateIsApproximate,
      status: displayStatus,
      statusRaw: statusKey || listKey || 'Unknown',
      isCompleted,
      isCancelled,
      isRefunded,
      totalPrice,
      shippingFee: 0, // not in the list response
      shopName: shop.shop_name || shop.username || 'Shopee Seller',
      shopId: shop.shop_id ? String(shop.shop_id) : undefined,
      itemCount,
      items,
    };
  }

  /** 'label_to_receive' -> 'To Receive' */
  private labelToText(label: string): string {
    return label
      .replace(/^label_/, '')
      .replace(/^order_/, '')
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}

export const shopeeFetcher = new ShopeeFetcherService();

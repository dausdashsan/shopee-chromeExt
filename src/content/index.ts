// Content Script running in ISOLATED world
// Hosts the In-Page Auto-Paginator and Widget on shopee.com.my/user/purchase

console.log('[ShopeeTracker:ISOLATED] Controller initialized on', window.location.href);

let totalCapturedOrders = 0;
let isAutoSyncing = false;
let autoSyncInterval: any = null;

function safeSendMessage(msg: any) {
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
  } catch {}
}

// Ask the MAIN-world interceptor to run a fetch with the page's own (Shopee-wrapped) fetch
function fetchViaPage(
  path: string,
  timeoutMs = 20000,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown
): Promise<{ success: boolean; status?: number; data?: any; error?: string }> {
  return new Promise((resolve) => {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const onMsg = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'SHOPEE_TRACKER_FETCH_RESULT' || event.data.reqId !== reqId) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      const { success, status, data, error } = event.data;
      resolve({ success, status, data, error });
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve({ success: false, error: 'Timed out waiting for page fetch' });
    }, timeoutMs);
    window.addEventListener('message', onMsg);
    window.postMessage({ type: 'SHOPEE_TRACKER_FETCH', reqId, path, method, body }, window.location.origin);
  });
}

// Requests from the extension (sync tab fallback)
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING_SHOPEE_TAB') {
      sendResponse({ active: true });
      return false;
    }
    if (msg?.type === 'FETCH_ORDERS_FROM_TAB') {
      const offset = Number(msg.offset) || 0;
      const limit = Number(msg.limit) || 10;
      fetchViaPage(`/api/v4/order/get_all_order_and_checkout_list?limit=${limit}&offset=${offset}`).then(sendResponse);
      return true;
    }
    if (msg?.type === 'FETCH_ORDER_DETAIL_FROM_TAB') {
      const orderId = String(msg.orderId || '').replace(/\D/g, '');
      fetchViaPage(`/api/v4/order/get_order_detail?order_id=${orderId}`).then(sendResponse);
      return true;
    }
    if (msg?.type === 'FETCH_CART_FROM_TAB') {
      fetchViaPage('/api/v4/cart/get', 20000, 'POST', { pre_selected_item_list: [], version: 3 }).then(sendResponse);
      return true;
    }
    if (msg?.type === 'CART_PRICE_UPDATED' && isCartPage()) {
      refreshCartPriceDrawer();
      return false;
    }
    return false;
  });
} catch {}

// Listen for intercepted network responses from MAIN world
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === 'SHOPEE_TRACKER_CART_DATA') {
    safeSendMessage({
      type: 'INTERCEPTED_CART_DATA',
      data: event.data.data,
    });
    if (isCartPage()) {
      setTimeout(() => refreshCartPriceDrawer(), 400);
    }
    return;
  }

  if (event.data.type === 'SHOPEE_TRACKER_INTERCEPTED_DATA') {
    const json = event.data.data;
    console.log('[ShopeeTracker:ISOLATED] Processing intercepted order batch:', json);

    // Relay to background service worker and dashboard
    safeSendMessage({
      type: 'INTERCEPTED_SHOPEE_DATA',
      data: json,
    });

    // Count orders in payload
    let count = 0;
    if (json.new_data && Array.isArray(json.new_data.order_or_checkout_data)) {
      count = json.new_data.order_or_checkout_data.filter((e: any) => e?.order_list_detail).length;
    } else if (json.data) {
      if (Array.isArray(json.data.order_list)) count = json.data.order_list.length;
      else if (Array.isArray(json.data.orders)) count = json.data.orders.length;
      else if (Array.isArray(json.data.order_list_cards)) count = json.data.order_list_cards.length;
      else if (Array.isArray(json.data.details_list)) count = json.data.details_list.length;
      else if (json.data.orders_data && Array.isArray(json.data.orders_data.order_list)) {
        count = json.data.orders_data.order_list.length;
      }
    }

    if (count > 0) {
      totalCapturedOrders += count;
      updateWidgetUI();
    }
  }
});

// Auto-Paginator: Locates Shopee's Next Page button and clicks it politely
function findNextPageButton(): HTMLButtonElement | HTMLElement | null {
  // Strategy 1: Shopee icon button right
  const rightIconBtn = document.querySelector<HTMLButtonElement>('.shopee-icon-button--right');
  if (rightIconBtn && !rightIconBtn.disabled && !rightIconBtn.getAttribute('aria-disabled')) {
    return rightIconBtn;
  }

  // Strategy 2: In pagination container, find next arrow button
  const pagination = document.querySelector('.shopee-page-controller');
  if (pagination) {
    const buttons = Array.from(pagination.querySelectorAll('button'));
    const nextBtn = buttons[buttons.length - 1];
    if (nextBtn && !nextBtn.disabled && !nextBtn.getAttribute('aria-disabled')) {
      return nextBtn;
    }
  }

  // Strategy 3: Any button containing svg with arrow or aria-label="Next"
  const allButtons = Array.from(document.querySelectorAll('button'));
  for (const b of allButtons) {
    const label = (b.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('next') && !b.disabled) {
      return b;
    }
  }

  return null;
}

function startAutoSync() {
  if (isAutoSyncing) return;
  isAutoSyncing = true;
  updateWidgetUI();

  // Shopee's "All" list is infinite-scroll; status tabs may still have page buttons.
  // Keep going while either new orders are captured or the page grows; stop after a quiet spell.
  const MAX_IDLE_TICKS = 6; // ~10s without progress
  let idleTicks = 0;
  let lastCount = totalCapturedOrders;
  let lastHeight = document.body.scrollHeight;

  const tick = () => {
    if (!isAutoSyncing) return;

    // Always scroll (loads the infinite list); also click a page button if one exists
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    const nextBtn = findNextPageButton();
    if (nextBtn) {
      console.log('[ShopeeTracker:ISOLATED] Auto-clicking Next Page button...');
      nextBtn.click();
    }

    const height = document.body.scrollHeight;
    if (totalCapturedOrders > lastCount || height > lastHeight) {
      idleTicks = 0;
      lastCount = totalCapturedOrders;
      lastHeight = height;
    } else {
      idleTicks++;
      console.log(`[ShopeeTracker:ISOLATED] No new orders yet (${idleTicks}/${MAX_IDLE_TICKS})...`);
    }

    if (idleTicks >= MAX_IDLE_TICKS) {
      stopAutoSync();
      const statusEl = document.getElementById('shopee-tracker-status');
      if (statusEl) {
        statusEl.textContent = `Reached the end. ${totalCapturedOrders} orders captured.`;
        statusEl.style.color = '#10b981';
      }
      return;
    }

    // ~1.5-2s, human-like pace
    autoSyncInterval = setTimeout(tick, 1500 + Math.floor(Math.random() * 500));
  };

  autoSyncInterval = setTimeout(tick, 300);
}

function stopAutoSync() {
  isAutoSyncing = false;
  if (autoSyncInterval) {
    clearTimeout(autoSyncInterval);
    autoSyncInterval = null;
  }
  updateWidgetUI();
}

// Injected Floating Controller Widget on Shopee pages
function injectWidget() {
  if (document.getElementById('shopee-tracker-widget-container')) return;

  const container = document.createElement('div');
  container.id = 'shopee-tracker-widget-container';
  container.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  `;

  container.innerHTML = `
    <div id="shopee-tracker-card" style="
      display: none;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      width: 290px;
      overflow: hidden;
      transition: all 0.2s ease;
    ">
      <!-- Header -->
      <div style="
        background: #ee4d2d;
        color: white;
        padding: 12px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"></path>
            <path d="M3 6h18"></path>
            <path d="M16 10a4 4 0 0 1-8 0"></path>
          </svg>
          <span style="font-weight: 700; font-size: 13px;">Spend Tracker</span>
        </div>
        <button id="shopee-tracker-minimize-btn" style="
          background: rgba(255,255,255,0.2);
          border: none;
          color: white;
          border-radius: 6px;
          padding: 2px 6px;
          cursor: pointer;
          font-size: 11px;
        ">Hide</button>
      </div>

      <!-- Body -->
      <div id="shopee-tracker-body" style="padding: 14px;">
        <div style="
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          padding: 10px;
          margin-bottom: 12px;
          text-align: center;
        ">
          <div style="font-size: 10px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Orders Captured</div>
          <div id="shopee-tracker-counter" style="font-size: 24px; font-weight: 800; color: #ee4d2d; margin-top: 2px;">
            ${totalCapturedOrders}
          </div>
          <div id="shopee-tracker-status" style="font-size: 11px; color: #64748b; margin-top: 4px;">
            Interceptor Active & Listening
          </div>
        </div>

        <!-- Buttons -->
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button id="shopee-tracker-sync-btn" style="
            width: 100%;
            background: #ee4d2d;
            color: white;
            border: none;
            padding: 9px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: opacity 0.2s;
          ">
            <span>▶ Start Auto-Sync All Pages</span>
          </button>

          <button id="shopee-tracker-dashboard-btn" style="
            width: 100%;
            background: #ffffff;
            color: #334155;
            border: 1px solid #cbd5e1;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          ">
            <span>📊 Open Spend Dashboard</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Collapsed Pill (shown by default) -->
    <button id="shopee-tracker-pill" style="
      display: flex;
      background: #ee4d2d;
      color: white;
      border: none;
      border-radius: 9999px;
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 4px 14px rgba(238, 77, 45, 0.4);
      cursor: pointer;
      align-items: center;
      gap: 6px;
    ">
      <span>🛒 Spend Tracker (${totalCapturedOrders})</span>
    </button>
  `;

  document.body.appendChild(container);

  // Bind Events
  const syncBtn = document.getElementById('shopee-tracker-sync-btn');
  const dashBtn = document.getElementById('shopee-tracker-dashboard-btn');
  const minimizeBtn = document.getElementById('shopee-tracker-minimize-btn');
  const pillBtn = document.getElementById('shopee-tracker-pill');
  const card = document.getElementById('shopee-tracker-card');

  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      if (isAutoSyncing) {
        stopAutoSync();
      } else {
        startAutoSync();
      }
    });
  }

  if (dashBtn) {
    dashBtn.addEventListener('click', () => {
      safeSendMessage({ type: 'OPEN_DASHBOARD' });
    });
  }

  if (minimizeBtn && card && pillBtn) {
    minimizeBtn.addEventListener('click', () => {
      card.style.display = 'none';
      pillBtn.style.display = 'flex';
    });
    pillBtn.addEventListener('click', () => {
      card.style.display = 'block';
      pillBtn.style.display = 'none';
    });
  }
}

function updateWidgetUI() {
  const counter = document.getElementById('shopee-tracker-counter');
  const statusEl = document.getElementById('shopee-tracker-status');
  const syncBtn = document.getElementById('shopee-tracker-sync-btn');
  const pillBtn = document.getElementById('shopee-tracker-pill');

  if (counter) counter.textContent = String(totalCapturedOrders);
  if (pillBtn) pillBtn.textContent = `🛒 Spend Tracker (${totalCapturedOrders})`;

  if (syncBtn && statusEl) {
    if (isAutoSyncing) {
      syncBtn.style.background = '#e11d48';
      syncBtn.innerHTML = '<span>⏹ Stop Auto-Sync</span>';
      statusEl.textContent = 'Auto-paging through purchase history...';
      statusEl.style.color = '#ee4d2d';
    } else {
      syncBtn.style.background = '#ee4d2d';
      syncBtn.innerHTML = '<span>▶ Start Auto-Sync All Pages</span>';
      statusEl.textContent = 'Interceptor Active & Listening';
      statusEl.style.color = '#64748b';
    }
  }
}

function isPurchasePage(): boolean {
  return window.location.pathname.startsWith('/user/purchase');
}

function isCartPage(): boolean {
  return window.location.pathname.startsWith('/cart');
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSparklineSvg(history: Array<{ date: string; price: number }>): string {
  const width = 260;
  const height = 56;
  const padX = 6;
  const padY = 8;

  if (!history.length) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`;
  }

  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;

  const coords = history.map((pt, i) => {
    const x =
      history.length === 1
        ? width / 2
        : padX + (i / (history.length - 1)) * (width - padX * 2);
    const y =
      max === min
        ? height / 2
        : padY + (1 - (pt.price - min) / span) * (height - padY * 2);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ...pt };
  });

  const pointsAttr = coords.map((c) => `${c.x},${c.y}`).join(' ');
  const areaAttr = `${coords[0].x},${height - 2} ${pointsAttr} ${coords[coords.length - 1].x},${height - 2}`;

  const dots = coords
    .map(
      (c) =>
        `<circle cx="${c.x}" cy="${c.y}" r="3" fill="#ee4d2d" stroke="#ffffff" stroke-width="1.2"><title>${escapeHtml(c.date)}: RM ${c.price.toFixed(2)}</title></circle>`
    )
    .join('');

  return `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow: visible; display: block;">
      <polygon points="${areaAttr}" fill="rgba(238, 77, 45, 0.12)" />
      ${coords.length > 1 ? `<polyline fill="none" stroke="#ee4d2d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pointsAttr}" />` : ''}
      ${dots}
    </svg>
  `;
}

function injectCartWidget() {
  if (document.getElementById('shopee-cart-tracker-container')) return;

  const container = document.createElement('div');
  container.id = 'shopee-cart-tracker-container';
  container.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  `;

  container.innerHTML = `
    <div id="shopee-cart-drawer" style="
      display: none;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      box-shadow: 0 20px 35px -10px rgba(0, 0, 0, 0.18);
      width: 340px;
      max-height: 75vh;
      flex-direction: column;
      overflow: hidden;
    ">
      <div style="
        background: #ee4d2d;
        color: white;
        padding: 12px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div style="font-weight: 700; font-size: 13px;">📈 Cart Price History</div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button id="shopee-cart-refresh-btn" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            border-radius: 6px;
            padding: 3px 8px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
          ">Log Today</button>
          <button id="shopee-cart-close-btn" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            border-radius: 6px;
            padding: 3px 8px;
            cursor: pointer;
            font-size: 11px;
          ">Hide</button>
        </div>
      </div>
      <div id="shopee-cart-list" style="
        padding: 12px;
        overflow-y: auto;
        max-height: calc(75vh - 96px);
        display: flex;
        flex-direction: column;
        gap: 10px;
        background: #f8fafc;
      ">
        <div style="font-size: 12px; color: #64748b; text-align: center; padding: 16px;">Loading cart price history...</div>
      </div>
      <div style="
        padding: 8px 12px;
        background: #ffffff;
        border-top: 1px solid #e2e8f0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        color: #64748b;
      ">
        <span id="shopee-cart-last-checked">Checked: —</span>
        <button id="shopee-cart-open-dash" style="
          background: none;
          border: none;
          color: #ee4d2d;
          font-weight: 600;
          cursor: pointer;
          font-size: 11px;
        ">Open Dashboard →</button>
      </div>
    </div>

    <button id="shopee-cart-pill" style="
      display: flex;
      background: #ee4d2d;
      color: white;
      border: none;
      border-radius: 9999px;
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 700;
      box-shadow: 0 4px 14px rgba(238, 77, 45, 0.4);
      cursor: pointer;
      align-items: center;
      gap: 6px;
    ">
      <span>📈 Price History</span>
    </button>
  `;

  document.body.appendChild(container);

  const drawer = document.getElementById('shopee-cart-drawer')!;
  const pill = document.getElementById('shopee-cart-pill')!;
  const closeBtn = document.getElementById('shopee-cart-close-btn')!;
  const refreshBtn = document.getElementById('shopee-cart-refresh-btn')!;
  const dashBtn = document.getElementById('shopee-cart-open-dash')!;

  pill.addEventListener('click', () => {
    drawer.style.display = 'flex';
    pill.style.display = 'none';
    refreshCartPriceDrawer();
  });

  closeBtn.addEventListener('click', () => {
    drawer.style.display = 'none';
    pill.style.display = 'flex';
  });

  refreshBtn.addEventListener('click', () => {
    refreshBtn.textContent = 'Logging...';
    chrome.runtime.sendMessage({ type: 'CHECK_CART_NOW' }, () => {
      refreshBtn.textContent = 'Log Today';
      refreshCartPriceDrawer();
    });
  });

  dashBtn.addEventListener('click', () => {
    safeSendMessage({ type: 'OPEN_DASHBOARD' });
  });

  refreshCartPriceDrawer();
}

function refreshCartPriceDrawer() {
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: 'GET_CART_PRICE_HISTORY' }, (res) => {
    const listEl = document.getElementById('shopee-cart-list');
    const pillEl = document.getElementById('shopee-cart-pill');
    const lastEl = document.getElementById('shopee-cart-last-checked');
    if (!listEl) return;

    const items: any[] = (res?.items || []).filter((i: any) => i.inCart);
    if (pillEl) {
      pillEl.textContent = items.length ? `📈 Price History (${items.length})` : '📈 Price History';
    }
    if (lastEl && res?.lastCheckedAt) {
      lastEl.textContent = `Logged: ${new Date(res.lastCheckedAt).toLocaleDateString('en-MY', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    }

    if (!items.length) {
      listEl.innerHTML = `<div style="font-size: 12px; color: #64748b; text-align: center; padding: 16px;">No cart items logged yet. Click "Log Today" or scroll your cart.</div>`;
      return;
    }

    listEl.innerHTML = items
      .map((item) => {
        const hist = item.history || [];
        const firstDate = hist[0]?.date || '';
        const lastDate = hist[hist.length - 1]?.date || '';
        const diff = item.lowestPrice < item.currentPrice
          ? `+RM ${(item.currentPrice - item.lowestPrice).toFixed(2)} vs low`
          : hist.length > 1
            ? 'At lowest!'
            : 'Day 1 logged';
        const diffColor = item.lowestPrice < item.currentPrice ? '#d97706' : '#059669';

        return `
          <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px;">
            <div style="display: flex; justify-content: space-between; gap: 8px; align-items: flex-start;">
              <div style="display: flex; gap: 8px; align-items: center; min-width: 0; flex: 1;">
                ${
                  item.imageUrl
                    ? `<img src="${escapeHtml(item.imageUrl)}" alt="" style="width: 36px; height: 36px; border-radius: 8px; object-fit: cover; border: 1px solid #e2e8f0; flex-shrink: 0; background: #f1f5f9;" onerror="this.style.display='none'" />`
                    : ''
                }
                <div style="min-width: 0;">
                  <div style="font-size: 12px; font-weight: 600; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                  ${item.modelName ? `<div style="font-size: 10px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(item.modelName)}</div>` : ''}
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <div style="font-size: 13px; font-weight: 800; color: #ee4d2d;">RM ${Number(item.currentPrice).toFixed(2)}</div>
                <div style="font-size: 10px; font-weight: 600; color: ${diffColor};">${diff}</div>
              </div>
            </div>
            <div style="margin-top: 8px; background: #fff7ed; border-radius: 8px; padding: 6px 8px;">
              ${buildSparklineSvg(hist)}
              <div style="display: flex; justify-content: space-between; font-size: 9px; color: #64748b; margin-top: 2px;">
                <span>${escapeHtml(firstDate)}</span>
                <span>Low: RM ${Number(item.lowestPrice).toFixed(2)} • High: RM ${Number(item.highestPrice).toFixed(2)}</span>
                <span>${escapeHtml(lastDate)}</span>
              </div>
            </div>
            ${item.lastPaidPrice ? `<div style="margin-top: 5px; font-size: 10px; color: #475569;">Last paid: <strong>RM ${Number(item.lastPaidPrice).toFixed(2)}</strong></div>` : ''}
          </div>
        `;
      })
      .join('');
  });
}

function syncWidgetVisibility() {
  const existingPurchase = document.getElementById('shopee-tracker-widget-container');
  if (isPurchasePage()) {
    if (!existingPurchase && document.body) {
      injectWidget();
    } else if (existingPurchase) {
      existingPurchase.style.display = '';
    }
  } else {
    if (isAutoSyncing) stopAutoSync();
    if (existingPurchase) {
      existingPurchase.style.display = 'none';
    }
  }

  const existingCart = document.getElementById('shopee-cart-tracker-container');
  if (isCartPage()) {
    if (!existingCart && document.body) {
      injectCartWidget();
    } else if (existingCart) {
      existingCart.style.display = '';
      refreshCartPriceDrawer();
    }
  } else if (existingCart) {
    existingCart.style.display = 'none';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncWidgetVisibility);
} else {
  syncWidgetVisibility();
}

// Shopee is an SPA; watch for route changes so the widget appears/hides on /user/purchase
let lastHref = window.location.href;
window.addEventListener('popstate', syncWidgetVisibility);
window.addEventListener('hashchange', syncWidgetVisibility);
setInterval(() => {
  if (window.location.href !== lastHref) {
    lastHref = window.location.href;
    syncWidgetVisibility();
  }
}, 1000);

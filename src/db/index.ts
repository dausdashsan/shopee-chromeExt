import Dexie, { type Table } from 'dexie';
import {
  type NormalizedOrder,
  type WatchedCartItem,
  type PriceSnapshot,
  type CartItemWithHistory,
  decodeOrderTimeMs,
  formatOrderDate,
} from '../types/shopee';

export function getLocalDateString(ms: number = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class ShopeeDatabase extends Dexie {
  orders!: Table<NormalizedOrder, string>;
  cartItems!: Table<WatchedCartItem, string>;
  priceSnapshots!: Table<PriceSnapshot, string>;

  constructor() {
    super('ShopeePurchaseTrackerDB');
    this.version(1).stores({
      orders: 'orderId, orderSn, createdAt, status, isCompleted, isCancelled, isRefunded, totalPrice, shopName'
    });
    // v2 (2026-11-12): repair records saved while Shopee's new list format was mis-parsed
    this.version(2)
      .stores({
        orders: 'orderId, orderSn, createdAt, status, isCompleted, isCancelled, isRefunded, totalPrice, shopName'
      })
      .upgrade(async (tx) => {
        const table = tx.table<NormalizedOrder, string>('orders');
        // Records keyed by a Math.random() fallback ID are duplicates of real orders: drop them
        await table.filter((o) => !/^\d+$/.test(String(o.orderId))).delete();
        // Re-date the rest: decode from the order ID, else tracking time, else unknown
        await table.toCollection().modify((o) => {
          const decoded = decodeOrderTimeMs(o.orderId);
          if (decoded !== null) {
            o.createdAt = decoded;
            o.dateIsApproximate = false;
          } else if (o.dateIsApproximate) {
            const ctime = Number(o.rawPayload?.shipping?.tracking_info?.ctime) || 0;
            o.createdAt = ctime * 1000;
          } else {
            return;
          }
          o.createdAtFormatted = formatOrderDate(o.createdAt);
        });
      });
    // v3: strip unused rawPayload blobs to keep IndexedDB compact and fast
    this.version(3)
      .stores({
        orders: 'orderId, orderSn, createdAt, status, isCompleted, isCancelled, isRefunded, totalPrice, shopName'
      })
      .upgrade(async (tx) => {
        await tx
          .table<NormalizedOrder, string>('orders')
          .toCollection()
          .modify((o) => {
            if ('rawPayload' in o) {
              delete o.rawPayload;
            }
          });
      });

    // v4: daily cart price monitoring
    this.version(4).stores({
      orders: 'orderId, orderSn, createdAt, status, isCompleted, isCancelled, isRefunded, totalPrice, shopName',
      cartItems: 'key, itemId, inCart, lastCheckedAt',
      priceSnapshots: 'id, itemKey, itemId, date, recordedAt',
    });
  }

  async upsertOrders(orders: NormalizedOrder[]): Promise<number> {
    if (!orders.length) return 0;
    await this.orders.bulkPut(orders);
    return orders.length;
  }

  async getByIds(orderIds: string[]): Promise<(NormalizedOrder | undefined)[]> {
    return this.orders.bulkGet(orderIds);
  }

  async getAllOrders(): Promise<NormalizedOrder[]> {
    return this.orders.orderBy('createdAt').reverse().toArray();
  }

  async getSummaryStats() {
    const orders = await this.orders.toArray();
    let totalSpent = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let refundedCount = 0;
    let totalItems = 0;

    for (const order of orders) {
      if (order.isCompleted) {
        totalSpent += order.totalPrice;
        completedCount++;
        totalItems += order.itemCount;
      } else if (order.isCancelled) {
        cancelledCount++;
      } else if (order.isRefunded) {
        refundedCount++;
      }
    }

    const averageOrderValue = completedCount > 0 ? totalSpent / completedCount : 0;

    return {
      totalSpent: Math.round(totalSpent * 100) / 100,
      totalOrders: orders.length,
      completedCount,
      cancelledCount,
      refundedCount,
      totalItems,
      averageOrderValue: Math.round(averageOrderValue * 100) / 100,
    };
  }

  async getYearOptions(): Promise<number[]> {
    const orders = await this.orders.toArray();
    const years = new Set<number>();
    for (const order of orders) {
      if (order.createdAt) {
        const year = new Date(order.createdAt).getFullYear();
        if (!isNaN(year) && order.createdAt > 0) years.add(year);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }

  async clearAll(): Promise<void> {
    await this.orders.clear();
  }

  async recordCartSnapshot(
    items: Array<{
      itemId: string;
      modelId: string;
      shopId?: string;
      shopName: string;
      name: string;
      modelName: string;
      imageUrl?: string;
      price: number;
      originalPrice?: number;
    }>,
    now: number = Date.now()
  ): Promise<number> {
    if (!items.length) return 0;
    const today = getLocalDateString(now);

    await this.transaction('rw', this.cartItems, this.priceSnapshots, async () => {
      const existingAll = await this.cartItems.toArray();
      const existingMap = new Map(existingAll.map((c) => [c.key, c]));
      const activeKeys = new Set<string>();

      const toPutItems: WatchedCartItem[] = [];
      const toPutSnapshots: PriceSnapshot[] = [];

      for (const item of items) {
        const key = `${item.itemId}_${item.modelId || '0'}`;
        activeKeys.add(key);
        const prev = existingMap.get(key);
        const lowestPrice = prev ? Math.min(prev.lowestPrice, item.price) : item.price;
        const highestPrice = prev ? Math.max(prev.highestPrice, item.price) : item.price;

        toPutItems.push({
          key,
          itemId: item.itemId,
          modelId: item.modelId || '0',
          shopId: item.shopId ?? prev?.shopId,
          shopName: item.shopName || prev?.shopName || 'Shopee Seller',
          name: item.name || prev?.name || 'Shopee Product',
          modelName: item.modelName ?? prev?.modelName ?? '',
          imageUrl: item.imageUrl ?? prev?.imageUrl,
          currentPrice: item.price,
          originalPrice: item.originalPrice,
          lowestPrice,
          highestPrice,
          lastCheckedAt: now,
          inCart: true,
        });

        toPutSnapshots.push({
          id: `${key}_${today}`,
          itemKey: key,
          itemId: item.itemId,
          modelId: item.modelId || '0',
          date: today,
          price: item.price,
          originalPrice: item.originalPrice,
          recordedAt: now,
        });
      }

      // Mark items no longer in cart as inCart = false (keep their price history)
      for (const prev of existingAll) {
        if (prev.inCart && !activeKeys.has(prev.key)) {
          toPutItems.push({ ...prev, inCart: false });
        }
      }

      await this.cartItems.bulkPut(toPutItems);
      await this.priceSnapshots.bulkPut(toPutSnapshots);
    });

    return items.length;
  }

  async getCartItemsWithHistory(): Promise<CartItemWithHistory[]> {
    const [items, snapshots, orders] = await Promise.all([
      this.cartItems.toArray(),
      this.priceSnapshots.orderBy('date').toArray(),
      this.orders.orderBy('createdAt').reverse().toArray(),
    ]);

    const historyByKey = new Map<string, PriceSnapshot[]>();
    for (const snap of snapshots) {
      const list = historyByKey.get(snap.itemKey);
      if (list) list.push(snap);
      else historyByKey.set(snap.itemKey, [snap]);
    }

    // Build lookup of last paid price per itemId from completed orders
    const lastPaidByItemId = new Map<string, { price: number; date: string }>();
    for (const order of orders) {
      if (!order.isCompleted) continue;
      for (const it of order.items) {
        if (!lastPaidByItemId.has(it.itemId) && it.unitPrice > 0) {
          lastPaidByItemId.set(it.itemId, {
            price: it.unitPrice,
            date: order.createdAtFormatted,
          });
        }
      }
    }

    return items
      .map((item) => {
        const lastPaid = lastPaidByItemId.get(item.itemId);
        return {
          ...item,
          history: historyByKey.get(item.key) || [],
          lastPaidPrice: lastPaid?.price,
          lastPaidDate: lastPaid?.date,
        };
      })
      .sort((a, b) => {
        if (a.inCart !== b.inCart) return a.inCart ? -1 : 1;
        return b.lastCheckedAt - a.lastCheckedAt;
      });
  }

  async clearCartHistory(): Promise<void> {
    await this.transaction('rw', this.cartItems, this.priceSnapshots, async () => {
      await this.cartItems.clear();
      await this.priceSnapshots.clear();
    });
  }
}

export const db = new ShopeeDatabase();

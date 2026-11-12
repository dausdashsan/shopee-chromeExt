import Dexie, { type Table } from 'dexie';
import { type NormalizedOrder, decodeOrderTimeMs, formatOrderDate } from '../types/shopee';

export class ShopeeDatabase extends Dexie {
  orders!: Table<NormalizedOrder, string>;

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
}

export const db = new ShopeeDatabase();

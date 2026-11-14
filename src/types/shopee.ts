export interface RawShopeeItem {
  item_id?: number | string;
  model_id?: number | string;
  name?: string;
  item_name?: string;
  amount?: number;
  item_price?: number;
  price?: number;
  image?: string;
  item_image?: string;
  model_name?: string;
}

export interface RawShopeeShop {
  shop_id?: number | string;
  shop_name?: string;
  username?: string;
}

export interface RawShopeeOrder {
  order_id?: number | string;
  order_sn?: string;
  status?: number | string;
  status_label?: string;
  status_description?: string;
  final_total?: number;
  total_price?: number;
  paid_amount?: number;
  create_time?: number;
  paid_time?: number;
  complete_time?: number;
  shipping_carrier?: string;
  shipping_fee?: number;
  coin_used?: number;
  voucher_price?: number;
  item_list?: RawShopeeItem[];
  items?: RawShopeeItem[];
  shop_info?: RawShopeeShop;
  [key: string]: any;
}

export interface RawShopeeApiResponse {
  error?: number;
  error_msg?: string;
  data?: {
    next_offset?: number;
    has_more?: boolean;
    orders_data?: {
      order_list?: RawShopeeOrder[];
      total_count?: number;
    } | RawShopeeOrder[];
    order_list?: RawShopeeOrder[];
    orders?: RawShopeeOrder[];
  };
  /** Format used by get_all_order_and_checkout_list since late 2026. */
  new_data?: {
    order_or_checkout_data?: Array<{ order_list_detail?: any; [key: string]: any }>;
    next_offset?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface NormalizedItem {
  itemId: string;
  name: string;
  modelName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  imageUrl?: string;
}

export interface NormalizedOrder {
  orderId: string;
  orderSn: string;
  createdAt: number; // ms
  createdAtFormatted: string;
  /** True when createdAt is the last tracking update, not the order time (the list API no longer returns it). */
  dateIsApproximate?: boolean;
  status: string; // e.g. "Completed", "Cancelled", "To Receive", etc.
  statusRaw: number | string;
  isCompleted: boolean;
  isCancelled: boolean;
  isRefunded: boolean;
  totalPrice: number; // in MYR, e.g. 45.50
  shippingFee: number;
  shopName: string;
  shopId?: string;
  itemCount: number;
  items: NormalizedItem[];
  rawPayload?: any;
}

export interface FetchProgress {
  currentOffset: number;
  totalFetched: number;
  isFinished: boolean;
  isError: boolean;
  errorMessage?: string;
  currentOrderSn?: string;
}

export interface WatchedCartItem {
  key: string; // `${itemId}_${modelId || '0'}`
  itemId: string;
  modelId: string;
  shopId?: string;
  shopName: string;
  name: string;
  modelName: string;
  imageUrl?: string;
  currentPrice: number;
  originalPrice?: number;
  lowestPrice: number;
  highestPrice: number;
  lastCheckedAt: number; // ms
  inCart: boolean;
}

export interface PriceSnapshot {
  id: string; // `${itemKey}_${date}`
  itemKey: string;
  itemId: string;
  modelId: string;
  date: string; // YYYY-MM-DD (local)
  price: number;
  originalPrice?: number;
  recordedAt: number; // ms
}

export interface CartItemWithHistory extends WatchedCartItem {
  history: PriceSnapshot[];
  lastPaidPrice?: number;
  lastPaidDate?: string;
}

/**
 * Normalizes Shopee monetary values.
 * Shopee's internal APIs typically use 100,000 micro-units for MYR (e.g., 2500000 = RM 25.00).
 */
export function normalizeShopeeAmount(val: number | string | undefined | null): number {
  if (val === undefined || val === null) return 0;
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return 0;

  // Shopee micro-units: 100,000 micro-units = RM 1.00 (1 sen = 1,000 micro-units).
  // Integers >= 1000 are micro-units; fractional values are assumed to already be in MYR.
  if (Number.isInteger(num) && Math.abs(num) >= 1000) {
    return Math.round((num / 100000) * 100) / 100;
  }
  return Math.round(num * 100) / 100;
}

/**
 * Shopee order IDs issued since 2019 encode their creation time:
 * order_id = (unix_seconds - 1546300800) * 1e6 + sequence   (1546300800 = 2019-01-01T00:00:00Z)
 * Checked against get_order_detail's order time on 2026-11-12 (within 3s). Older IDs are small
 * sequential numbers and return null.
 */
const SHOPEE_ORDER_ID_EPOCH = 1546300800;
export function decodeOrderTimeMs(orderId: string | number): number | null {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id < 1e12) return null;
  const seconds = Math.floor(id / 1e6) + SHOPEE_ORDER_ID_EPOCH;
  if (seconds > Date.now() / 1000 + 86400) return null;
  return seconds * 1000;
}

export function formatOrderDate(ms: number): string {
  if (!ms) return 'Unknown date';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-MY', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

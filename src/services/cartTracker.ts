import { normalizeShopeeAmount } from '../types/shopee';

export interface ParsedCartItem {
  itemId: string;
  modelId: string;
  shopId?: string;
  shopName: string;
  name: string;
  modelName: string;
  imageUrl?: string;
  price: number;
  originalPrice?: number;
}

/**
 * Extracts cart items from Shopee's /api/v4/cart/get (or v2) response.
 */
export function extractCartItemsFromPayload(json: any): ParsedCartItem[] {
  if (!json || typeof json !== 'object') return [];
  if (json.error !== undefined && json.error !== 0) return [];

  const data = json.data || json;
  const shopOrders: any[] = Array.isArray(data?.shop_orders) ? data.shop_orders : [];
  const results: ParsedCartItem[] = [];
  const seen = new Set<string>();

  const pushItem = (raw: any, shop: any) => {
    if (!raw || typeof raw !== 'object') return;
    const rawItemId = raw.itemid ?? raw.item_id ?? raw.id;
    if (rawItemId === undefined || rawItemId === null || rawItemId === '') return;

    const itemId = String(rawItemId);
    const modelId = String(raw.modelid ?? raw.model_id ?? '0');
    const key = `${itemId}_${modelId}`;
    if (seen.has(key)) return;

    const price = normalizeShopeeAmount(
      raw.price ?? raw.item_price ?? raw.price_before_discount ?? 0
    );
    if (price <= 0) return;

    const origRaw = raw.price_before_discount ?? raw.original_price;
    const originalPrice = origRaw ? normalizeShopeeAmount(origRaw) : undefined;

    let imageUrl: string | undefined =
      raw.image ||
      raw.model_image ||
      raw.item_image ||
      (Array.isArray(raw.images) ? raw.images[0] : undefined);
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = `https://down-my.img.susercontent.com/file/${imageUrl}`;
    }

    const shopId = shop?.shopid ?? shop?.shop_id ?? raw.shopid ?? raw.shop_id;
    const shopName =
      shop?.shop_name ||
      shop?.username ||
      raw.shop_name ||
      'Shopee Seller';

    results.push({
      itemId,
      modelId,
      shopId: shopId ? String(shopId) : undefined,
      shopName,
      name: raw.name || raw.item_name || 'Shopee Product',
      modelName: raw.model_name || raw.variation || '',
      imageUrl,
      price,
      originalPrice: originalPrice && originalPrice > price ? originalPrice : undefined,
    });
    seen.add(key);
  };

  for (const shopOrder of shopOrders) {
    const shop = shopOrder?.shop || shopOrder?.shop_info || shopOrder;
    if (Array.isArray(shopOrder?.items)) {
      for (const it of shopOrder.items) pushItem(it, shop);
    }
    if (Array.isArray(shopOrder?.item_groups)) {
      for (const group of shopOrder.item_groups) {
        if (Array.isArray(group?.items)) {
          for (const it of group.items) pushItem(it, shop);
        }
      }
    }
  }

  // Fallback for flat items arrays if Shopee uses another shape
  if (results.length === 0 && Array.isArray(data?.items)) {
    for (const it of data.items) pushItem(it, it?.shop_info);
  }

  return results;
}

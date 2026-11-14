import { db } from '../db';
import type { NormalizedOrder, WatchedCartItem, PriceSnapshot } from '../types/shopee';

const DEFAULT_API_URL = (import.meta as any).env?.VITE_SYNC_API_URL || 'https://note.spekitam.my';
const DEFAULT_SYNC_TOKEN = (import.meta as any).env?.VITE_SYNC_TOKEN || '';

export interface CloudSyncPayload {
  version: number;
  syncedAt: number;
  orders: NormalizedOrder[];
  cartItems: WatchedCartItem[];
  priceSnapshots: PriceSnapshot[];
}

export interface CloudSyncResult {
  success: boolean;
  channel?: string;
  pulled?: { orders: number; cartItems: number; priceSnapshots: number };
  pushed?: { orders: number; cartItems: number; priceSnapshots: number };
  syncedAt?: number;
  expiresAt?: number;
  error?: string;
}

async function getShopeeUserId(): Promise<string | null> {
  const cookie = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'SPC_U' }).catch(() => null);
  const raw = cookie?.value?.trim();
  if (raw && /^[A-Za-z0-9_-]{1,50}$/.test(raw)) {
    await chrome.storage.local.set({ lastShopeeUserId: raw }).catch(() => {});
    return raw;
  }
  const stored = await chrome.storage.local.get(['lastShopeeUserId']).catch(() => ({} as Record<string, any>));
  return stored?.lastShopeeUserId || null;
}

async function getSyncConfig(): Promise<{ apiUrl: string; token: string }> {
  const stored = await chrome.storage.local
    .get(['cloudSyncApiUrl', 'cloudSyncToken'])
    .catch(() => ({} as Record<string, any>));
  const apiUrl = String(stored?.cloudSyncApiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const token = String(stored?.cloudSyncToken || DEFAULT_SYNC_TOKEN);
  return { apiUrl, token };
}

export async function syncWithCloud(): Promise<CloudSyncResult> {
  const { apiUrl, token } = await getSyncConfig();
  if (!token) {
    return { success: false, error: 'Missing VITE_SYNC_TOKEN configuration.' };
  }

  const userId = await getShopeeUserId();
  if (!userId) {
    return { success: false, error: 'Shopee user ID (SPC_U cookie) not found. Please log in to Shopee MY first.' };
  }

  const channel = `shopee-${userId}`;
  const endpoint = `${apiUrl}/api/sync/${encodeURIComponent(channel)}`;
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Pull remote state
    const getRes = await fetch(endpoint, { method: 'GET', headers: authHeaders });
    if (!getRes.ok) {
      const errBody = await getRes.json().catch(() => ({}));
      return { success: false, error: errBody.error || `Cloud pull failed (${getRes.status})` };
    }

    const remoteJson = (await getRes.json()) as { data: CloudSyncPayload | null };
    const remote = remoteJson?.data;
    const pulled = { orders: 0, cartItems: 0, priceSnapshots: 0 };

    if (remote && typeof remote === 'object') {
      if (Array.isArray(remote.orders) && remote.orders.length > 0) {
        await db.orders.bulkPut(remote.orders);
        pulled.orders = remote.orders.length;
      }

      if (Array.isArray(remote.cartItems) && remote.cartItems.length > 0) {
        const existingItems = await db.cartItems.toArray();
        const existingByKey = new Map(existingItems.map((i) => [i.key, i]));
        const toPut: WatchedCartItem[] = [];
        for (const item of remote.cartItems) {
          const local = existingByKey.get(item.key);
          if (!local || (item.lastCheckedAt || 0) >= (local.lastCheckedAt || 0)) {
            toPut.push(item);
          }
        }
        if (toPut.length > 0) {
          await db.cartItems.bulkPut(toPut);
        }
        pulled.cartItems = toPut.length;
      }

      if (Array.isArray(remote.priceSnapshots) && remote.priceSnapshots.length > 0) {
        await db.priceSnapshots.bulkPut(remote.priceSnapshots);
        pulled.priceSnapshots = remote.priceSnapshots.length;
      }
    }

    // 2. Push merged local state back to cloud
    const [orders, cartItems, priceSnapshots] = await Promise.all([
      db.orders.toArray(),
      db.cartItems.toArray(),
      db.priceSnapshots.toArray(),
    ]);

    const syncedAt = Date.now();
    const payload: CloudSyncPayload = {
      version: 1,
      syncedAt,
      orders,
      cartItems,
      priceSnapshots,
    };

    const putRes = await fetch(endpoint, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });

    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      return { success: false, error: errBody.error || `Cloud push failed (${putRes.status})` };
    }

    const putJson = (await putRes.json()) as { ok: boolean; updatedAt?: number; expiresAt?: number };
    await chrome.storage.local.set({ lastCloudSyncAt: syncedAt }).catch(() => {});

    return {
      success: true,
      channel,
      pulled,
      pushed: {
        orders: orders.length,
        cartItems: cartItems.length,
        priceSnapshots: priceSnapshots.length,
      },
      syncedAt,
      expiresAt: putJson.expiresAt,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Network error during cloud sync.' };
  }
}

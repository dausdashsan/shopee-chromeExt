// Shopee Purchase Tracker - Background Service Worker
import { db, getLocalDateString } from '../db';
import { extractCartItemsFromPayload } from '../services/cartTracker';
import { shopeeFetcher } from '../services/shopeeFetcher';

const CART_ALARM_NAME = 'DAILY_CART_PRICE_CHECK';
const PURCHASE_ALARM_NAME = 'DAILY_PURCHASE_SYNC';

// Configure DeclarativeNetRequest rule to rewrite Origin & Referer
// This allows fetch() from the extension to look 100% like a first-party request from shopee.com.my/user/purchase
async function setupNetRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [
              {
                header: 'Origin',
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: 'https://shopee.com.my',
              },
              {
                header: 'Referer',
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: 'https://shopee.com.my/user/purchase',
              },
              {
                header: 'Sec-Fetch-Site',
                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                value: 'same-origin',
              },
            ],
          },
          condition: {
            urlFilter: '||shopee.com.my/api/',
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              chrome.declarativeNetRequest.ResourceType.OTHER,
            ],
          },
        },
      ],
    });
  } catch (err) {
    console.error('[Background] Failed to register declarativeNetRequest rules:', err);
  }
}

async function ensureCartAlarm() {
  try {
    const existing = await chrome.alarms.get(CART_ALARM_NAME);
    if (!existing) {
      // Check quietly every 4 hours; only logs once per calendar day unless price changes
      chrome.alarms.create(CART_ALARM_NAME, { periodInMinutes: 240 });
    }
  } catch (err) {
    console.error('[Background] Failed to create cart alarm:', err);
  }
}

async function fetchCartDirect(): Promise<any | null> {
  await setupNetRules();
  const spcEc = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'SPC_EC' });
  const spcU = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'SPC_U' });
  if (!spcEc?.value && !spcU?.value) return null;

  const csrfCookie = await chrome.cookies.get({ url: 'https://shopee.com.my', name: 'csrftoken' });
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-api-source': 'pc',
    'x-shopee-language': 'en',
  };
  if (csrfCookie?.value) headers['x-csrftoken'] = csrfCookie.value;

  const res = await fetch('https://shopee.com.my/api/v4/cart/get', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ pre_selected_item_list: [], version: 3 }),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || (json.error !== undefined && json.error !== 0)) return null;
  return json;
}

async function fetchCartFromOpenTab(): Promise<any | null> {
  const tabs = await chrome.tabs
    .query({ url: ['https://shopee.com.my/*', 'https://*.shopee.com.my/*'] })
    .catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (!tab.id) continue;
    const res: any = await chrome.tabs
      .sendMessage(tab.id, { type: 'FETCH_CART_FROM_TAB' })
      .catch(() => null);
    if (res?.success && res.data) {
      return res.data;
    }
  }
  return null;
}

async function runQuietCartCheck(force: boolean = false): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    const today = getLocalDateString();
    if (!force) {
      const stored = await chrome.storage.local.get(['lastCartCheckDate']);
      if (stored.lastCartCheckDate === today) {
        return { success: true, count: 0 };
      }
    }

    let payload = await fetchCartDirect().catch(() => null);
    if (!payload) {
      payload = await fetchCartFromOpenTab().catch(() => null);
    }

    if (!payload) {
      return {
        success: false,
        count: 0,
        error: 'Could not reach Shopee cart (ensure you are logged in or have a Shopee tab open).',
      };
    }

    const items = extractCartItemsFromPayload(payload);
    const count = await db.recordCartSnapshot(items);
    const now = Date.now();
    await chrome.storage.local.set({ lastCartCheckDate: today, lastCartCheckAt: now });
    chrome.runtime.sendMessage({ type: 'CART_PRICE_UPDATED', count, lastCheckedAt: now }).catch(() => {});
    return { success: true, count };
  } catch (err: any) {
    return { success: false, count: 0, error: err?.message || 'Cart check failed' };
  }
}

async function ensurePurchaseAlarm() {
  try {
    const existing = await chrome.alarms.get(PURCHASE_ALARM_NAME);
    if (!existing) {
      // Wake every 4 hours; the sync itself runs at most once per calendar day (until it succeeds)
      chrome.alarms.create(PURCHASE_ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 240 });
    }
  } catch (err) {
    console.error('[Background] Failed to create purchase alarm:', err);
  }
}

/**
 * Daily quick sync of new and unfinished purchases (same as the dashboard's "Sync New Purchases").
 * Skips when: already synced today, not logged in, or nothing saved yet (the first full sync is manual).
 * Never opens Shopee tabs; falls back only to one that is already open.
 */
async function runDailyPurchaseSync(force: boolean = false): Promise<{ success: boolean; count: number; skipped?: string; error?: string }> {
  try {
    const today = getLocalDateString();
    if (!force) {
      const stored = await chrome.storage.local.get(['lastPurchaseSyncDate']);
      if (stored.lastPurchaseSyncDate === today) return { success: true, count: 0, skipped: 'already synced today' };
    }
    if ((await db.orders.count()) === 0) return { success: true, count: 0, skipped: 'no orders saved yet' };
    const session = await shopeeFetcher.checkSession();
    if (!session.loggedIn) return { success: false, count: 0, skipped: 'not logged in' };

    await setupNetRules();
    const res = await shopeeFetcher.fetchAllPurchases(() => {}, undefined, 10, {
      fullSync: false,
      openTabIfNeeded: false,
    });

    const now = Date.now();
    const result = { at: now, success: res.success, count: res.totalFetched, error: res.error || null };
    const toStore: Record<string, unknown> = { lastPurchaseSyncResult: result };
    if (res.success) Object.assign(toStore, { lastPurchaseSyncDate: today, lastPurchaseSyncAt: now });
    await chrome.storage.local.set(toStore);
    chrome.runtime.sendMessage({ type: 'PURCHASES_AUTO_SYNCED', ...result }).catch(() => {});
    return { success: res.success, count: res.totalFetched, error: res.error };
  } catch (err: any) {
    return { success: false, count: 0, error: err?.message || 'Daily purchase sync failed' };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupNetRules();
  ensureCartAlarm();
  ensurePurchaseAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupNetRules();
  ensureCartAlarm();
  ensurePurchaseAlarm();
  runQuietCartCheck(false);
  runDailyPurchaseSync(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CART_ALARM_NAME) {
    runQuietCartCheck(false);
  }
  if (alarm.name === PURCHASE_ALARM_NAME) {
    runDailyPurchaseSync(false);
  }
});

// Run immediately in worker context
setupNetRules();
ensureCartAlarm();
ensurePurchaseAlarm();

// Listen for messages from popup, content scripts, or dashboard
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'OPEN_DASHBOARD') {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        chrome.tabs.create({ url: dashboardUrl });
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'ENSURE_NET_RULES') {
    setupNetRules().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'INTERCEPTED_SHOPEE_DATA') {
    chrome.runtime
      .sendMessage({
        type: 'SHOPEE_DATA_INTERCEPTED_BROADCAST',
        data: request.data,
      })
      .catch(() => {});
    return false;
  }

  if (request.type === 'INTERCEPTED_CART_DATA' && request.data) {
    const items = extractCartItemsFromPayload(request.data);
    if (items.length > 0) {
      const now = Date.now();
      db.recordCartSnapshot(items, now)
        .then(async (count) => {
          await chrome.storage.local.set({ lastCartCheckDate: getLocalDateString(now), lastCartCheckAt: now });
          chrome.runtime.sendMessage({ type: 'CART_PRICE_UPDATED', count, lastCheckedAt: now }).catch(() => {});
        })
        .catch(() => {});
    }
    return false;
  }

  if (request.type === 'CHECK_CART_NOW') {
    runQuietCartCheck(true).then(sendResponse);
    return true;
  }

  if (request.type === 'GET_CART_PRICE_HISTORY') {
    Promise.all([
      db.getCartItemsWithHistory(),
      chrome.storage.local.get(['lastCartCheckAt']),
    ])
      .then(([items, stored]) => {
        sendResponse({ success: true, items, lastCheckedAt: stored.lastCartCheckAt || null });
      })
      .catch((err) => {
        sendResponse({ success: false, items: [], error: err?.message });
      });
    return true;
  }

  return false;
});

// Runs in MAIN world (same JavaScript context as Shopee web app)
// Intercepts Shopee's native order requests (both fetch and XMLHttpRequest)

(function () {
  console.log('[ShopeeTracker:MAIN] Network interceptor loaded.');

  function notifyIntercepted(type: string, url: string, json: any) {
    if (!json || typeof json !== 'object') return;
    try {
      window.postMessage(
        {
          type,
          url,
          data: json,
        },
        window.location.origin
      );
    } catch (err) {
      console.warn('[ShopeeTracker:MAIN] Error posting intercepted data message:', err);
    }
  }

  function classifyUrl(url: string): string | null {
    if (url.includes('/api/v4/order/')) return 'SHOPEE_TRACKER_INTERCEPTED_DATA';
    if (url.includes('/api/v4/cart/get') || url.includes('/api/v4/cart/v2/get')) {
      return 'SHOPEE_TRACKER_CART_DATA';
    }
    return null;
  }

  // 1. Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';

    const response = await originalFetch.apply(this, args);

    const msgType = classifyUrl(url);
    if (msgType) {
      try {
        const clone = response.clone();
        clone
          .json()
          .then((json) => {
            notifyIntercepted(msgType, url, json);
          })
          .catch(() => {});
      } catch (err) {
        console.warn('[ShopeeTracker:MAIN] Error cloning fetch response:', err);
      }
    }

    return response;
  };

  // 2. Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (...args: any[]) {
    (this as any).__url = args[1];
    return originalOpen.apply(this, args as any);
  };

  XMLHttpRequest.prototype.send = function (...args: any[]) {
    this.addEventListener('load', function () {
      const url = (this as any).__url || '';
      const msgType = classifyUrl(url);
      if (msgType) {
        try {
          const json = JSON.parse(this.responseText);
          notifyIntercepted(msgType, url, json);
        } catch (e) {}
      }
    });

    return originalSend.apply(this, args as any);
  };

  // 3. Fetch bridge for the extension's tab fallback.
  // Calls the page's current window.fetch (wrapped by Shopee, which adds its anti-bot headers)
  // so these requests look like the page's own. Limited to same-origin /api/v4/order/ and /api/v4/cart/.
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== 'SHOPEE_TRACKER_FETCH') return;
    const { reqId, path, method, body } = event.data;
    const reply = (payload: Record<string, unknown>) =>
      window.postMessage({ type: 'SHOPEE_TRACKER_FETCH_RESULT', reqId, ...payload }, window.location.origin);

    const isAllowed =
      typeof path === 'string' &&
      (path.startsWith('/api/v4/order/') || path.startsWith('/api/v4/cart/'));

    if (!isAllowed) {
      reply({ success: false, error: 'Path not allowed' });
      return;
    }
    try {
      const fetchOpts: RequestInit = {
        method: method === 'POST' ? 'POST' : 'GET',
        credentials: 'include',
      };
      if (fetchOpts.method === 'POST') {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      }
      const res = await window.fetch(path, fetchOpts);
      const data = await res.json().catch(() => null);
      reply({ success: res.ok && !!data, status: res.status, data });
    } catch (err: any) {
      reply({ success: false, error: err?.message || 'Fetch failed' });
    }
  });
})();

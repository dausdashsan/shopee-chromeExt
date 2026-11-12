// Runs in MAIN world (same JavaScript context as Shopee web app)
// Intercepts Shopee's native order requests (both fetch and XMLHttpRequest)

(function () {
  console.log('[ShopeeTracker:MAIN] Network interceptor loaded.');

  function notifyOrderData(url: string, json: any) {
    if (!json || typeof json !== 'object') return;
    try {
      window.postMessage(
        {
          type: 'SHOPEE_TRACKER_INTERCEPTED_DATA',
          url,
          data: json,
        },
        '*'
      );
    } catch (err) {
      console.warn('[ShopeeTracker:MAIN] Error posting order data message:', err);
    }
  }

  // 1. Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';

    const response = await originalFetch.apply(this, args);

    if (url.includes('/api/v4/order/')) {
      try {
        const clone = response.clone();
        clone
          .json()
          .then((json) => {
            console.log('[ShopeeTracker:MAIN] Intercepted order fetch:', url);
            notifyOrderData(url, json);
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
      if (url.includes('/api/v4/order/')) {
        try {
          const json = JSON.parse(this.responseText);
          console.log('[ShopeeTracker:MAIN] Intercepted order XHR:', url);
          notifyOrderData(url, json);
        } catch (e) {}
      }
    });

    return originalSend.apply(this, args as any);
  };

  // 3. Fetch bridge for the extension's tab fallback.
  // Calls the page's current window.fetch (wrapped by Shopee, which adds its anti-bot headers)
  // so these requests look like the page's own. Limited to same-origin GETs under /api/v4/order/.
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.type !== 'SHOPEE_TRACKER_FETCH') return;
    const { reqId, path } = event.data;
    const reply = (payload: Record<string, unknown>) =>
      window.postMessage({ type: 'SHOPEE_TRACKER_FETCH_RESULT', reqId, ...payload }, window.location.origin);

    if (typeof path !== 'string' || !path.startsWith('/api/v4/order/')) {
      reply({ success: false, error: 'Path not allowed' });
      return;
    }
    try {
      const res = await window.fetch(path, { credentials: 'include' });
      const data = await res.json().catch(() => null);
      reply({ success: res.ok && !!data, status: res.status, data });
    } catch (err: any) {
      reply({ success: false, error: err?.message || 'Fetch failed' });
    }
  });
})();

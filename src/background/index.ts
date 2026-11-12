// Shopee Purchase Tracker - Background Service Worker

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
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          },
        },
      ],
    });
    console.log('[Background] DeclarativeNetRequest rules registered successfully.');
  } catch (err) {
    console.error('[Background] Failed to register declarativeNetRequest rules:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Shopee Purchase Tracker extension installed.');
  setupNetRules();
});

chrome.runtime.onStartup.addListener(() => {
  setupNetRules();
});

// Run immediately in worker context
setupNetRules();

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
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.type === 'ENSURE_NET_RULES') {
    setupNetRules().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'INTERCEPTED_SHOPEE_DATA') {
    chrome.runtime.sendMessage({
      type: 'SHOPEE_DATA_INTERCEPTED_BROADCAST',
      data: request.data,
    }).catch(() => {});
    return true;
  }
});

# Shopee Purchase & Spending Tracker (Chrome Extension)

A Chrome Extension (Manifest V3) built with **React**, **TypeScript**, **Tailwind CSS**, and **Dexie (IndexedDB)** to fetch, analyze, and visualize all-time purchase history and spending on **Shopee Malaysia (`shopee.com.my`)**.

---

## ✨ Features

- **Authenticated Session Reuse**: No API keys or credentials needed. Leverages your active logged-in browser session on Shopee MY.
- **All-Time Purchase History**: Automatically paginates through past orders with polite rate limiting (~500ms delay) to prevent anti-bot triggers.
- **Local IndexedDB Cache**: Orders are cached locally in your browser so you don't need to re-fetch years of data every time.
- **Lifetime Spending Analytics**:
  - Total Spend (Completed purchases only)
  - Total Orders, Completed, Cancelled, and Refunded breakdown
  - Average Order Value (AOV)
  - Annual spend breakdown bar visualization
- **Interactive Purchase Table**:
  - Filter by year (All, 2026, 2025, 2024, etc.)
  - Filter by status (All, Completed, Cancelled, Refunded)
  - Full-text search across product titles, shop names, and Order SNs
  - Sort by date or total price
  - Direct links to original Shopee order pages
- **Order Details Modal**: Inspect item variations, item thumbnails, unit prices, and quantities.
- **Export to CSV**: Export your filtered order history for spreadsheet budgeting.
- **In-Page Floating Button**: Injects a handy shortcut on Shopee to open the dashboard.

---

## 🚀 How to Install in Chrome

1. Build the extension:
   ```bash
   npm run build
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** (toggle switch in the top-right corner).
4. Click **Load unpacked** in the top-left corner.
5. Select the `dist` folder inside this project directory (`d:\Workspace\shopee-chromeExt\dist`).
6. Pin the extension to your Chrome toolbar.

---

## 📖 How to Use

1. Ensure you are logged into your account on [shopee.com.my](https://shopee.com.my).
2. Click the extension icon in Chrome and click **"Open Full Dashboard"** (or click the floating button on Shopee).
3. On the dashboard, click **"Fetch All Purchases"** (or "Sync Purchases").
4. Watch the progress bar fetch your orders page by page.
5. Explore your lifetime spend, yearly trends, and order table!

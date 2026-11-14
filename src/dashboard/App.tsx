import { useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../db';
import { shopeeFetcher } from '../services/shopeeFetcher';
import { syncWithCloud } from '../services/cloudSync';
import type { NormalizedOrder, FetchProgress, CartItemWithHistory } from '../types/shopee';
import {
  ShoppingBag,
  DollarSign,
  Package,
  Calendar,
  Search,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  X,
  Trash2,
  FileSpreadsheet,
  Store,
  Layers,
  Terminal,
  Download,
  Upload,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  Cloud,
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'orders' | 'cart'>('orders');
  const [orders, setOrders] = useState<NormalizedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<NormalizedOrder | null>(null);

  // Cart Price History state
  const [cartItems, setCartItems] = useState<CartItemWithHistory[]>([]);
  const [lastCartCheckAt, setLastCartCheckAt] = useState<number | null>(null);
  const [isCheckingCart, setIsCheckingCart] = useState(false);
  const [cartSearch, setCartSearch] = useState('');

  // Auth & Sync state
  const [auth, setAuth] = useState<{ loggedIn: boolean; username?: string; checking: boolean }>({
    loggedIn: false,
    checking: true,
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<number | null>(null);
  const [lastAutoSync, setLastAutoSync] = useState<{ at: number; success: boolean; count: number; error?: string | null } | null>(null);
  const [fullSync, setFullSync] = useState(() => localStorage.getItem('shopeeTracker.fullSync') === '1');
  const [syncProgress, setSyncProgress] = useState<FetchProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Live debug logs
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'active' | 'cancelled' | 'refunded'>('all');
  const [sortBy, setSortBy] = useState<'date-desc' | 'date-asc' | 'price-desc' | 'price-asc'>('date-desc');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedYear, statusFilter, sortBy]);

  useEffect(() => {
    if (!selectedOrder) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedOrder(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedOrder]);

  useEffect(() => {
    loadOrders();
    loadCartHistory();
    checkAuth();

    const listener = (msg: any) => {
      if (msg.type === 'SHOPEE_DATA_INTERCEPTED_BROADCAST' && msg.data) {
        addLog('Captured live order payload from Shopee page!');
        shopeeFetcher.saveRawPayload(msg.data).then((count) => {
          if (count > 0) {
            addLog(`Saved ${count} orders intercepted from Shopee page.`);
            loadOrders();
          }
        });
      }
      if (msg.type === 'CART_PRICE_UPDATED') {
        loadCartHistory();
      }
      if (msg.type === 'PURCHASES_AUTO_SYNCED') {
        setLastAutoSync({ at: msg.at, success: msg.success, count: msg.count, error: msg.error });
        addLog(msg.success ? `Daily auto-sync: ${msg.count} orders checked.` : `Daily auto-sync failed: ${msg.error}`);
        if (msg.success) loadOrders();
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function loadCartHistory() {
    const [items, stored] = await Promise.all([
      db.getCartItemsWithHistory(),
      chrome.storage.local
        .get(['lastCartCheckAt', 'lastCloudSyncAt', 'lastPurchaseSyncResult'])
        .catch(() => ({} as Record<string, any>)),
    ]);
    setCartItems(items);
    if (stored?.lastPurchaseSyncResult) setLastAutoSync(stored.lastPurchaseSyncResult);
    if (stored?.lastCartCheckAt) setLastCartCheckAt(stored.lastCartCheckAt);
    if (stored?.lastCloudSyncAt) setLastCloudSyncAt(stored.lastCloudSyncAt);
  }

  function handleCheckCartNow() {
    if (isCheckingCart) return;
    setIsCheckingCart(true);
    setErrorMessage(null);
    chrome.runtime.sendMessage({ type: 'CHECK_CART_NOW' }, (res) => {
      setIsCheckingCart(false);
      if (res?.success) {
        addLog(`Logged today's prices for ${res.count} cart items.`);
        loadCartHistory();
      } else {
        const msg = res?.error || 'Could not fetch Shopee cart.';
        setErrorMessage(msg);
        addLog(`Cart check notice: ${msg}`);
      }
    });
  }

  async function handleClearCartHistory() {
    if (confirm('Clear all recorded cart price history?')) {
      await db.clearCartHistory();
      await loadCartHistory();
      addLog('Cleared cart price history.');
    }
  }

  function addLog(msg: string) {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 99)]);
  }

  async function loadOrders() {
    setLoading(true);
    const all = await db.getAllOrders();
    setOrders(all);
    setLoading(false);
  }

  async function checkAuth() {
    setAuth((prev) => ({ ...prev, checking: true }));
    const res = await shopeeFetcher.checkSession();
    setAuth({
      loggedIn: res.loggedIn,
      username: res.username,
      checking: false,
    });
    if (!res.loggedIn && res.error) {
      addLog(`Auth check: ${res.error}`);
    } else {
      addLog('Shopee session verified successfully.');
    }
  }

  async function handleStartSync() {
    if (isSyncing) return;
    setIsSyncing(true);
    setErrorMessage(null);
    addLog('Initiating sync process...');

    let lastRefreshedCount = 0;
    const res = await shopeeFetcher.fetchAllPurchases(
      (p) => {
        setSyncProgress(p);
        if (p.totalFetched > lastRefreshedCount) {
          lastRefreshedCount = p.totalFetched;
          db.getAllOrders().then(setOrders);
        }
      },
      (logMsg) => {
        addLog(logMsg);
      },
      10,
      { fullSync }
    );

    setIsSyncing(false);
    if (!res.success && res.error) {
      setErrorMessage(res.error);
      addLog(`Sync stopped with error: ${res.error}`);
    } else {
      addLog(`Sync completed. Fetched ${res.totalFetched} orders total.`);
    }

    await loadOrders();
  }

  function handleCancelSync() {
    shopeeFetcher.cancel();
    setIsSyncing(false);
    addLog('Sync cancellation requested.');
  }

  async function handleCloudSync() {
    if (isCloudSyncing) return;
    setIsCloudSyncing(true);
    setErrorMessage(null);
    addLog('Syncing orders and cart history with spekitam-note...');
    const res = await syncWithCloud();
    setIsCloudSyncing(false);
    if (!res.success) {
      setErrorMessage(res.error || 'Cloud sync failed.');
      addLog(`Cloud sync failed: ${res.error || 'unknown error'}`);
      return;
    }
    if (res.syncedAt) setLastCloudSyncAt(res.syncedAt);
    addLog(
      `Cloud sync (${res.channel}) done: pulled ${res.pulled?.orders ?? 0} orders / ${res.pulled?.cartItems ?? 0} cart items, pushed ${res.pushed?.orders ?? 0} orders / ${res.pushed?.priceSnapshots ?? 0} snapshots.`
    );
    await Promise.all([loadOrders(), loadCartHistory()]);
  }

  async function handleClearData() {
    if (confirm('Are you sure you want to clear all stored purchase history? You can re-sync anytime.')) {
      await db.clearAll();
      await loadOrders();
      addLog('Cleared local IndexedDB purchase history.');
    }
  }

  // Available years in dataset
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    orders.forEach((o) => {
      if (o.createdAt) {
        const y = new Date(o.createdAt).getFullYear();
        if (!isNaN(y)) years.add(y);
      }
    });
    return Array.from(years).sort((a, b) => b - a);
  }, [orders]);

  // Filtered & Sorted orders
  const filteredOrders = useMemo(() => {
    return orders
      .filter((o) => {
        if (statusFilter === 'completed' && !o.isCompleted) return false;
        if (statusFilter === 'active' && (o.isCompleted || o.isCancelled || o.isRefunded)) return false;
        if (statusFilter === 'cancelled' && !o.isCancelled) return false;
        if (statusFilter === 'refunded' && !o.isRefunded) return false;

        if (selectedYear !== 'all') {
          const y = new Date(o.createdAt).getFullYear().toString();
          if (y !== selectedYear) return false;
        }

        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchesSn = o.orderSn.toLowerCase().includes(q);
          const matchesShop = o.shopName.toLowerCase().includes(q);
          const matchesItems = o.items.some((item) => item.name.toLowerCase().includes(q));
          if (!matchesSn && !matchesShop && !matchesItems) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'date-desc') return b.createdAt - a.createdAt;
        if (sortBy === 'date-asc') return a.createdAt - b.createdAt;
        if (sortBy === 'price-desc') return b.totalPrice - a.totalPrice;
        if (sortBy === 'price-asc') return a.totalPrice - b.totalPrice;
        return 0;
      });
  }, [orders, statusFilter, selectedYear, searchQuery, sortBy]);

  // Overall Statistics calculated based on current view/filter
  const stats = useMemo(() => {
    let totalSpent = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let refundedCount = 0;
    let totalItems = 0;

    filteredOrders.forEach((o) => {
      if (o.isCompleted) {
        totalSpent += o.totalPrice;
        completedCount++;
        totalItems += o.itemCount;
      } else if (o.isCancelled) {
        cancelledCount++;
      } else if (o.isRefunded) {
        refundedCount++;
      }
    });

    const aov = completedCount > 0 ? totalSpent / completedCount : 0;

    return {
      totalSpent: Math.round(totalSpent * 100) / 100,
      totalCount: filteredOrders.length,
      completedCount,
      cancelledCount,
      refundedCount,
      totalItems,
      aov: Math.round(aov * 100) / 100,
    };
  }, [filteredOrders]);

  // Yearly spend summary for the bar visualization
  const yearlySpend = useMemo(() => {
    const map = new Map<number, number>();
    orders.forEach((o) => {
      if (o.isCompleted && o.createdAt) {
        const y = new Date(o.createdAt).getFullYear();
        if (!isNaN(y)) {
          map.set(y, (map.get(y) || 0) + o.totalPrice);
        }
      }
    });
    return Array.from(map.entries())
      .map(([year, amount]) => ({ year, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => a.year - b.year);
  }, [orders]);

  const maxYearSpend = useMemo(() => {
    return Math.max(...yearlySpend.map((y) => y.amount), 1);
  }, [yearlySpend]);

  // Monthly spend breakdown (selected year's 12 months, or last 12 months when 'all')
  const monthlySpend = useMemo(() => {
    const map = new Map<string, { label: string; amount: number; count: number }>();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    if (selectedYear !== 'all') {
      const yNum = Number(selectedYear);
      for (let m = 0; m < 12; m++) {
        const key = `${yNum}-${String(m + 1).padStart(2, '0')}`;
        map.set(key, { label: monthNames[m], amount: 0, count: 0 });
      }
      orders.forEach((o) => {
        if (!o.isCompleted || !o.createdAt) return;
        const d = new Date(o.createdAt);
        if (d.getFullYear() !== yNum) return;
        const key = `${yNum}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const entry = map.get(key);
        if (entry) {
          entry.amount += o.totalPrice;
          entry.count += 1;
        }
      });
    } else {
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = `${monthNames[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`;
        map.set(key, { label, amount: 0, count: 0 });
      }
      orders.forEach((o) => {
        if (!o.isCompleted || !o.createdAt) return;
        const d = new Date(o.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const entry = map.get(key);
        if (entry) {
          entry.amount += o.totalPrice;
          entry.count += 1;
        }
      });
    }

    return Array.from(map.entries()).map(([key, v]) => ({
      key,
      label: v.label,
      amount: Math.round(v.amount * 100) / 100,
      count: v.count,
    }));
  }, [orders, selectedYear]);

  const maxMonthSpend = useMemo(() => {
    return Math.max(...monthlySpend.map((m) => m.amount), 1);
  }, [monthlySpend]);

  // Top 5 shops by completed spend (respecting selectedYear)
  const topShops = useMemo(() => {
    const map = new Map<string, { shopName: string; amount: number; count: number }>();
    orders.forEach((o) => {
      if (!o.isCompleted) return;
      if (selectedYear !== 'all' && o.createdAt) {
        if (String(new Date(o.createdAt).getFullYear()) !== selectedYear) return;
      }
      const existing = map.get(o.shopName) || { shopName: o.shopName, amount: 0, count: 0 };
      existing.amount += o.totalPrice;
      existing.count += 1;
      map.set(o.shopName, existing);
    });
    return Array.from(map.values())
      .map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
  }, [orders, selectedYear]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedOrders = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredOrders.slice(start, start + PAGE_SIZE);
  }, [filteredOrders, safePage]);

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value: string | number): string {
    const str = String(value ?? '');
    // Prevent CSV formula injection in Excel/Sheets
    const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  // Export to CSV
  function exportCSV() {
    if (!filteredOrders.length) {
      alert('No orders to export!');
      return;
    }

    const headers = [
      'Order ID',
      'Order SN',
      'Date',
      'Status',
      'Shop Name',
      'Total Paid (RM)',
      'Shipping Fee (RM)',
      'Items Count',
      'Items Summary',
      'Shopee Order URL',
    ];

    const rows = filteredOrders.map((o) => [
      csvCell(o.orderId),
      csvCell(o.orderSn),
      csvCell(o.createdAtFormatted),
      csvCell(o.status),
      csvCell(o.shopName),
      o.totalPrice.toFixed(2),
      o.shippingFee.toFixed(2),
      o.itemCount,
      csvCell(o.items.map((i) => `${i.name}${i.modelName ? ` [${i.modelName}]` : ''} (x${i.quantity})`).join('; ')),
      csvCell(`https://shopee.com.my/user/purchase/order/${o.orderId}`),
    ]);

    const csvString = '\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `shopee_orders_${new Date().toISOString().slice(0, 10)}.csv`);
  }

  function exportJSON() {
    if (!orders.length) {
      alert('No orders to back up!');
      return;
    }
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      orders,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `shopee_orders_backup_${new Date().toISOString().slice(0, 10)}.json`);
    addLog(`Exported JSON backup (${orders.length} orders).`);
  }

  async function handleImportJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.orders) ? parsed.orders : [];
      const valid = list.filter((o) => o && typeof o.orderId === 'string' && o.orderId.length > 0);
      if (valid.length === 0) {
        setErrorMessage('Import failed: no valid orders found in JSON file.');
        return;
      }
      await db.upsertOrders(valid);
      await loadOrders();
      addLog(`Imported ${valid.length} orders from JSON backup.`);
    } catch (err: any) {
      setErrorMessage(`Import failed: ${err?.message || 'Invalid JSON file'}`);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-16">
      {/* Top Navigation */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#ee4d2d] flex items-center justify-center text-white shadow-md shadow-orange-500/20">
              <ShoppingBag className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-bold text-lg text-slate-900 leading-tight flex items-center gap-2">
                Shopee Purchase Tracker
                <span className="text-xs font-semibold px-2 py-0.5 bg-orange-100 text-[#ee4d2d] rounded-full">MY</span>
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <button
                  onClick={() => setActiveTab('orders')}
                  className={`text-xs font-semibold px-2 py-0.5 rounded-md transition ${
                    activeTab === 'orders' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  Orders ({orders.length})
                </button>
                <button
                  onClick={() => setActiveTab('cart')}
                  className={`text-xs font-semibold px-2 py-0.5 rounded-md transition flex items-center gap-1 ${
                    activeTab === 'cart' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <ShoppingCart className="w-3 h-3" />
                  Cart Price History ({cartItems.filter((c) => c.inCart).length})
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Login badge */}
            {auth.checking ? (
              <span className="text-xs text-slate-400">Checking session...</span>
            ) : auth.loggedIn ? (
              <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Connected: {auth.username}</span>
              </div>
            ) : (
              <a
                href="https://shopee.com.my/user/purchase"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full hover:bg-amber-100 transition"
              >
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span>Log in on Shopee MY</span>
                <ExternalLink className="w-3 h-3 ml-0.5" />
              </a>
            )}

            {/* Daily auto-sync status */}
            {lastAutoSync && (
              <span
                className={`text-[11px] ${lastAutoSync.success ? 'text-slate-400' : 'text-amber-600'}`}
                title={
                  lastAutoSync.success
                    ? 'New purchases sync automatically once a day while Chrome is open'
                    : `Last automatic sync failed: ${lastAutoSync.error || 'unknown error'}. Open a Shopee tab or sync manually.`
                }
              >
                Auto-sync: {new Date(lastAutoSync.at).toLocaleString('en-MY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {lastAutoSync.success ? '' : ' (failed)'}
              </span>
            )}

            {/* Sync mode */}
            <label
              className={`flex items-center gap-1.5 text-xs text-slate-600 select-none ${isSyncing ? 'opacity-50' : 'cursor-pointer'}`}
              title="Unticked: fetch only new orders and refresh unfinished ones. Ticked: re-sync your whole history."
            >
              <input
                type="checkbox"
                className="w-3.5 h-3.5 accent-[#ee4d2d]"
                checked={fullSync}
                disabled={isSyncing}
                onChange={(e) => {
                  setFullSync(e.target.checked);
                  localStorage.setItem('shopeeTracker.fullSync', e.target.checked ? '1' : '0');
                }}
              />
              <span>Full sync</span>
            </label>

            {/* Sync Button */}
            {isSyncing ? (
              <button
                onClick={handleCancelSync}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg flex items-center gap-2 shadow-sm transition"
              >
                <X className="w-4 h-4" />
                <span>Stop Sync</span>
              </button>
            ) : (
              <button
                onClick={handleStartSync}
                className="px-4 py-2 bg-[#ee4d2d] hover:bg-[#d73211] text-white text-xs font-semibold rounded-lg flex items-center gap-2 shadow-sm shadow-orange-500/25 transition active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{orders.length === 0 ? 'Fetch All Purchases' : fullSync ? 'Full Sync' : 'Sync New Purchases'}</span>
              </button>
            )}

            {/* Cloud Sync */}
            <button
              onClick={handleCloudSync}
              disabled={isCloudSyncing}
              title={lastCloudSyncAt ? `Last cloud sync: ${new Date(lastCloudSyncAt).toLocaleString()}` : 'Sync orders & cart history across devices'}
              className="px-3 py-2 bg-sky-50 hover:bg-sky-100 disabled:opacity-60 text-sky-700 border border-sky-200 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition"
            >
              <Cloud className={`w-3.5 h-3.5 ${isCloudSyncing ? 'animate-pulse' : ''}`} />
              <span>{isCloudSyncing ? 'Syncing...' : 'Cloud Sync'}</span>
            </button>

            {/* Export CSV */}
            <button
              onClick={exportCSV}
              disabled={filteredOrders.length === 0}
              className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition disabled:opacity-40"
              title="Export filtered orders to CSV"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>CSV</span>
            </button>

            {/* Backup / Restore JSON */}
            <button
              onClick={exportJSON}
              disabled={orders.length === 0}
              className="p-2 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 rounded-lg transition disabled:opacity-40"
              title="Backup all orders to JSON"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              className="p-2 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 rounded-lg transition"
              title="Restore orders from JSON backup"
            >
              <Upload className="w-4 h-4" />
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportJSON}
            />

            {/* Toggle Debug Logs */}
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`p-2 rounded-lg text-xs font-medium border transition flex items-center gap-1 ${
                showLogs ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
              title="Toggle Live Debug Console"
            >
              <Terminal className="w-4 h-4" />
              <span className="hidden sm:inline">Debug</span>
            </button>

            {/* Clear Database */}
            {orders.length > 0 && (
              <button
                onClick={handleClearData}
                className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                title="Clear local database"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Sync Banner Progress */}
      {isSyncing && (
        <div className="bg-orange-50 border-b border-orange-200 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-orange-900">
            <div className="flex items-center gap-3">
              <RefreshCw className="w-4 h-4 text-[#ee4d2d] animate-spin" />
              <span>
                <strong>Fetching orders from Shopee MY...</strong> Fetched{' '}
                <span className="font-bold text-[#ee4d2d]">{syncProgress?.totalFetched ?? 0}</span> orders so far (Offset:{' '}
                {syncProgress?.currentOffset ?? 0}).
              </span>
            </div>
            <span className="text-orange-700/80">Rate-limited safely (~500ms delay per page)</span>
          </div>
        </div>
      )}

      {/* Error Alert Banner */}
      {errorMessage && (
        <div className="bg-rose-50 border-b border-rose-200 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-rose-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>
                <strong>Sync Notice:</strong> {errorMessage}
              </span>
            </div>
            <button onClick={() => setErrorMessage(null)} className="text-rose-500 hover:text-rose-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Live Debug Logs Drawer */}
      {showLogs && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div className="bg-slate-900 text-slate-200 rounded-xl p-4 font-mono text-[11px] shadow-lg border border-slate-800">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800 text-slate-400">
              <span className="flex items-center gap-1.5 font-bold">
                <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                Live Sync & API Activity Log ({logs.length} entries)
              </span>
              <button
                onClick={() => setLogs([])}
                className="text-slate-400 hover:text-slate-200 text-[10px] underline"
              >
                Clear Log
              </button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {logs.length === 0 ? (
                <p className="text-slate-500">No activity logged yet. Click "Fetch All Purchases" to begin.</p>
              ) : (
                logs.map((l, i) => (
                  <p key={i} className="leading-relaxed">
                    {l}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'cart' ? (
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 space-y-6">
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[#ee4d2d]" />
                Daily Cart Price Monitor
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Quietly logs your cart prices once a day in the background and whenever you open your Shopee cart.
                {lastCartCheckAt && (
                  <span className="ml-2 text-slate-700 font-medium">
                    Last checked: {new Date(lastCartCheckAt).toLocaleString('en-MY')}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter cart items..."
                  value={cartSearch}
                  onChange={(e) => setCartSearch(e.target.value)}
                  className="pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#ee4d2d]/30"
                />
              </div>
              <button
                onClick={handleCheckCartNow}
                disabled={isCheckingCart}
                className="px-3.5 py-2 bg-[#ee4d2d] hover:bg-[#d73211] text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingCart ? 'animate-spin' : ''}`} />
                <span>{isCheckingCart ? 'Checking...' : 'Check Cart Now'}</span>
              </button>
              {cartItems.length > 0 && (
                <button
                  onClick={handleClearCartHistory}
                  className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                  title="Clear cart price history"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {cartItems.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm py-20 text-center text-slate-400 flex flex-col items-center gap-3">
              <ShoppingCart className="w-10 h-10 text-slate-300" />
              <div className="max-w-sm">
                <p className="font-semibold text-slate-700 text-sm">No cart price history yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Click "Check Cart Now" above or visit your{' '}
                  <a href="https://shopee.com.my/cart" target="_blank" rel="noreferrer" className="text-[#ee4d2d] underline">
                    Shopee Cart
                  </a>{' '}
                  to log today&apos;s prices.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {cartItems
                .filter((item) => {
                  if (!cartSearch.trim()) return true;
                  const q = cartSearch.toLowerCase();
                  return (
                    item.name.toLowerCase().includes(q) ||
                    item.shopName.toLowerCase().includes(q) ||
                    item.modelName.toLowerCase().includes(q)
                  );
                })
                .map((item) => (
                  <CartItemHistoryCard key={item.key} item={item} />
                ))}
            </div>
          )}
        </main>
      ) : (
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 space-y-6">
        {/* Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Total Spent */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm relative overflow-hidden">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Spent</span>
              <div className="w-8 h-8 rounded-lg bg-orange-50 text-[#ee4d2d] flex items-center justify-center">
                <DollarSign className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-slate-900 flex items-baseline gap-1">
              <span className="text-sm font-bold text-slate-400">RM</span>
              <span>{stats.totalSpent.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Across <strong className="text-slate-800">{stats.completedCount}</strong> completed orders
            </p>
          </div>

          {/* Total Orders */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Orders</span>
              <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                <Package className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-slate-900">{stats.totalCount}</div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-2">
              <span className="text-emerald-600 font-medium">{stats.completedCount} Completed</span>
              <span>•</span>
              <span className="text-rose-500 font-medium">{stats.cancelledCount} Cancelled</span>
              {stats.refundedCount > 0 && (
                <>
                  <span>•</span>
                  <span className="text-amber-600 font-medium">{stats.refundedCount} Refunded</span>
                </>
              )}
            </div>
          </div>

          {/* Average Order Value */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Avg Order Value (AOV)</span>
              <div className="w-8 h-8 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
                <Layers className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-slate-900 flex items-baseline gap-1">
              <span className="text-sm font-bold text-slate-400">RM</span>
              <span>{stats.aov.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Per completed checkout</p>
          </div>

          {/* Items Purchased */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider">Total Items Bought</span>
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <ShoppingBag className="w-4 h-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-slate-900">{stats.totalItems}</div>
            <p className="text-[11px] text-slate-500 mt-2">Products in completed orders</p>
          </div>
        </div>

        {/* Yearly Spend Breakdown Bar */}
        {yearlySpend.length > 0 && (
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
            <h2 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#ee4d2d]" />
              Annual Spend Breakdown
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {yearlySpend.map(({ year, amount }) => {
                const percent = Math.round((amount / maxYearSpend) * 100);
                return (
                  <div
                    key={year}
                    onClick={() => setSelectedYear(selectedYear === String(year) ? 'all' : String(year))}
                    className={`p-3 rounded-xl border cursor-pointer transition ${
                      selectedYear === String(year)
                        ? 'border-[#ee4d2d] bg-orange-50/50 ring-2 ring-orange-200'
                        : 'border-slate-100 hover:border-slate-300 bg-slate-50/50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-xs text-slate-700">{year}</span>
                      <span className="text-[10px] text-slate-400 font-medium">{percent}%</span>
                    </div>
                    <div className="text-sm font-extrabold text-slate-900">
                      RM {amount.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full mt-2 overflow-hidden">
                      <div className="h-full bg-[#ee4d2d] rounded-full" style={{ width: `${Math.max(percent, 4)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Monthly Spend & Top Shops */}
        {orders.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Monthly Spend Chart */}
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#ee4d2d]" />
                  {selectedYear === 'all' ? 'Last 12 Months Spend' : `${selectedYear} Monthly Spend`}
                </h2>
                <span className="text-[11px] text-slate-400">Completed orders</span>
              </div>
              <div className="grid grid-cols-12 gap-1.5 items-end h-36 pt-4">
                {monthlySpend.map((m) => {
                  const pct = m.amount > 0 ? Math.max(Math.round((m.amount / maxMonthSpend) * 100), 6) : 0;
                  return (
                    <div
                      key={m.key}
                      className="flex flex-col items-center h-full justify-end group"
                      title={`${m.label}: RM ${m.amount.toFixed(2)} (${m.count} orders)`}
                    >
                      <span className="text-[9px] text-slate-500 font-semibold opacity-0 group-hover:opacity-100 transition mb-1 whitespace-nowrap">
                        {m.amount > 0 ? `RM ${Math.round(m.amount)}` : ''}
                      </span>
                      <div className="w-full flex-1 flex items-end">
                        <div
                          className={`w-full rounded-t-md transition-all ${
                            m.amount > 0 ? 'bg-[#ee4d2d]/85 group-hover:bg-[#ee4d2d]' : 'bg-slate-100 h-1'
                          }`}
                          style={m.amount > 0 ? { height: `${pct}%` } : undefined}
                        />
                      </div>
                      <span className="text-[10px] text-slate-500 mt-1.5 truncate max-w-full">{m.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top Shops */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Store className="w-4 h-4 text-[#ee4d2d]" />
                  Top Shops {selectedYear !== 'all' ? `(${selectedYear})` : ''}
                </h2>
                <span className="text-[11px] text-slate-400">Click to filter</span>
              </div>
              {topShops.length === 0 ? (
                <p className="text-xs text-slate-400 py-8 text-center">No completed orders in this period.</p>
              ) : (
                <div className="space-y-2.5">
                  {topShops.map((shop, idx) => (
                    <button
                      key={shop.shopName}
                      onClick={() => setSearchQuery(searchQuery === shop.shopName ? '' : shop.shopName)}
                      className={`w-full text-left p-2 rounded-xl border transition flex items-center justify-between gap-2 ${
                        searchQuery === shop.shopName
                          ? 'border-[#ee4d2d] bg-orange-50/50'
                          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-800 truncate">{shop.shopName}</p>
                          <p className="text-[10px] text-slate-400">{shop.count} {shop.count === 1 ? 'order' : 'orders'}</p>
                        </div>
                      </div>
                      <span className="text-xs font-bold text-slate-900 whitespace-nowrap">
                        RM {shop.amount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Filter & Search Bar */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          {/* Search box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by product name, shop name, or order SN..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#ee4d2d]/30 focus:border-[#ee4d2d] transition"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Year selector */}
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#ee4d2d]/30"
            >
              <option value="all">All Years</option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>

            {/* Status Tabs */}
            <div className="flex bg-slate-100 p-0.5 rounded-xl text-xs">
              <button
                onClick={() => setStatusFilter('all')}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  statusFilter === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setStatusFilter('completed')}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  statusFilter === 'completed'
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Completed
              </button>
              <button
                onClick={() => setStatusFilter('active')}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  statusFilter === 'active'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                In Progress
              </button>
              <button
                onClick={() => setStatusFilter('cancelled')}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  statusFilter === 'cancelled'
                    ? 'bg-white text-rose-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Cancelled
              </button>
              <button
                onClick={() => setStatusFilter('refunded')}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  statusFilter === 'refunded'
                    ? 'bg-white text-amber-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Refunded
              </button>
            </div>

            {/* Sort Dropdown */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#ee4d2d]/30"
            >
              <option value="date-desc">Date (Newest first)</option>
              <option value="date-asc">Date (Oldest first)</option>
              <option value="price-desc">Price (Highest first)</option>
              <option value="price-asc">Price (Lowest first)</option>
            </select>
          </div>
        </div>

        {/* Data Table */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>
              Showing <strong className="text-slate-900">{filteredOrders.length}</strong> of{' '}
              <strong className="text-slate-900">{orders.length}</strong> purchases
            </span>
            {selectedYear !== 'all' && (
              <span className="bg-orange-100 text-[#ee4d2d] px-2 py-0.5 rounded-full font-semibold">
                Filtered by year: {selectedYear}
              </span>
            )}
          </div>

          {loading ? (
            <div className="py-20 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-[#ee4d2d]" />
              <span>Loading purchase history...</span>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="py-20 text-center text-slate-400 flex flex-col items-center gap-3">
              <ShoppingBag className="w-10 h-10 text-slate-300" />
              <div className="max-w-xs">
                <p className="font-semibold text-slate-700 text-sm">No purchases found</p>
                <p className="text-xs text-slate-500 mt-1">
                  {orders.length === 0
                    ? 'Click "Fetch All Purchases" above to load your Shopee order history.'
                    : 'No orders match your current filter or search criteria.'}
                </p>
              </div>
              {orders.length === 0 && (
                <button
                  onClick={handleStartSync}
                  className="mt-2 px-4 py-2 bg-[#ee4d2d] text-white rounded-lg text-xs font-semibold shadow-sm"
                >
                  Start Fetching
                </button>
              )}
            </div>
          ) : (
            <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Order SN</th>
                    <th className="py-3 px-4">Shop</th>
                    <th className="py-3 px-4">Items Preview</th>
                    <th className="py-3 px-4 text-center">Status</th>
                    <th className="py-3 px-4 text-right">Total Paid</th>
                    <th className="py-3 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paginatedOrders.map((order) => (
                    <tr key={order.orderId} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3.5 px-4 whitespace-nowrap text-slate-600 font-medium">
                        <span title={order.dateIsApproximate && order.createdAt > 0 ? 'Approximate: last tracking update, not the order time' : undefined}>
                          {order.dateIsApproximate && order.createdAt > 0 ? '~' : ''}
                          {order.createdAtFormatted}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] text-slate-600">
                        <a
                          href={`https://shopee.com.my/user/purchase/order/${order.orderId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-[#ee4d2d] hover:underline flex items-center gap-1"
                          title="Open order in Shopee MY"
                        >
                          {order.orderSn}
                          <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                        </a>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap text-slate-700 font-medium">
                        <div className="flex items-center gap-1.5 max-w-[140px] truncate" title={order.shopName}>
                          <Store className="w-3 h-3 text-slate-400 shrink-0" />
                          <span className="truncate">{order.shopName}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 max-w-sm">
                        <div className="flex items-center gap-2.5">
                          {order.items[0]?.imageUrl && (
                            <img
                              src={order.items[0].imageUrl}
                              alt=""
                              className="w-9 h-9 rounded-md object-cover border border-slate-200 shrink-0 bg-slate-100"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium text-slate-800" title={order.items[0]?.name}>
                              {order.items[0]?.name || 'Shopee Order Item'}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}
                              {order.items[0]?.modelName ? ` • ${order.items[0].modelName}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        {order.isCompleted ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Completed
                          </span>
                        ) : order.isCancelled ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                            Cancelled
                          </span>
                        ) : order.isRefunded ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                            Refunded
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                            {order.status}
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 text-right whitespace-nowrap font-bold text-slate-900">
                        RM {order.totalPrice.toFixed(2)}
                      </td>

                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        <button
                          onClick={() => setSelectedOrder(order)}
                          className="px-2.5 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md font-medium transition"
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600 bg-slate-50/40">
                <span>
                  Page <strong>{safePage}</strong> of <strong>{totalPages}</strong> ({filteredOrders.length} orders)
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </main>
      )}

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div
          onClick={() => setSelectedOrder(null)}
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div>
                <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                  Order Details
                  <span className="font-mono text-xs text-slate-500 font-normal">#{selectedOrder.orderSn}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {!selectedOrder.createdAt ? 'Date' : selectedOrder.dateIsApproximate ? 'Last updated' : 'Placed on'} {selectedOrder.createdAtFormatted} • Shop: <strong>{selectedOrder.shopName}</strong>
                </p>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              <div className="space-y-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Items in this order ({selectedOrder.itemCount})
                </span>
                {selectedOrder.items.map((item, idx) => (
                  <div key={idx} className="flex gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="w-14 h-14 rounded-lg object-cover border border-slate-200 shrink-0 bg-white"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-slate-200 flex items-center justify-center text-slate-400 shrink-0">
                        <ShoppingBag className="w-6 h-6" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-800 leading-snug">{item.name}</p>
                      {item.modelName && <p className="text-[11px] text-slate-500 mt-0.5">Variation: {item.modelName}</p>}
                      <div className="flex items-center justify-between mt-2 text-xs">
                        <span className="text-slate-500">
                          Qty: <strong>{item.quantity}</strong> × RM {item.unitPrice.toFixed(2)}
                        </span>
                        <span className="font-bold text-slate-900">RM {item.totalPrice.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-1.5 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Order Status:</span>
                  <span className="font-semibold text-slate-900">{selectedOrder.status}</span>
                </div>
                {selectedOrder.shippingFee > 0 && (
                  <div className="flex justify-between">
                    <span>Shipping Fee:</span>
                    <span>RM {selectedOrder.shippingFee.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between pt-2 border-t border-slate-200 font-bold text-sm text-slate-900">
                  <span>Total Paid:</span>
                  <span className="text-[#ee4d2d]">RM {selectedOrder.totalPrice.toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
              <a
                href={`https://shopee.com.my/user/purchase/order/${selectedOrder.orderId}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[#ee4d2d] hover:underline font-semibold flex items-center gap-1"
              >
                View on Shopee MY
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={() => setSelectedOrder(null)}
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg text-xs font-medium transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CartItemHistoryCard({ item }: { item: CartItemWithHistory }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const history = item.history;
  const width = 440;
  const height = 100;
  const padX = 12;
  const padY = 14;

  const prices = history.map((h) => h.price);
  const min = prices.length ? Math.min(...prices) : item.currentPrice;
  const max = prices.length ? Math.max(...prices) : item.currentPrice;
  const span = max - min || 1;

  const coords = history.map((pt, i) => {
    const x =
      history.length <= 1
        ? width / 2
        : padX + (i / (history.length - 1)) * (width - padX * 2);
    const y =
      max === min
        ? height / 2
        : padY + (1 - (pt.price - min) / span) * (height - padY * 2);
    return { x, y, ...pt };
  });

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPoints =
    coords.length > 0
      ? `${coords[0].x.toFixed(1)},${height - 2} ${polylinePoints} ${coords[coords.length - 1].x.toFixed(1)},${height - 2}`
      : '';

  const productUrl = item.shopId
    ? `https://shopee.com.my/product/${item.shopId}/${item.itemId}`
    : `https://shopee.com.my/cart`;

  const activePoint = hoveredIdx !== null ? coords[hoveredIdx] : coords[coords.length - 1];

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            className="w-14 h-14 rounded-xl object-cover border border-slate-200 shrink-0 bg-slate-100"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 shrink-0">
            <ShoppingBag className="w-6 h-6" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <a
              href={productUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-bold text-slate-900 hover:text-[#ee4d2d] hover:underline line-clamp-2"
            >
              {item.name}
            </a>
            <span
              className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                item.inCart
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-slate-100 text-slate-500 border-slate-200'
              }`}
            >
              {item.inCart ? 'In Cart' : 'Removed'}
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate">
            {item.shopName}
            {item.modelName ? ` • ${item.modelName}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
            <span className="font-extrabold text-[#ee4d2d] text-sm">
              RM {item.currentPrice.toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-500">
              Low: <strong className="text-emerald-700">RM {item.lowestPrice.toFixed(2)}</strong>
            </span>
            <span className="text-[11px] text-slate-500">
              High: <strong className="text-slate-700">RM {item.highestPrice.toFixed(2)}</strong>
            </span>
            {item.lastPaidPrice !== undefined && (
              <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                Last paid: RM {item.lastPaidPrice.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Day-by-day SVG Graph */}
      <div className="bg-orange-50/40 border border-orange-100 rounded-xl p-3">
        <div className="flex items-center justify-between text-[11px] text-slate-600 mb-1.5">
          <span className="font-semibold">
            {history.length} {history.length === 1 ? 'day' : 'days'} logged
          </span>
          {activePoint && (
            <span className="font-mono text-[11px] text-slate-800">
              {activePoint.date}: <strong className="text-[#ee4d2d]">RM {activePoint.price.toFixed(2)}</strong>
            </span>
          )}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-24 overflow-visible">
          {areaPoints && <polygon points={areaPoints} fill="rgba(238, 77, 45, 0.12)" />}
          {coords.length > 1 && (
            <polyline
              fill="none"
              stroke="#ee4d2d"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={polylinePoints}
            />
          )}
          {coords.map((c, idx) => (
            <circle
              key={c.id}
              cx={c.x}
              cy={c.y}
              r={hoveredIdx === idx ? 5.5 : 3.5}
              fill="#ee4d2d"
              stroke="#ffffff"
              strokeWidth="1.5"
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <title>{`${c.date}: RM ${c.price.toFixed(2)}`}</title>
            </circle>
          ))}
        </svg>
        {history.length > 0 && (
          <div className="flex justify-between text-[10px] text-slate-400 mt-1">
            <span>{history[0].date}</span>
            <span>{history[history.length - 1].date}</span>
          </div>
        )}
      </div>
    </div>
  );
}

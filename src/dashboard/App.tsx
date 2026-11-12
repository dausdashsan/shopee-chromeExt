import { useState, useEffect, useMemo } from 'react';
import { db } from '../db';
import { shopeeFetcher } from '../services/shopeeFetcher';
import type { NormalizedOrder, FetchProgress } from '../types/shopee';
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
} from 'lucide-react';

export default function App() {
  const [orders, setOrders] = useState<NormalizedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<NormalizedOrder | null>(null);

  // Auth & Sync state
  const [auth, setAuth] = useState<{ loggedIn: boolean; username?: string; checking: boolean }>({
    loggedIn: false,
    checking: true,
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [fullSync, setFullSync] = useState(() => localStorage.getItem('shopeeTracker.fullSync') === '1');
  const [syncProgress, setSyncProgress] = useState<FetchProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Live debug logs
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'cancelled' | 'refunded'>('all');
  const [sortBy, setSortBy] = useState<'date-desc' | 'date-asc' | 'price-desc' | 'price-asc'>('date-desc');

  useEffect(() => {
    loadOrders();
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
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

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

    const res = await shopeeFetcher.fetchAllPurchases(
      (p) => {
        setSyncProgress(p);
        if (p.totalFetched > 0 && p.totalFetched % 10 === 0) {
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

  // Export to CSV
  function exportCSV() {
    if (!filteredOrders.length) {
      alert('No orders to export!');
      return;
    }

    const headers = [
      'Order SN',
      'Date',
      'Status',
      'Shop Name',
      'Total Paid (RM)',
      'Items Count',
      'Items Summary',
      'Shopee Order URL',
    ];

    const rows = filteredOrders.map((o) => [
      `"${o.orderSn}"`,
      `"${o.createdAtFormatted}"`,
      `"${o.status}"`,
      `"${o.shopName.replace(/"/g, '""')}"`,
      o.totalPrice.toFixed(2),
      o.itemCount,
      `"${o.items.map((i) => `${i.name} (x${i.quantity})`).join('; ').replace(/"/g, '""')}"`,
      `"https://shopee.com.my/user/purchase/order/${o.orderId}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `shopee_orders_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
              <p className="text-xs text-slate-500">All-time purchase history & spending insights</p>
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

            {/* Export CSV */}
            <button
              onClick={exportCSV}
              disabled={filteredOrders.length === 0}
              className="px-3.5 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition disabled:opacity-40"
              title="Export filtered orders to CSV"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>Export CSV</span>
            </button>

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
                  {filteredOrders.map((order) => (
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
          )}
        </div>
      </main>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
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

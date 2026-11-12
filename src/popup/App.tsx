import { useState, useEffect } from 'react';
import { db } from '../db';
import { shopeeFetcher } from '../services/shopeeFetcher';
import { ShoppingBag, LayoutDashboard, RefreshCw, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';

export default function App() {
  const [stats, setStats] = useState({ totalSpent: 0, totalOrders: 0, completedCount: 0 });
  const [authStatus, setAuthStatus] = useState<{ loggedIn: boolean; username?: string; checking: boolean }>({
    loggedIn: false,
    checking: true,
  });
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');

  useEffect(() => {
    loadData();
    checkAuth();
  }, []);

  async function loadData() {
    const s = await db.getSummaryStats();
    setStats({
      totalSpent: s.totalSpent,
      totalOrders: s.totalOrders,
      completedCount: s.completedCount,
    });
  }

  async function checkAuth() {
    setAuthStatus((prev) => ({ ...prev, checking: true }));
    const res = await shopeeFetcher.checkSession();
    setAuthStatus({
      loggedIn: res.loggedIn,
      username: res.username,
      checking: false,
    });
  }

  function openDashboard() {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  }

  function openShopee() {
    chrome.tabs.create({ url: 'https://shopee.com.my/user/purchase' });
  }

  async function startQuickSync() {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncStatus('Starting sync...');

    // Quick sync: new orders + unfinished ones only (full re-sync is a dashboard option)
    const res = await shopeeFetcher.fetchAllPurchases(
      (p) => {
        setSyncStatus(`Fetched ${p.totalFetched} orders...`);
      },
      undefined,
      10,
      { fullSync: false }
    );

    setIsSyncing(false);
    if (res.success) {
      setSyncStatus(`Synced ${res.totalFetched} orders!`);
      await loadData();
    } else {
      setSyncStatus(res.error || 'Sync failed');
    }
  }

  return (
    <div className="p-4 flex flex-col h-full bg-slate-50 text-slate-800">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#ee4d2d] flex items-center justify-center text-white shadow-sm">
            <ShoppingBag className="w-4 h-4" />
          </div>
          <div>
            <h1 className="font-bold text-sm text-slate-900 leading-tight">Shopee Tracker</h1>
            <p className="text-[11px] text-slate-500">Spending & Order Analytics</p>
          </div>
        </div>

        {/* Auth Badge */}
        {authStatus.checking ? (
          <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">Checking...</span>
        ) : authStatus.loggedIn ? (
          <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full flex items-center gap-1 font-medium">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Connected
          </span>
        ) : (
          <span className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full flex items-center gap-1 font-medium">
            <AlertCircle className="w-3 h-3 text-amber-600" /> Not Logged In
          </span>
        )}
      </div>

      {/* Spend Highlight Card */}
      <div className="my-3 p-3.5 bg-gradient-to-br from-white to-orange-50/40 rounded-xl border border-orange-100/80 shadow-sm">
        <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Total Lifetime Spend</span>
        <div className="text-2xl font-extrabold text-[#ee4d2d] mt-1 flex items-baseline gap-1">
          <span className="text-sm font-semibold text-slate-500">RM</span>
          <span>{stats.totalSpent.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div className="mt-2 text-xs text-slate-500 flex items-center justify-between pt-2 border-t border-slate-100">
          <span>{stats.completedCount} completed orders</span>
          <span className="text-slate-400">({stats.totalOrders} total recorded)</span>
        </div>
      </div>

      {/* Sync Status / Feedback */}
      {syncStatus && (
        <div className="mb-3 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs flex items-center justify-between">
          <span className="truncate">{syncStatus}</span>
          {isSyncing && <RefreshCw className="w-3 h-3 animate-spin text-[#ee4d2d] shrink-0" />}
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-2 mt-auto">
        <button
          onClick={openDashboard}
          className="w-full py-2.5 px-4 bg-[#ee4d2d] hover:bg-[#d73211] text-white rounded-lg font-medium text-xs flex items-center justify-center gap-2 shadow-sm transition active:scale-[0.99]"
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>Open Full Dashboard & Table</span>
        </button>

        {authStatus.loggedIn ? (
          <button
            onClick={startQuickSync}
            disabled={isSyncing}
            className="w-full py-2 px-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Syncing...' : 'Sync Latest Purchases'}</span>
          </button>
        ) : (
          <button
            onClick={openShopee}
            className="w-full py-2 px-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition"
          >
            <ExternalLink className="w-3.5 h-3.5 text-[#ee4d2d]" />
            <span>Log in on Shopee MY</span>
          </button>
        )}
      </div>
    </div>
  );
}

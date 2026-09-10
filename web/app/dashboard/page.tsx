'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePrivy, useSendTransaction } from '@privy-io/react-auth';
import { parseUnits } from 'viem';
import { useRouter } from 'next/navigation';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import QRCode from 'qrcode';
import Brand from '../components/Brand';
import Copyable from '../components/Copyable';
import Avatar from '../components/Avatar';
import Cover from '../components/Cover';
import { useEmbeddedWallet } from '../lib/useEmbeddedWallet';
import {
  ARC_CHAIN_ID,
  FAUCET_URL,
  RANGES,
  buildBalanceSeries,
  fetchBalance,
  fetchWalletData,
  formatUsdc,
  relTime,
  shortHash,
  txUrl,
  type ArcTx,
  type BalancePoint,
  type RangeKey,
} from '../lib/arc';

type Tab = 'overview' | 'agents' | 'marketplace' | 'allowlist';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

const INITIAL_AGENTS = [
  { id: 'ag_1', name: 'Procurement Agent', wallet: '0x9f4c2a77b1e0d5a9c3f2', dailyBudget: 500, perAction: 100, approvalThreshold: 250, allowlist: 6, spentToday: 180, status: 'active' },
  { id: 'ag_2', name: 'Data Research Agent', wallet: '0x2c88e1730af4b902dd51', dailyBudget: 200, perAction: 25, approvalThreshold: 150, allowlist: 12, spentToday: 47, status: 'active' },
  { id: 'ag_3', name: 'Ops Bill-Pay Agent', wallet: '0x71d004be55aa20c1e8f3', dailyBudget: 1000, perAction: 400, approvalThreshold: 500, allowlist: 4, spentToday: 0, status: 'paused' },
];

const INITIAL_ALLOWLIST: { id: string; listingId: string; name: string; address: string; cap: number }[] = [];

type BuyerAgent = (typeof INITIAL_AGENTS)[number];
type AllowEntry = (typeof INITIAL_ALLOWLIST)[number];

// Buyer spend policy. Governs every "Hire & pay" before the transfer signs.
type PolicyVerdict =
  | { ok: true; needsApproval: boolean }
  | { ok: false; reason: string };

function checkPolicy(agent: BuyerAgent, priceUsdc: number, payTo: string, allowlist: AllowEntry[]): PolicyVerdict {
  if (agent.status !== 'active') return { ok: false, reason: `${agent.name} is paused — resume it to spend.` };
  const entry = allowlist.find((w) => w.address.toLowerCase() === payTo.toLowerCase());
  if (!entry) return { ok: false, reason: 'This worker is not on your allowlist. Add it first.' };
  if (entry.cap && priceUsdc > entry.cap) return { ok: false, reason: `Over this worker's per-call cap ($${entry.cap}).` };
  if (priceUsdc > agent.perAction) return { ok: false, reason: `Over ${agent.name}'s per-action limit ($${agent.perAction}).` };
  if (agent.spentToday + priceUsdc > agent.dailyBudget)
    return { ok: false, reason: `Over ${agent.name}'s daily budget ($${agent.spentToday} of $${agent.dailyBudget} spent).` };
  return { ok: true, needsApproval: priceUsdc >= agent.approvalThreshold };
}

type Listing = {
  id: string;
  name: string;
  summary: string;
  tags: string;
  price: string;
  payTo: string;
  owner: string;
  endpoint: string;
};

const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

// Live discovery — reads active agents straight from the Sovereign subgraph.
async function fetchMarket(): Promise<Listing[]> {
  const query =
    '{ agents(where: { active: true }, orderBy: createdAt, orderDirection: desc, first: 100) { id name description tags endpoint pricePerCall payTo owner } }';
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('subgraph error');
  return (json.data?.agents ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    summary: a.description,
    tags: a.tags,
    price: (Number(a.pricePerCall) / 1e6).toString(),
    payTo: a.payTo,
    owner: a.owner,
    endpoint: a.endpoint,
  }));
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-panel p-5">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Pill({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    allowed: 'text-accent',
    approved: 'text-accent',
    received: 'text-accent',
    denied: 'text-red-400',
    blocked: 'text-red-400',
    failed: 'text-red-400',
    active: 'text-accent',
    paused: 'text-muted',
    sent: 'text-muted',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider ${map[kind] ?? 'text-muted'}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {kind}
    </span>
  );
}

// Slanting arrow facing top-right.
function ArrowUpRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="8 7 17 7 17 16" />
    </svg>
  );
}

// The MCP detail body — shown in the click modal. Every field here is on-chain.
function McpDetails({ l }: { l: Listing }) {
  const tags = l.tags ? l.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  return (
    <>
      <div className="flex items-center gap-3">
        <Avatar name={l.name} size={40} />
        <div>
          <div className="font-medium">{l.name}</div>
          <div className="text-xs text-muted">by <span className="font-mono">{short(l.owner)}</span></div>
        </div>
      </div>

      <p className="mt-3 px-1 text-sm justify-center text-muted">{l.summary}</p>

      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="rounded-full border border-hairline bg-background px-2 py-0.5 font-mono text-[10px] text-muted">{t}</span>
          ))}
        </div>
      )}

       <div className="mt-3 flex items-center justify-between rounded-lg border border-hairline bg-background px-3 py-2">
        <span className="text-[10px] font-bold uppercase text-muted">Worker Wallet </span>
        <Copyable value={l.payTo} className="font-mono text-xs text-muted hover:text-foreground">&nbsp;{short(l.payTo)}</Copyable>
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-background p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">MCP endpoint</span>
          <span className="font-mono text-[10px] text-accent">HTTP + x402</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs">{l.endpoint}</div>
      </div>

    </>
  );
}

export default function Dashboard() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const router = useRouter();

  const [org, setOrg] = useState<string | null>(null);
  const [orgReady, setOrgReady] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');

  const [agents, setAgents] = useState<BuyerAgent[]>(INITIAL_AGENTS);
  const [allowlist, setAllowlist] = useState<AllowEntry[]>(INITIAL_ALLOWLIST);
  const [policyReady, setPolicyReady] = useState(false);

  // marketplace "Hire & pay" + spend-policy enforcement
  const [hireId, setHireId] = useState<string | null>(null);
  const [editAgentId, setEditAgentId] = useState<string | null>(null);

  // ---- live wallet (Privy embedded wallet, on Arc) ----
  // Resolved explicitly rather than via `user.wallet`: for a MetaMask login that
  // field is the MetaMask account, which `useSendTransaction` cannot sign with.
  const embedded = useEmbeddedWallet();
  const walletAddress = embedded.address;
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<ArcTx[]>([]);
  const [history, setHistory] = useState<BalancePoint[]>([]);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('1w');
  const [walletNonce, setWalletNonce] = useState(0); // bump to refetch

  // money modals
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);

  // live marketplace (subgraph)
  const [market, setMarket] = useState<Listing[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);

  // marketplace detail modal
  const [openId, setOpenId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // create-agent form
  const [showNew, setShowNew] = useState(false);
  const [nName, setNName] = useState('');
  const [nBudget, setNBudget] = useState('250');
  const [nThreshold, setNThreshold] = useState('100');

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  useEffect(() => {
    try {
      const s = localStorage.getItem('sovereign_org');
      if (s) setOrg(s);
      const a = localStorage.getItem('sovereign_agents');
      if (a) setAgents(JSON.parse(a));
      const w = localStorage.getItem('sovereign_allowlist');
      if (w) setAllowlist(JSON.parse(w));
    } catch {}
    setOrgReady(true);
    setPolicyReady(true);
  }, []);

  // Persist buyer policy + allowlist locally so limits survive a reload.
  useEffect(() => {
    if (!policyReady) return;
    try {
      localStorage.setItem('sovereign_agents', JSON.stringify(agents));
      localStorage.setItem('sovereign_allowlist', JSON.stringify(allowlist));
    } catch {}
  }, [agents, allowlist, policyReady]);

  useEffect(() => {
    let alive = true;
    setMarketLoading(true);
    setMarketError(null);
    fetchMarket()
      .then((rows) => { if (alive) { setMarket(rows); setMarketLoading(false); } })
      .catch(() => { if (alive) { setMarketError('Could not reach the subgraph.'); setMarketLoading(false); } });
    return () => { alive = false; };
  }, []);

  // Live balance + transaction history for the embedded wallet (drives the
  // Overview chart and the activity feed from one fetch). Refetched on demand
  // after a withdrawal via walletNonce.
  useEffect(() => {
    if (!walletAddress) return;
    let alive = true;
    setWalletLoading(true);
    setWalletError(null);
    fetchWalletData(walletAddress)
      .then(({ balance, txs, history }) => { if (alive) { setBalance(balance); setTxs(txs); setHistory(history); setWalletLoading(false); } })
      .catch(() => { if (alive) { setWalletError('Could not reach the Arc explorer.'); setWalletLoading(false); } });
    return () => { alive = false; };
  }, [walletAddress, walletNonce]);

  // Refetch when the tab regains focus (e.g. returning from the faucet), so new
  // deposits appear without a manual reload.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') setWalletNonce((n) => n + 1); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const series = useMemo(() => buildBalanceSeries(history, balance ?? 0, range), [history, balance, range]);
  const feed = useMemo(() => txs.filter((t) => t.ts > 0), [txs]);
  const activeCount = agents.filter((a) => a.status === 'active').length;

  if (!ready || !authenticated || !orgReady) return null;

  // ---------- Onboarding ----------
  if (!org) {
    return <Onboarding user={user} logout={logout} onDone={(name) => { try { localStorage.setItem('sovereign_org', name); } catch {} setOrg(name); }} />;
  }

  const setCap = (id: string, v: string) =>
    setAllowlist((list) => list.map((w) => (w.id === id ? { ...w, cap: Number(v) || 0 } : w)));
  const removeWl = (id: string) => setAllowlist((list) => list.filter((w) => w.id !== id));

  const createAgent = () => {
    if (!nName.trim()) return;
    const hex = '0x' + Math.random().toString(16).slice(2, 6) + Math.random().toString(16).slice(2, 6) + Math.random().toString(16).slice(2, 6);
    setAgents((list) => [
      ...list,
      { id: 'ag_' + Date.now(), name: nName.trim(), wallet: hex.padEnd(22, '0'), dailyBudget: Number(nBudget) || 0, perAction: Math.round((Number(nBudget) || 0) / 5), approvalThreshold: Number(nThreshold) || 0, allowlist: 0, spentToday: 0, status: 'active' },
    ]);
    setNName(''); setNBudget('250'); setNThreshold('100'); setShowNew(false); setTab('agents');
  };

  const openListing = market.find((l) => l.id === openId) || null;
  const filtered = market.filter((l) => (l.name + ' ' + l.summary + ' ' + l.tags + ' ' + l.owner).toLowerCase().includes(q.trim().toLowerCase()));
  const toggleAgent = (id: string) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a)));
  const isAllowlisted = (id: string) => allowlist.some((w) => w.listingId === id);
  const addToAllowlist = (l: Listing) => {
    if (isAllowlisted(l.id)) return;
    setAllowlist((list) => [...list, { id: 'wl_' + l.id, listingId: l.id, name: l.name, address: l.payTo, cap: 5 }]);
  };

  const reloadWallet = () => setWalletNonce((n) => n + 1);
  // Native USDC transfer signed by the embedded wallet on Arc. Arc's native value
  // fields are 18-decimal wei, so encode with parseUnits (exact BigInt, no float).
  const withdraw = async (to: string, amount: number): Promise<string> => {
    if (!walletAddress) throw new Error('No wallet');
    const base = parseUnits(String(amount), 18);
    const { hash } = await sendTransaction(
      { to, value: '0x' + base.toString(16), chainId: ARC_CHAIN_ID },
      { address: walletAddress }
    );
    reloadWallet();
    return hash;
  };

  // Buyer→seller settlement: native USDC value transfer on Arc, same
  // signing path as withdraw. 18-dp here (native value).
  // The HirePayModal enforces the spend policy before this runs. On
  // success we roll the paying agent's spentToday forward.
  const payWorker = async (l: Listing, agentId: string): Promise<string> => {
    if (!walletAddress) throw new Error('No wallet');
    const base = parseUnits(l.price || '0', 18);
    const { hash } = await sendTransaction(
      { to: l.payTo, value: '0x' + base.toString(16), chainId: ARC_CHAIN_ID },
      { address: walletAddress }
    );
    setAgents((list) => list.map((a) => (a.id === agentId ? { ...a, spentToday: +(a.spentToday + Number(l.price || 0)).toFixed(6) } : a)));
    reloadWallet();
    return hash;
  };
  const hireListing = market.find((l) => l.id === hireId) || null;
  const editAgent = agents.find((a) => a.id === editAgentId) || null;

  const NAV: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Agents' },
    { id: 'marketplace', label: 'Marketplace' },
    { id: 'allowlist', label: 'Allowlist' },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-hairline bg-panel px-4 py-5 mt-1">
        <div className="px-2">
          <Brand />
        </div>
        <nav className="mt-6 flex flex-col gap-1">
          {NAV.map((n) => {
            const on = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => { setTab(n.id); setSellerId(null); }}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${on ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-hairline pt-4">
          <div className="px-3 text-sm font-medium">{org}</div>
          {walletAddress ? (
            <div className="px-3"><Copyable value={walletAddress} className="font-mono text-[11px] text-muted hover:text-foreground">{short(walletAddress)}</Copyable></div>
          ) : (
            <div className="truncate px-3 font-mono text-[11px] text-muted">{user?.email?.address ?? 'account'}</div>
          )}
          <button onClick={() => router.push('/seller')} className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-foreground">Switch to selling →</button>
          <button onClick={logout} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-red-400">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">

          {tab === 'overview' && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
                  <p className="mt-1 text-sm text-muted">Everything your agents are spending, under your rules.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowDeposit(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">Add funds</button>
                  <button onClick={() => setShowWithdraw(true)} className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted transition-colors hover:text-foreground">Withdraw</button>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Treasury" value={balance === null ? '—' : formatUsdc(balance)} sub={walletError ? 'balance unavailable' : 'USDC on Arc'} />
                <Stat label="Active agents" value={String(activeCount)} sub={`${agents.length} total`} />
                <Stat label="Allowlisted" value={String(allowlist.length)} sub="trusted workers" />
              </div>

              <BalanceCard series={series} range={range} setRange={setRange} loading={walletLoading} error={walletError} hasWallet={!!walletAddress} onAdd={() => setShowDeposit(true)} />

              <ActivityFeed items={feed} loading={walletLoading} error={walletError} />
            </>
          )}

          {tab === 'agents' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
                  <p className="mt-1 text-sm text-muted">Each agent has a wallet with rules you set.</p>
                </div>
                <button onClick={() => setShowNew(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">New agent</button>
              </div>


              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {agents.map((a) => (
                  <div key={a.id} className="rounded-xl border border-hairline bg-panel p-5">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{a.name}</div>
                      <Pill kind={a.status} />
                    </div>
                    <Copyable value={a.wallet} className="mt-1 font-mono text-[11px] text-muted hover:text-foreground">{short(a.wallet)}</Copyable>
                    <div className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
                      <div className="text-muted">Daily budget</div><div className="text-right font-mono">${a.dailyBudget}</div>
                      <div className="text-muted">Per action</div><div className="text-right font-mono">${a.perAction}</div>
                      <div className="text-muted">Approval over</div><div className="text-right font-mono">${a.approvalThreshold}</div>
                      <div className="text-muted">Allowlist</div><div className="text-right font-mono">{a.allowlist}</div>
                    </div>
                    <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (a.spentToday / a.dailyBudget) * 100 || 0)}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted">${a.spentToday} of ${a.dailyBudget} today</div>
                    <div className="mt-4 rounded-lg border border-hairline bg-background px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-muted">Connect this agent to Claude</div>
                      <Copyable value={`claude mcp add sovereign --transport http https://mcp.sovereign.sh -H "x-agent-token: sk_${a.id}"`} className="mt-1 break-all font-mono text-[11px] text-muted hover:text-foreground">claude mcp add sovereign … sk_{a.id}</Copyable>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => setEditAgentId(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">Edit limits</button>
                      <button onClick={() => toggleAgent(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">{a.status === 'active' ? 'Pause agent' : 'Resume agent'}</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'marketplace' && (
            <>
              {sellerId ? (
                <>
                  <button onClick={() => setSellerId(null)} className="text-sm text-muted transition-colors hover:text-foreground">← Back to marketplace</button>
                  <div className="mt-4 flex items-center gap-4">
                    <Avatar name={sellerId} size={56} />
                    <div>
                      <h1 className="font-mono text-xl font-semibold tracking-tight">{short(sellerId)}</h1>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 text-muted"><span className="inline-block h-1.5 w-1.5 rounded-full bg-muted" />World ID check pending</span>
                        <Copyable value={sellerId} className="font-mono text-muted hover:text-foreground">{short(sellerId)}</Copyable>
                      </div>
                    </div>
                  </div>
                  <p className="mt-6 text-sm text-muted">Agents published by this wallet</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {market.filter((l) => l.owner === sellerId).map((l) => (
                      <div key={l.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                        <Cover name={l.name} />
                        <div className="p-5">
                          <div className="font-medium">{l.name}</div>
                          <div className="mt-1 truncate text-xs text-muted">{l.summary}</div>
                          <div className="mt-4 flex items-center justify-between">
                            <span className="font-mono text-sm">{l.price}<span className="text-muted"> USDC/call</span></span>
                            <button onClick={() => setOpenId(l.id)} className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground">Details<ArrowUpRight /></button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
              <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
              <p className="mt-1 text-sm text-muted">Workers your agents can hire — live from the on-chain registry.</p>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" className="mt-6 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm outline-none focus:border-accent" />
              {marketLoading && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">Loading agents from the subgraph…</div>}
              {!marketLoading && marketError && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-red-400">{marketError}</div>}
              {!marketLoading && !marketError && market.length === 0 && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">No agents registered on-chain yet.</div>}
              {!marketLoading && !marketError && market.length > 0 && filtered.length === 0 && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">No agents match “{q}”.</div>}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {filtered.map((l) => (
                  <div key={l.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                    <Cover name={l.name} />
                    <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <button onClick={() => setSellerId(l.owner)} aria-label="View seller profile" className="shrink-0">
                          <Avatar name={l.owner} />
                        </button>
                        <div>
                          <div className="font-medium">{l.name}</div>
                          <div className="text-xs text-muted">by <button onClick={() => setSellerId(l.owner)} className="font-mono underline underline-offset-2 hover:text-foreground">{short(l.owner)}</button></div>
                        </div>
                      </div>
                      <button
                        onClick={() => setOpenId(l.id)}
                        className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground"
                      >
                        Details
                        <ArrowUpRight />
                      </button>
                    </div>
                    {l.tags && (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {l.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4).map((t) => (
                          <span key={t} className="rounded-full border border-hairline bg-background px-2 py-0.5 font-mono text-[10px] text-muted">{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="mt-4 flex items-center justify-between gap-2">
                      <span className="font-mono text-sm">{l.price}<span className="text-muted"> USDC/call</span></span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => addToAllowlist(l)}
                          disabled={isAllowlisted(l.id)}
                          className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${isAllowlisted(l.id) ? 'cursor-default border border-accent text-accent opacity-70' : 'border border-hairline text-muted hover:text-foreground'}`}
                        >
                          {isAllowlisted(l.id) ? 'Allowlisted ✓' : 'Add to allowlist'}
                        </button>
                        <button onClick={() => setHireId(l.id)} className="rounded-lg bg-accent px-3 py-1.5 text-sm text-black transition-opacity hover:opacity-90">Hire &amp; pay</button>
                      </div>
                    </div>
                    </div>
                  </div>
                ))}
              </div>
                </>
              )}
            </>
          )}

          {tab === 'allowlist' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Allowlist</h1>
              <p className="mt-1 text-sm text-muted">Trusted workers your agents can pay without asking.</p>
              {allowlist.length === 0 ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">No workers allowlisted yet. Add them from the Marketplace.</div>
              ) : (
                <div className="mt-6 flex flex-col gap-3">
                  {allowlist.map((w) => (
                    <div key={w.id} className="rounded-xl border border-hairline bg-panel p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar name={w.name} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{w.name}</div>
                            <button onClick={() => setOpenId(w.listingId)} className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground">Details<ArrowUpRight /></button>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-2 text-sm">
                            <span className="text-muted">Daily limit per call</span>
                            <span className="flex items-center rounded-lg border border-hairline bg-background pl-2 focus-within:border-accent">
                              <span className="text-sm text-muted">$</span>
                              <input value={String(w.cap)} onChange={(e) => setCap(w.id, e.target.value)} inputMode="decimal" className="w-16 bg-transparent px-1.5 py-1.5 text-sm outline-none" />
                            </span>
                          </label>
                          <button onClick={() => removeWl(w.id)} className="text-sm text-muted transition-colors hover:text-red-400">Remove</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

        </div>
      </main>

      {/* Click modal — MCP details + allowlist */}
      {openListing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={() => setOpenId(null)}>
          <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpenId(null)} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
            <McpDetails l={openListing} />
            <div className="mt-5 flex items-center gap-2">
              <button
                onClick={() => addToAllowlist(openListing)}
                disabled={isAllowlisted(openListing.id)}
                className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${isAllowlisted(openListing.id) ? 'cursor-default border border-accent text-accent opacity-70' : 'border border-hairline text-muted hover:text-foreground'}`}
              >
                {isAllowlisted(openListing.id) ? 'Allowlisted ✓' : 'Add to allowlist'}
              </button>
              <button
                onClick={() => { const id = openListing.id; setOpenId(null); setHireId(id); }}
                className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
              >
                Hire &amp; pay
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New agent modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={() => setShowNew(false)}>
          <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowNew(false)} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
            </button>
            <h2 className="text-lg font-semibold tracking-tight">New agent</h2>
            <p className="mt-1 text-sm text-muted">Give it a wallet and the rules it spends under.</p>
            <div className="mt-5 flex flex-col gap-3">
              <label className="text-sm">
                <span className="text-muted">Name</span>
                <input autoFocus value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Marketing Agent" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" />
              </label>
              <label className="text-sm">
                <span className="text-muted">Daily budget (USDC)</span>
                <input value={nBudget} onChange={(e) => setNBudget(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" />
              </label>
              <label className="text-sm">
                <span className="text-muted">Approval over (USDC)</span>
                <input value={nThreshold} onChange={(e) => setNThreshold(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" />
              </label>
            </div>
            <div className="mt-5 flex gap-3">
              <button onClick={createAgent} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Create agent</button>
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Add funds (deposit) modal */}
      {showDeposit && (
        <DepositModal address={walletAddress} onFunded={reloadWallet} onClose={() => setShowDeposit(false)} />
      )}

      {/* Withdraw modal */}
      {showWithdraw && (
        <WithdrawModal address={walletAddress} balance={balance} onWithdraw={withdraw} onClose={() => setShowWithdraw(false)} />
      )}

      {/* Hire & pay a worker, gated by the buyer spend policy */}
      {hireListing && (
        <HirePayModal listing={hireListing} agents={agents} allowlist={allowlist} onPay={payWorker} onClose={() => setHireId(null)} />
      )}

      {/* Edit a buyer agent's spend limits */}
      {editAgent && (
        <EditAgentModal
          agent={editAgent}
          onSave={(patch) => setAgents((list) => list.map((a) => (a.id === editAgent.id ? { ...a, ...patch } : a)))}
          onClose={() => setEditAgentId(null)}
        />
      )}
    </div>
  );
}

function Onboarding({ user, logout, onDone }: { user: any; logout: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  // Same resolution as the dashboard: the embedded wallet is the treasury, even
  // when the user signed in through MetaMask.
  const onboardingWallet = useEmbeddedWallet();
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7">
        <Brand />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Create your Treasury Wallet</h1>
        <p className="mt-2 text-sm text-muted">This is the account your agents and their spending rules live under.</p>
        <label className="mt-6 block text-sm">
          <span className="text-muted">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onDone(name.trim()); }} />
        </label>
        <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-muted">Treasury wallet</div>
          {onboardingWallet.address ? (
            <Copyable value={onboardingWallet.address} className="mt-0.5 break-all font-mono text-xs hover:text-foreground">{onboardingWallet.address}</Copyable>
          ) : (
            <div className="mt-0.5 font-mono text-xs text-muted">
              {onboardingWallet.creating ? 'creating your wallet…' : 'created on continue'}
            </div>
          )}
        </div>
        <button disabled={!name.trim()} onClick={() => onDone(name.trim())} className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
          Continue
        </button>
        <button onClick={logout} className="mt-3 w-full text-center text-xs text-muted hover:text-foreground">Sign out</button>
      </div>
    </div>
  );
}

// Centered message overlay for chart loading/error/empty states.
function CenterNote({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className={`flex h-full items-center justify-center px-6 text-center text-sm ${tone === 'error' ? 'text-red-400' : 'text-muted'}`}>
      <div>{children}</div>
    </div>
  );
}

const AXIS = { stroke: '#8a8a8a', fontSize: 12, tickLine: false, axisLine: false } as const;
const TOOLTIP_STYLE = {
  contentStyle: { background: '#0b0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e5e5e5' },
  itemStyle: { color: '#e5e5e5' },
} as const;

// Treasury balance over a selectable time range, rendered as an area. Deposits push
// it up, spend/withdrawals pull it down; the final point is anchored to the true
// current balance. When the wallet's history is shorter than a requested long range
// (6M/1Y/5Y) the lib falls back to all-time and we surface a small note.
function BalanceCard({
  series, range, setRange, loading, error, hasWallet, onAdd,
}: {
  series: ReturnType<typeof buildBalanceSeries>;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  loading: boolean;
  error: string | null;
  hasWallet: boolean;
  onAdd: () => void;
}) {
  const empty = !loading && !error && series.latest === 0 && series.points.every((p) => p.usdc === 0);
  const yfmt = (v: number) => formatUsdc(v);

  return (
    <div className="mt-8 rounded-xl border border-hairline bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Balance</span>
          {!loading && !error && (
            <span className="font-mono text-[11px] text-muted">{formatUsdc(series.latest)} USDC</span>
          )}
          {series.fellBack && (
            <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] text-muted">
              under 5 years — showing 5-year view
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${range === r.key ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="h-64 px-4 py-4">
        {loading ? (
          <CenterNote>Loading balance from Arc…</CenterNote>
        ) : error ? (
          <CenterNote tone="error">{error}</CenterNote>
        ) : empty ? (
          <CenterNote>
            No balance yet.{' '}
            {hasWallet && (
              <button onClick={onAdd} className="text-accent underline underline-offset-2">Add funds</button>
            )}{' '}
            to get started.
          </CenterNote>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.points} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
              <defs>
                <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2FFF00" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#2FFF00" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={20} />
              <YAxis {...AXIS} width={56} tickFormatter={yfmt} />
              <Tooltip cursor={{ stroke: 'rgba(255,255,255,0.15)' }} {...TOOLTIP_STYLE} formatter={(v) => [`${formatUsdc(Number(v))} USDC`, 'Balance'] as [string, string]} />
              <Area type="monotone" dataKey="usdc" stroke="#2FFF00" strokeWidth={2} fill="url(#balFill)" dot={false} activeDot={{ r: 3 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZES = [5, 20, 50];

// Compact page-number list with ellipses, e.g. 1 … 4 [5] 6 … 12.
function pageList(current: number, count: number): (number | '…')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const lo = Math.max(2, current - 1);
  const hi = Math.min(count - 1, current + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < count - 1) out.push('…');
  out.push(count);
  return out;
}

// Live activity feed — native USDC transfers to/from the wallet, newest first,
// with a page-size toggle and page-by-page navigation.
function ActivityFeed({ items, loading, error }: { items: ArcTx[]; loading: boolean; error: string | null }) {
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(1);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (page > pageCount) setPage(1); }, [pageCount, page]);

  const start = (page - 1) * pageSize;
  const rows = items.slice(start, start + pageSize);

  return (
    <div className="mt-8 rounded-xl border border-hairline bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <span className="text-sm font-medium">Recent activity</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted">Show Items </span>
          <div className="flex items-center gap-0.5">
            {PAGE_SIZES.map((n) => (
              <button
                key={n}
                onClick={() => { setPageSize(n); setPage(1); }}
                className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${pageSize === n ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="px-5 py-8 text-center text-sm text-muted">Loading transactions…</div>
      ) : error ? (
        <div className="px-5 py-8 text-center text-sm text-red-400">{error}</div>
      ) : total === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">No transactions yet.</div>
      ) : (
        <>
          {rows.map((t) => {
            const inbound = t.direction === 'in';
            const counterparty = inbound ? t.from : t.to ?? 'contract';
            const kind = t.status === 'error' ? 'failed' : inbound ? 'received' : 'sent';
            const isTransfer = t.value > 0;
            // A value-0 outgoing tx is a contract call (e.g. registering an agent),
            // not a payment — label it by method and show the gas it cost.
            const action = isTransfer ? (inbound ? 'Received from' : 'Sent to') : (t.method || 'Contract call') + ' ·';
            const amount = isTransfer
              ? `${inbound ? '+' : '−'}${formatUsdc(t.value)} USDC`
              : t.fee > 0 ? `${formatUsdc(t.fee)} gas` : '—';
            return (
              <div key={t.hash + ':' + t.from + ':' + t.value + ':' + t.ts} className="flex items-center justify-between border-b border-hairline px-5 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate">
                    {action}{' '}
                    <a href={txUrl(t.hash)} target="_blank" rel="noreferrer" className="font-mono text-muted underline-offset-2 hover:text-foreground hover:underline">
                      {shortHash(counterparty)}
                    </a>
                  </div>
                  <div className="font-mono text-[11px] text-muted">{relTime(t.ts)}</div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-sm">{amount}</span>
                  <Pill kind={kind} />
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[11px] text-muted">
            <span className="font-mono">{start + 1}–{Math.min(start + pageSize, total)} of {total}</span>
            {pageCount > 1 && (
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="rounded-md px-2 py-1 font-mono transition-colors hover:text-foreground disabled:opacity-30"
                >
                  ‹
                </button>
                {pageList(page, pageCount).map((p, i) =>
                  p === '…' ? (
                    <span key={'e' + i} className="px-1.5 font-mono text-muted">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`rounded-md px-2 py-1 font-mono transition-colors ${page === p ? 'bg-[#1c1c1c] text-foreground' : 'hover:text-foreground'}`}
                    >
                      {p}
                    </button>
                  )
                )}
                <button
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={page === pageCount}
                  className="rounded-md px-2 py-1 font-mono transition-colors hover:text-foreground disabled:opacity-30"
                >
                  ›
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Reusable centered modal frame with a close button.
function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
        {children}
      </div>
    </div>
  );
}

// Add funds — on Arc testnet the only source of USDC is Circle's faucet, so this
// shows a QR + deposit address and watches the balance until the transfer lands.
// (On a Privy-supported mainnet a native funding provider could slot in here.)
function DepositModal({ address, onFunded, onClose }: { address: string | null; onFunded: () => void; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [received, setReceived] = useState<number | null>(null); // amount detected

  // Render a QR of the address.
  useEffect(() => {
    if (!address) return;
    let alive = true;
    QRCode.toDataURL(address, { margin: 1, width: 240, color: { dark: '#0a0a0a', light: '#ffffff' } })
      .then((url) => { if (alive) setQr(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  // Watch the balance; when it rises, surface the received amount and refresh the
  // dashboard behind the modal.
  useEffect(() => {
    if (!address) return;
    let alive = true;
    let baseline: number | null = null;
    const tick = async () => {
      try {
        const bal = await fetchBalance(address);
        if (!alive) return;
        if (baseline === null) { baseline = bal; return; }
        if (bal > baseline + 1e-9) {
          setReceived(+(bal - baseline).toFixed(6));
          onFunded();
          baseline = bal;
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(id); };
  }, [address, onFunded]);

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Add funds</h2>
      <p className="mt-1 text-sm text-muted">Send USDC to your treasury wallet on Arc. On testnet, mint free USDC from Circle&apos;s faucet, then send it to this address.</p>

      {received !== null && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Received +{formatUsdc(received)} USDC
        </div>
      )}

      <div className="mt-5 flex flex-col items-center gap-3">
        {qr ? (
          <img src={qr} alt="Deposit address QR" width={168} height={168} className="rounded-lg" />
        ) : (
          <div className="h-[168px] w-[168px] animate-pulse rounded-lg bg-[#1c1c1c]" />
        )}
      </div>

      <div className="mt-4 rounded-lg border border-hairline bg-background p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Your wallet address (Arc)</div>
        {address ? (
          <Copyable value={address} className="mt-1 break-all font-mono text-xs text-muted hover:text-foreground">{address}</Copyable>
        ) : (
          <div className="mt-1 font-mono text-xs text-muted">wallet not ready</div>
        )}
      </div>

      <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="mt-3 block w-full rounded-lg bg-accent px-4 py-2.5 text-center text-sm font-medium text-black transition-opacity hover:opacity-90">
        Open Circle faucet →
      </a>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] leading-snug text-muted">
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted" />
        Waiting for a deposit — this updates automatically when funds land.
      </p>
    </ModalShell>
  );
}

// Withdraw — a native USDC transfer signed by the embedded wallet.
function WithdrawModal({
  address, balance, onWithdraw, onClose,
}: {
  address: string | null;
  balance: number | null;
  onWithdraw: (to: string, amount: number) => Promise<string>;
  onClose: () => void;
}) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [hash, setHash] = useState<string | null>(null);

  const amt = Number(amount);
  const validTo = /^0x[a-fA-F0-9]{40}$/.test(to.trim());
  const validAmt = amount !== '' && amt > 0 && (balance === null || amt <= balance);
  const canSend = validTo && validAmt && !busy;

  const submit = async () => {
    setErr(null);
    if (!canSend) return;
    setBusy(true);
    try {
      const h = await onWithdraw(to.trim(), amt);
      setHash(h);
      setDone(true);
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Withdraw</h2>
      {done ? (
        <>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            Sent {formatUsdc(amt)} USDC
          </div>
          <p className="mt-3 text-sm text-muted">To <span className="font-mono">{shortHash(to.trim())}</span>. Your balance will update shortly.</p>
          {hash && (
            <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
              View on Arcscan <ArrowUpRight />
            </a>
          )}
          <button onClick={onClose} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Done</button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">Send USDC from your treasury to any Arc address. Signed by your embedded wallet.</p>
          <div className="mt-2 text-[11px] text-muted">Available: <span className="font-mono text-foreground">{balance === null ? '—' : formatUsdc(balance)} USDC</span></div>

          <div className="mt-4 flex flex-col gap-3">
            <label className="text-sm">
              <span className="text-muted">Destination address</span>
              <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
              {to !== '' && !validTo && <span className="mt-1 block text-[11px] text-red-400">Not a valid address.</span>}
            </label>
            <label className="text-sm">
              <span className="text-muted">Amount (USDC)</span>
              <span className="mt-1 flex items-center rounded-lg border border-hairline bg-background pr-2 focus-within:border-accent">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full bg-transparent px-3 py-2 text-sm outline-none" />
                {balance !== null && (
                  <button type="button" onClick={() => setAmount(String(balance))} className="rounded-md px-2 py-1 font-mono text-[11px] text-muted hover:text-foreground">MAX</button>
                )}
              </span>
              {amount !== '' && amt > 0 && balance !== null && amt > balance && <span className="mt-1 block text-[11px] text-red-400">Exceeds your balance.</span>}
            </label>
          </div>

          {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

          <div className="mt-5 flex gap-3">
            <button disabled={!canSend} onClick={submit} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? 'Confirm in wallet…' : 'Withdraw'}
            </button>
            <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// Hire a marketplace worker and settle in USDC on Arc, but only
// after the selected buyer agent's spend policy clears. A call at/above the
// approval threshold needs an explicit tick before it can send.
function HirePayModal({
  listing, agents, allowlist, onPay, onClose,
}: {
  listing: Listing;
  agents: BuyerAgent[];
  allowlist: AllowEntry[];
  onPay: (l: Listing, agentId: string) => Promise<string>;
  onClose: () => void;
}) {
  const price = Number(listing.price || 0);
  const [agentId, setAgentId] = useState(agents.find((a) => a.status === 'active')?.id ?? agents[0]?.id ?? '');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const agent = agents.find((a) => a.id === agentId) || null;
  const verdict: PolicyVerdict = agent
    ? checkPolicy(agent, price, listing.payTo, allowlist)
    : { ok: false, reason: 'No agent selected.' };
  const needsApproval = verdict.ok && verdict.needsApproval;
  const canPay = verdict.ok && !busy && (!needsApproval || approved);

  const submit = async () => {
    if (!canPay || !agent) return;
    setErr(null);
    setBusy(true);
    try {
      setHash(await onPay(listing, agent.id));
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Hire &amp; pay</h2>
      {hash ? (
        <>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            Paid {formatUsdc(price)} USDC to {listing.name}
          </div>
          <p className="mt-3 text-sm text-muted">To <span className="font-mono">{shortHash(listing.payTo)}</span>. Both dashboards update shortly.</p>
          <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
            View on Arcscan <ArrowUpRight />
          </a>
          <button onClick={onClose} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Done</button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">A real USDC transfer on Arc from your treasury to the worker&apos;s payout address.</p>
          <div className="mt-4 rounded-lg border border-hairline bg-background p-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted">Worker</span><span>{listing.name}</span></div>
            <div className="mt-1 flex items-center justify-between"><span className="text-muted">Pays to</span><span className="font-mono text-xs">{shortHash(listing.payTo)}</span></div>
            <div className="mt-1 flex items-center justify-between"><span className="text-muted">Price</span><span className="font-mono">{listing.price} USDC</span></div>
          </div>

          <label className="mt-4 block text-sm">
            <span className="text-muted">Paying agent</span>
            <select
              value={agentId}
              onChange={(e) => { setAgentId(e.target.value); setApproved(false); }}
              className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          {agent && (
            <div className="mt-2 text-[11px] text-muted">
              per-action ${agent.perAction} · today ${agent.spentToday}/${agent.dailyBudget} · approval over ${agent.approvalThreshold}
            </div>
          )}

          {!verdict.ok && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400" />
              Blocked by policy — {verdict.reason}
            </div>
          )}
          {needsApproval && (
            <label className="mt-3 flex items-start gap-2 rounded-lg border border-hairline bg-background px-3 py-2 text-[11px] text-muted">
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-0.5" />
              This call is at or above your approval threshold. I approve this spend.
            </label>
          )}
          {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

          <div className="mt-5 flex gap-3">
            <button disabled={!canPay} onClick={submit} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? 'Confirm in wallet…' : `Pay ${listing.price} USDC`}
            </button>
            <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function EditAgentModal({
  agent, onSave, onClose,
}: {
  agent: BuyerAgent;
  onSave: (patch: Partial<BuyerAgent>) => void;
  onClose: () => void;
}) {
  const [dailyBudget, setDailyBudget] = useState(String(agent.dailyBudget));
  const [perAction, setPerAction] = useState(String(agent.perAction));
  const [approvalThreshold, setApprovalThreshold] = useState(String(agent.approvalThreshold));

  const save = () => {
    onSave({
      dailyBudget: Number(dailyBudget) || 0,
      perAction: Number(perAction) || 0,
      approvalThreshold: Number(approvalThreshold) || 0,
    });
    onClose();
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Edit limits</h2>
      <p className="mt-1 text-sm text-muted">Spending rules for {agent.name}. Enforced before every hire.</p>
      <div className="mt-5 flex flex-col gap-3">
        <label className="text-sm"><span className="text-muted">Daily budget (USDC)</span>
          <input value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
        <label className="text-sm"><span className="text-muted">Per action (USDC)</span>
          <input value={perAction} onChange={(e) => setPerAction(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
        <label className="text-sm"><span className="text-muted">Require approval over (USDC)</span>
          <input value={approvalThreshold} onChange={(e) => setApprovalThreshold(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
      </div>
      <div className="mt-5 flex gap-3">
        <button onClick={save} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90">Save limits</button>
        <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
      </div>
    </ModalShell>
  );
}

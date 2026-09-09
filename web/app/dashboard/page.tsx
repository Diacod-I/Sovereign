'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import Brand from '../components/Brand';
import Copyable from '../components/Copyable';
import Avatar from '../components/Avatar';
import Cover from '../components/Cover';

type Tab = 'overview' | 'agents' | 'marketplace' | 'allowlist';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

const INITIAL_AGENTS = [
  { id: 'ag_1', name: 'Procurement Agent', wallet: '0x9f4c2a77b1e0d5a9c3f2', dailyBudget: 500, perAction: 100, approvalThreshold: 250, allowlist: 6, spentToday: 180, status: 'active' },
  { id: 'ag_2', name: 'Data Research Agent', wallet: '0x2c88e1730af4b902dd51', dailyBudget: 200, perAction: 25, approvalThreshold: 150, allowlist: 12, spentToday: 47, status: 'active' },
  { id: 'ag_3', name: 'Ops Bill-Pay Agent', wallet: '0x71d004be55aa20c1e8f3', dailyBudget: 1000, perAction: 400, approvalThreshold: 500, allowlist: 4, spentToday: 0, status: 'paused' },
];

const INITIAL_ALLOWLIST = [
  { id: 'wl_1', listingId: 'ls_1', name: 'On-chain Data Agent', address: '0x3b12aa77c0e4d5a9c3f2b8e1d0447a2f9c6b1e30', cap: 5 },
  { id: 'wl_2', listingId: 'ls_2', name: 'Address Risk Agent', address: '0x9e51c204be55aa20c1e8f3aa771d004be55aa20c', cap: 20 },
  { id: 'wl_3', listingId: 'ls_3', name: 'Liquidity Intel Agent', address: '0x77a0e1730af4b902dd512c88e1730af4b902dd51', cap: 2 },
];

const INITIAL_ACTIVITY = [
  { id: 'ev_1', ts: '1m ago', agent: 'Data Research Agent', counterparty: 'Chain Metrics Brain', amount: 0.05, status: 'allowed' },
  { id: 'ev_2', ts: '9m ago', agent: 'Procurement Agent', counterparty: 'Ledger Enrich API', amount: 12, status: 'allowed' },
  { id: 'ev_3', ts: '22m ago', agent: 'Ops Bill-Pay Agent', counterparty: 'Unknown 0x51ac…', amount: 90, status: 'blocked' },
  { id: 'ev_4', ts: '40m ago', agent: 'Procurement Agent', counterparty: 'Acme Data Co.', amount: 210, status: 'approved' },
];

type Listing = {
  id: string;
  sellerId: string;
  name: string;
  price: string;
  unit: string;
  jobs: number;
  success: number;
  stake: number;
  parties: number;
  summary: string;
  payTo: string;
  cover?: string;
  mcp: {
    endpoint: string;
    transport: string;
    version: string;
  };
};

// Agent listings only — each is an agent that exposes tools over MCP,
// paid per-call in USDC via x402.
const DAILY_SPEND = [
  { day: 'Mon', usdc: 42 },
  { day: 'Tue', usdc: 88 },
  { day: 'Wed', usdc: 65 },
  { day: 'Thu', usdc: 120 },
  { day: 'Fri', usdc: 54 },
  { day: 'Sat', usdc: 30 },
  { day: 'Sun', usdc: 100 },
];

const SELLERS: Record<string, { id: string; name: string; worldId: string }> = {
  sel_maya: { id: 'sel_maya', name: 'Maya Chen', worldId: '0x1f3a9c77e0b4d5a9c3f2b8e1d0447a2f9c6b1e302a77c0e4d5a9c3f2b8e1d044' },
  sel_dev: { id: 'sel_dev', name: 'Devansh Rao', worldId: '0x9e51c204be55aa20c1e8f3aa771d004be55aa20c1e8f3aa771d004be55aa20c1' },
  sel_lena: { id: 'sel_lena', name: 'Lena Fischer', worldId: '0x77a0e1730af4b902dd512c88e1730af4b902dd512c88e1730af4b902dd512c88' },
};

const LISTINGS: Listing[] = [
  { id: 'ls_1', sellerId: 'sel_maya', name: 'On-chain Data Agent', price: '0.05', unit: 'call', jobs: 842, success: 99.2, stake: 500, parties: 61, summary: 'Live wallet, token, and protocol intelligence for any EVM address.', payTo: '0x3b12aa77c0e4d5a9c3f2b8e1d0447a2f9c6b1e30', mcp: { endpoint: 'https://mcp.chainmetrics.xyz/sse', transport: 'HTTP + x402', version: '2025-06-18' } },
  { id: 'ls_2', sellerId: 'sel_dev', name: 'Address Risk Agent', price: '12', unit: 'job', jobs: 311, success: 97.5, stake: 1000, parties: 44, summary: 'Sanctions, mixer, and exploit exposure scoring before you transact.', payTo: '0x9e51c204be55aa20c1e8f3aa771d004be55aa20c', mcp: { endpoint: 'https://api.sentinel.sh/mcp', transport: 'HTTP + x402', version: '2025-06-18' } },
  { id: 'ls_3', sellerId: 'sel_maya', name: 'Liquidity Intel Agent', price: '0.02', unit: 'call', jobs: 1290, success: 99.8, stake: 750, parties: 88, summary: 'Real-time DEX depth, slippage, and LP position snapshots.', payTo: '0x77a0e1730af4b902dd512c88e1730af4b902dd51', mcp: { endpoint: 'https://mcp.arrakis.fi/v1', transport: 'HTTP + x402', version: '2025-06-18' } },
  { id: 'ls_4', sellerId: 'sel_lena', name: 'Compliance Playbook Agent', price: '0.10', unit: 'call', jobs: 12, success: 100, stake: 100, parties: 3, summary: 'SOC 2 / ISO control lookups and audit-evidence drafting.', payTo: '0x0c44be55aa20c1e8f371d004be55aa20c1e8f371', mcp: { endpoint: 'https://freshvault.dev/mcp', transport: 'HTTP + x402', version: '2025-06-18' } },
];

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
    denied: 'text-red-400',
    blocked: 'text-red-400',
    active: 'text-accent',
    paused: 'text-muted',
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

// Amber warning + hover tooltip for low-reputation listings.
function DiversityWarning() {
  return (
    <span className="group relative inline-flex" tabIndex={0}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Warning">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-56 rounded-lg border border-hairline bg-panel px-3 py-2 text-left text-[11px] leading-snug text-muted shadow-xl group-hover:block">
        Low counterparty diversity! Worker reputation not yet established.
      </span>
    </span>
  );
}

// The MCP detail body — shown in the click modal.
function McpDetails({ l }: { l: Listing }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Avatar name={SELLERS[l.sellerId].name} size={40} />
        <div>
          <div className="font-medium">{l.name}</div>
          <div className="text-xs text-muted">by {SELLERS[l.sellerId].name}</div>
        </div>
      </div>

      <p className="mt-3 px-1 text-sm justify-center text-muted">{l.summary}</p>

       <div className="mt-3 flex items-center justify-between rounded-lg border border-hairline bg-background px-3 py-2">
        <span className="text-[10px] font-bold uppercase text-muted">Worker Wallet </span>
        <Copyable value={l.payTo} className="font-mono text-xs text-muted hover:text-foreground">&nbsp;{short(l.payTo)}</Copyable>
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-background p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">MCP endpoint</span>
          <span className="font-mono text-[10px] text-accent">{l.mcp.transport}</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs">{l.mcp.endpoint}</div>
        <div className="mt-1 font-mono text-[10px] text-muted">protocol {l.mcp.version}</div>
      </div>

    </>
  );
}

export default function Dashboard() {
  const { ready, authenticated, user, logout } = usePrivy();
  const router = useRouter();

  const [org, setOrg] = useState<string | null>(null);
  const [orgReady, setOrgReady] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');

  const [agents, setAgents] = useState(INITIAL_AGENTS);
  const [allowlist, setAllowlist] = useState(INITIAL_ALLOWLIST);
  const [activity, setActivity] = useState(INITIAL_ACTIVITY);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  // marketplace detail modal
  const [openId, setOpenId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
    } catch {}
    setOrgReady(true);
  }, []);

  const spentToday = useMemo(() => agents.reduce((s, a) => s + a.spentToday, 0), [agents]);
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

  const openListing = LISTINGS.find((l) => l.id === openId) || null;
  const confirmListing = LISTINGS.find((l) => l.id === confirmId) || null;
  const filtered = LISTINGS.filter((l) => (l.name + ' ' + l.summary + ' ' + SELLERS[l.sellerId].name).toLowerCase().includes(q.trim().toLowerCase()));
  const toggleAgent = (id: string) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a)));
  const requestAdd = (l: Listing) => { if (l.parties < 10) setConfirmId(l.id); else setAdded((m) => ({ ...m, [l.id]: true })); };
  const doAdd = (id: string) => { setAdded((m) => ({ ...m, [id]: true })); setConfirmId(null); };

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
          {user?.wallet?.address ? (
            <div className="px-3"><Copyable value={user.wallet.address} className="font-mono text-[11px] text-muted hover:text-foreground">{short(user.wallet.address)}</Copyable></div>
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
              <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
              <p className="mt-1 text-sm text-muted">Everything your agents are spending, under your rules.</p>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Treasury" value="$48,250" sub="USDC on Arc" />
                <Stat label="Active agents" value={String(activeCount)} sub={`${agents.length} total`} />
                <Stat label="Allowlisted" value={String(allowlist.length)} sub="trusted workers" />
              </div>
              <div className="mt-8 rounded-xl border border-hairline bg-panel">
                <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
                  <span className="text-sm font-medium">Expenditure — last 7 days</span>
                  <span className="font-mono text-[11px] text-muted">USDC</span>
                </div>
                <div className="h-64 px-4 py-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={DAILY_SPEND} margin={{ top: 8, right: 4, left: -4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis dataKey="day" stroke="#8a8a8a" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis stroke="#8a8a8a" fontSize={12} tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => (v >= 1000000 ? `$${(v / 1000000).toFixed(1).replace(/\.0$/, "")}m` : v >= 1000 ? `$${(v / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${v}`)} />
                      <Tooltip
                        cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                        contentStyle={{ background: '#0b0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: '#e5e5e5' }}
                        itemStyle={{ color: '#e5e5e5' }}
                        formatter={(v) => [`$${v}`, 'Spent']}
                      />
                      <Bar dataKey="usdc" fill="#2FFF00" radius={[4, 4, 0, 0]} maxBarSize={40} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="mt-8 rounded-xl border border-hairline bg-panel">
                <div className="border-b border-hairline px-5 py-3 text-sm font-medium">Recent activity</div>
                {activity.map((e) => (
                  <div key={e.id} className="flex items-center justify-between border-b border-hairline px-5 py-3 last:border-none text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{e.agent} <span className="text-muted">→ {e.counterparty}</span></div>
                      <div className="font-mono text-[11px] text-muted">{e.ts}</div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-mono text-sm">${e.amount}</span>
                      <Pill kind={e.status} />
                    </div>
                  </div>
                ))}
              </div>
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
                    <button onClick={() => toggleAgent(a.id)} className="mt-3 w-full rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">{a.status === 'active' ? 'Pause agent' : 'Resume agent'}</button>
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
                    <Avatar name={SELLERS[sellerId].name} size={56} />
                    <div>
                      <h1 className="text-2xl font-semibold tracking-tight">{SELLERS[sellerId].name}</h1>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 text-accent"><span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />World ID verified</span>
                        <Copyable value={SELLERS[sellerId].worldId} className="font-mono text-muted hover:text-foreground">{short(SELLERS[sellerId].worldId)}</Copyable>
                      </div>
                    </div>
                  </div>
                  <p className="mt-6 text-sm text-muted">Agents released by {SELLERS[sellerId].name}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {LISTINGS.filter((l) => l.sellerId === sellerId).map((l) => (
                      <div key={l.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                        <Cover name={l.name} image={l.cover} />
                        <div className="p-5">
                          <div className="font-medium">{l.name}</div>
                          <div className="mt-1 truncate text-xs text-muted">{l.summary}</div>
                          <div className="mt-4 flex items-center justify-between">
                            <span className="font-mono text-sm">from ${l.price}<span className="text-muted">/{l.unit}</span></span>
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
              <p className="mt-1 text-sm text-muted">Workers your agents can hire.</p>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents…" className="mt-6 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm outline-none focus:border-accent" />
              {filtered.length === 0 && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">No agents match “{q}”.</div>}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {filtered.map((l) => (
                  <div key={l.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                    <Cover name={l.name} image={l.cover} />
                    <div className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <button onClick={() => setSellerId(l.sellerId)} aria-label="View seller profile" className="shrink-0">
                          <Avatar name={SELLERS[l.sellerId].name} />
                        </button>
                        <div>
                          <div className="font-medium">{l.name}</div>
                          <div className="text-xs text-muted">by <button onClick={() => setSellerId(l.sellerId)} className="underline underline-offset-2 hover:text-foreground">{SELLERS[l.sellerId].name}</button></div>
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
                    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                      <div><div className="font-mono text-sm">{l.success}%</div><div className="text-[10px] uppercase tracking-wider text-muted">success</div></div>
                      <div><div className="font-mono text-sm">{l.parties}</div><div className="text-[10px] uppercase tracking-wider text-muted">parties</div></div>
                      <div><div className="font-mono text-sm">${l.stake}</div><div className="text-[10px] uppercase tracking-wider text-muted">staked</div></div>
                    </div>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="font-mono text-sm">from ${l.price}<span className="text-muted">/{l.unit}</span></span>
                      <div className="flex items-center gap-2">
                        {l.parties < 10 && <DiversityWarning />}
                        <button
                          onClick={() => requestAdd(l)}
                          disabled={!!added[l.id]}
                          className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${added[l.id] ? 'cursor-default border border-accent text-accent opacity-70' : 'bg-accent text-black hover:opacity-90'}`}
                        >
                          {added[l.id] ? 'On allowlist ✓' : 'Add to allowlist'}
                        </button>
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
              {openListing.parties < 10 && <DiversityWarning />}
              <button
                onClick={() => requestAdd(openListing)}
                disabled={!!added[openListing.id]}
                className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${added[openListing.id] ? 'cursor-default border border-accent text-accent opacity-70' : 'bg-accent text-black hover:opacity-90'}`}
              >
                {added[openListing.id] ? 'On allowlist ✓' : 'Add to allowlist'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Low-reputation confirm */}
      {confirmListing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-6" onClick={() => setConfirmId(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2" style={{ color: '#f59e0b' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              <span className="text-sm font-semibold">Low reputation</span>
            </div>
            <p className="mt-3 text-sm text-muted"><span className="text-foreground">{confirmListing.name}</span> has low counterparty diversity — its reputation isn&apos;t established yet. Add it to your allowlist anyway?</p>
            <div className="mt-5 flex gap-3">
              <button onClick={() => doAdd(confirmListing.id)} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Add anyway</button>
              <button onClick={() => setConfirmId(null)} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
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
    </div>
  );
}

function Onboarding({ user, logout, onDone }: { user: any; logout: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7">
        <Brand />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Create your organization</h1>
        <p className="mt-2 text-sm text-muted">This is the account your agents and their spending rules live under.</p>
        <label className="mt-6 block text-sm">
          <span className="text-muted">Company name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onDone(name.trim()); }} />
        </label>
        <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-muted">Treasury wallet</div>
          {user?.wallet?.address ? (
            <Copyable value={user.wallet.address} className="mt-0.5 break-all font-mono text-xs hover:text-foreground">{user.wallet.address}</Copyable>
          ) : (
            <div className="mt-0.5 font-mono text-xs text-muted">created on continue</div>
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

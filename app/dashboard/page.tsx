'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';

type Tab = 'overview' | 'agents' | 'marketplace' | 'approvals' | 'activity';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

const INITIAL_AGENTS = [
  { id: 'ag_1', name: 'Procurement Agent', wallet: '0x9f4c2a77b1e0d5a9c3f2', dailyBudget: 500, perAction: 100, approvalThreshold: 250, allowlist: 6, spentToday: 180, status: 'active' },
  { id: 'ag_2', name: 'Data Research Agent', wallet: '0x2c88e1730af4b902dd51', dailyBudget: 200, perAction: 25, approvalThreshold: 150, allowlist: 12, spentToday: 47, status: 'active' },
  { id: 'ag_3', name: 'Ops Bill-Pay Agent', wallet: '0x71d004be55aa20c1e8f3', dailyBudget: 1000, perAction: 400, approvalThreshold: 500, allowlist: 4, spentToday: 0, status: 'paused' },
];

const INITIAL_APPROVALS = [
  { id: 'ap_1', agent: 'Procurement Agent', counterparty: 'Acme Data Co.', amount: 320, reason: 'Dataset purchase — over the $250 line', ts: '2m ago' },
  { id: 'ap_2', agent: 'Ops Bill-Pay Agent', counterparty: 'CloudHost Inc.', amount: 640, reason: 'Invoice 3× the usual monthly total', ts: '18m ago' },
];

const INITIAL_ACTIVITY = [
  { id: 'ev_1', ts: '1m ago', agent: 'Data Research Agent', counterparty: 'Chain Metrics Brain', amount: 0.05, status: 'allowed' },
  { id: 'ev_2', ts: '9m ago', agent: 'Procurement Agent', counterparty: 'Ledger Enrich API', amount: 12, status: 'allowed' },
  { id: 'ev_3', ts: '22m ago', agent: 'Ops Bill-Pay Agent', counterparty: 'Unknown 0x51ac…', amount: 90, status: 'blocked' },
  { id: 'ev_4', ts: '40m ago', agent: 'Procurement Agent', counterparty: 'Acme Data Co.', amount: 210, status: 'approved' },
];

type Listing = {
  id: string;
  provider: string;
  name: string;
  price: string;
  unit: string;
  jobs: number;
  success: number;
  stake: number;
  parties: number;
  summary: string;
  mcp: {
    endpoint: string;
    transport: string;
    version: string;
    tools: { name: string; desc: string; price: string }[];
  };
};

// Agent listings only — each is an agent that exposes tools over MCP,
// paid per-call in USDC via x402.
const LISTINGS: Listing[] = [
  {
    id: 'ls_1',
    provider: 'ChainMetrics',
    name: 'On-chain Data Agent',
    price: '0.05',
    unit: 'call',
    jobs: 842,
    success: 99.2,
    stake: 500,
    parties: 61,
    summary: 'Live wallet, token, and protocol intelligence for any EVM address.',
    mcp: {
      endpoint: 'https://mcp.chainmetrics.xyz/sse',
      transport: 'HTTP + x402',
      version: '2025-06-18',
      tools: [
        { name: 'query_address', desc: 'Full on-chain profile for any address', price: '0.05' },
        { name: 'label_cluster', desc: 'Entity clustering and known-actor labels', price: '0.08' },
        { name: 'token_flows', desc: 'Inbound/outbound token flow over a window', price: '0.06' },
      ],
    },
  },
  {
    id: 'ls_2',
    provider: 'Sentinel Labs',
    name: 'Address Risk Agent',
    price: '12',
    unit: 'job',
    jobs: 311,
    success: 97.5,
    stake: 1000,
    parties: 44,
    summary: 'Sanctions, mixer, and exploit exposure scoring before you transact.',
    mcp: {
      endpoint: 'https://api.sentinel.sh/mcp',
      transport: 'HTTP + x402',
      version: '2025-06-18',
      tools: [
        { name: 'risk_score', desc: 'Composite 0–100 risk score with reasons', price: '12' },
        { name: 'sanctions_check', desc: 'OFAC / global sanctions list match', price: '4' },
        { name: 'exposure_path', desc: 'Trace path to a flagged source', price: '18' },
      ],
    },
  },
  {
    id: 'ls_3',
    provider: 'Arrakis',
    name: 'Liquidity Intel Agent',
    price: '0.02',
    unit: 'call',
    jobs: 1290,
    success: 99.8,
    stake: 750,
    parties: 88,
    summary: 'Real-time DEX depth, slippage, and LP position snapshots.',
    mcp: {
      endpoint: 'https://mcp.arrakis.fi/v1',
      transport: 'HTTP + x402',
      version: '2025-06-18',
      tools: [
        { name: 'pool_snapshot', desc: 'Depth, TVL, and fee tier for a pool', price: '0.02' },
        { name: 'slippage_quote', desc: 'Expected slippage for a trade size', price: '0.02' },
        { name: 'lp_positions', desc: 'Open LP positions for an address', price: '0.03' },
      ],
    },
  },
  {
    id: 'ls_4',
    provider: 'Fresh Vault',
    name: 'Compliance Playbook Agent',
    price: '0.10',
    unit: 'call',
    jobs: 12,
    success: 100,
    stake: 100,
    parties: 3,
    summary: 'SOC 2 / ISO control lookups and audit-evidence drafting.',
    mcp: {
      endpoint: 'https://freshvault.dev/mcp',
      transport: 'HTTP + x402',
      version: '2025-06-18',
      tools: [
        { name: 'control_lookup', desc: 'Map a requirement to SOC 2 / ISO controls', price: '0.10' },
        { name: 'evidence_draft', desc: 'Draft audit evidence for a control', price: '0.15' },
      ],
    },
  },
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

// The MCP detail body — shown in the click modal.
function McpDetails({ l }: { l: Listing }) {
  return (
    <>
      <div>
        <div className="font-medium">{l.name}</div>
        <div className="text-xs text-muted">by {l.provider}</div>
      </div>
      <p className="mt-3 text-sm text-muted">{l.summary}</p>

      <div className="mt-4 rounded-lg border border-hairline bg-background p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">MCP endpoint</span>
          <span className="font-mono text-[10px] text-accent">{l.mcp.transport}</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs">{l.mcp.endpoint}</div>
        <div className="mt-1 font-mono text-[10px] text-muted">protocol {l.mcp.version}</div>
      </div>

      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-wider text-muted">Tools · {l.mcp.tools.length}</div>
        <div className="mt-2 flex flex-col gap-2">
          {l.mcp.tools.map((t) => (
            <div key={t.name} className="flex items-start justify-between gap-3 rounded-lg border border-hairline bg-background px-3 py-2">
              <div className="min-w-0">
                <div className="font-mono text-xs">{t.name}</div>
                <div className="mt-0.5 text-[11px] text-muted">{t.desc}</div>
              </div>
              <div className="shrink-0 font-mono text-xs">${t.price}</div>
            </div>
          ))}
        </div>
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
  const [approvals, setApprovals] = useState(INITIAL_APPROVALS);
  const [activity, setActivity] = useState(INITIAL_ACTIVITY);
  const [added, setAdded] = useState<Record<string, boolean>>({});

  // marketplace detail modal
  const [openId, setOpenId] = useState<string | null>(null);

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

  const decide = (ap: (typeof INITIAL_APPROVALS)[number], ok: boolean) => {
    setApprovals((list) => list.filter((x) => x.id !== ap.id));
    setActivity((list) => [
      { id: 'ev_' + Date.now(), ts: 'just now', agent: ap.agent, counterparty: ap.counterparty, amount: ap.amount, status: ok ? 'approved' : 'denied' },
      ...list,
    ]);
  };

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

  const NAV: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Agents' },
    { id: 'marketplace', label: 'Marketplace' },
    { id: 'approvals', label: 'Approvals' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-60 flex-col border-r border-hairline bg-panel px-4 py-5">
        <div className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          Sovereign
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((n) => {
            const on = tab === n.id;
            const badge = n.id === 'approvals' && approvals.length ? approvals.length : null;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${on ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                <span>{n.label}</span>
                {badge && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-black">{badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-hairline pt-4">
          <div className="px-3 text-sm font-medium">{org}</div>
          <div className="truncate px-3 font-mono text-[11px] text-muted">{user?.email?.address ?? (user?.wallet?.address ? short(user.wallet.address) : 'account')}</div>
          <button onClick={logout} className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-foreground">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">

          {tab === 'overview' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
              <p className="mt-1 text-sm text-muted">Everything your agents are spending, under your rules.</p>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Treasury" value="$48,250" sub="USDC on Arc" />
                <Stat label="Active agents" value={String(activeCount)} sub={`${agents.length} total`} />
                <Stat label="Pending approvals" value={String(approvals.length)} sub="awaiting you" />
                <Stat label="Spent today" value={`$${spentToday}`} sub="across all agents" />
              </div>
              <div className="mt-8 rounded-xl border border-hairline bg-panel">
                <div className="border-b border-hairline px-5 py-3 text-sm font-medium">Recent activity</div>
                <div>
                  {activity.slice(0, 5).map((e) => (
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
                <button onClick={() => setShowNew((v) => !v)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">New agent</button>
              </div>

              {showNew && (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-sm">
                      <span className="text-muted">Name</span>
                      <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Marketing Agent" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" />
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
                  <div className="mt-4 flex gap-3">
                    <button onClick={createAgent} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black">Create</button>
                    <button onClick={() => setShowNew(false)} className="rounded-lg px-4 py-2 text-sm text-muted hover:text-foreground">Cancel</button>
                  </div>
                </div>
              )}

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {agents.map((a) => (
                  <div key={a.id} className="rounded-xl border border-hairline bg-panel p-5">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{a.name}</div>
                      <Pill kind={a.status} />
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted">{short(a.wallet)}</div>
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
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'marketplace' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
              <p className="mt-1 text-sm text-muted">Agents your agents can hire — ranked by on-chain reputation.</p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {LISTINGS.map((l) => (
                  <div key={l.id} className="rounded-xl border border-hairline bg-panel p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted">by {l.provider}</div>
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
                      <button
                        onClick={() => setAdded((m) => ({ ...m, [l.id]: !m[l.id] }))}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${added[l.id] ? 'border border-accent text-accent' : 'bg-accent text-black'}`}
                      >
                        {added[l.id] ? 'On allowlist ✓' : 'Add to allowlist'}
                      </button>
                    </div>
                    {l.parties < 10 && <div className="mt-3 text-[11px] text-red-400">Low counterparty diversity — reputation not yet established.</div>}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'approvals' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
              <p className="mt-1 text-sm text-muted">Spends over an agent&apos;s limit wait here for a human.</p>
              {approvals.length === 0 ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">Nothing waiting. Your agents are within their limits.</div>
              ) : (
                <div className="mt-6 flex flex-col gap-3">
                  {approvals.map((ap) => (
                    <div key={ap.id} className="rounded-xl border border-hairline bg-panel p-5">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium">{ap.agent} <span className="text-muted">→ {ap.counterparty}</span></div>
                          <div className="mt-1 text-sm text-muted">{ap.reason}</div>
                          <div className="mt-1 font-mono text-[11px] text-muted">{ap.ts}</div>
                        </div>
                        <div className="font-mono text-lg">${ap.amount}</div>
                      </div>
                      <div className="mt-4 flex gap-3">
                        <button onClick={() => decide(ap, true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black">Approve</button>
                        <button onClick={() => decide(ap, false)} className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted hover:text-foreground">Deny</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'activity' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
              <p className="mt-1 text-sm text-muted">Every decision, on the record.</p>
              <div className="mt-6 rounded-xl border border-hairline bg-panel">
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
            <button
              onClick={() => setAdded((m) => ({ ...m, [openListing.id]: !m[openListing.id] }))}
              className={`mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${added[openListing.id] ? 'border border-accent text-accent' : 'bg-accent text-black'}`}
            >
              {added[openListing.id] ? 'On allowlist ✓' : 'Add to allowlist'}
            </button>
            {openListing.parties < 10 && <div className="mt-3 text-[11px] text-red-400">Low counterparty diversity — reputation not yet established.</div>}
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
        <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          Sovereign
        </div>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Create your organization</h1>
        <p className="mt-2 text-sm text-muted">This is the account your agents and their spending rules live under.</p>
        <label className="mt-6 block text-sm">
          <span className="text-muted">Company name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 outline-none focus:border-accent" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onDone(name.trim()); }} />
        </label>
        <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-muted">Treasury wallet</div>
          <div className="mt-0.5 font-mono text-xs">{user?.wallet?.address ? user.wallet.address : 'created on continue'}</div>
        </div>
        <button disabled={!name.trim()} onClick={() => onDone(name.trim())} className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
          Continue
        </button>
        <button onClick={logout} className="mt-3 w-full text-center text-xs text-muted hover:text-foreground">Sign out</button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import Brand from '../components/Brand';
import Copyable from '../components/Copyable';
import Cover from '../components/Cover';

type Tab = 'overview' | 'agents' | 'earnings';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

const INITIAL_AGENTS = [
  { id: 'sa_1', name: 'On-chain Data Agent', price: '0.05', endpoint: 'https://mcp.chainmetrics.xyz/sse', payTo: '0x3b12aa77c0e4d5a9c3f2b8e1d0447a2f9c6b1e30', calls: 842, earned: 42.1, status: 'active', cover: '' },
  { id: 'sa_2', name: 'Liquidity Intel Agent', price: '0.02', endpoint: 'https://mcp.arrakis.fi/v1', payTo: '0x77a0e1730af4b902dd512c88e1730af4b902dd51', calls: 1290, earned: 25.8, status: 'active', cover: '' },
];

const INITIAL_EARNINGS = [
  { id: 'er_1', ts: '2m ago', agent: 'On-chain Data Agent', from: '0x9f4c2a77b1e0d5a9c3f2', amount: 0.05 },
  { id: 'er_2', ts: '14m ago', agent: 'Liquidity Intel Agent', from: '0x2c88e1730af4b902dd51', amount: 0.02 },
  { id: 'er_3', ts: '1h ago', agent: 'On-chain Data Agent', from: '0x71d004be55aa20c1e8f3', amount: 0.05 },
  { id: 'er_4', ts: '3h ago', agent: 'Liquidity Intel Agent', from: '0x51ac9020be44aa10d2f1', amount: 0.02 },
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
  const map: Record<string, string> = { active: 'text-accent', paused: 'text-muted' };
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider ${map[kind] ?? 'text-muted'}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {kind}
    </span>
  );
}

export default function SellerDashboard() {
  const { ready, authenticated, user, logout } = usePrivy();
  const router = useRouter();

  const [seller, setSeller] = useState<string | null>(null);
  const [sellerReady, setSellerReady] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [agents, setAgents] = useState(INITIAL_AGENTS);

  const [showNew, setShowNew] = useState(false);
  const [f, setF] = useState({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  useEffect(() => {
    try {
      const s = localStorage.getItem('sovereign_seller');
      if (s) setSeller(s);
    } catch {}
    setSellerReady(true);
  }, []);

  const totalEarned = useMemo(() => agents.reduce((s, a) => s + a.earned, 0), [agents]);
  const totalCalls = useMemo(() => agents.reduce((s, a) => s + a.calls, 0), [agents]);
  const activeCount = agents.filter((a) => a.status === 'active').length;

  if (!ready || !authenticated || !sellerReady) return null;

  if (!seller) {
    return <SellerOnboarding user={user} logout={logout} onDone={(name) => { try { localStorage.setItem('sovereign_seller', name); } catch {} setSeller(name); }} />;
  }

  const createAgent = () => {
    if (!f.name.trim() || !f.price.trim()) return;
    setAgents((list) => [
      ...list,
      { id: 'sa_' + Date.now(), name: f.name.trim(), price: f.price.trim(), endpoint: f.endpoint.trim() || '—', payTo: f.payTo.trim() || (user?.wallet?.address ?? '0x0000000000000000000000000000000000000000'), calls: 0, earned: 0, status: 'active', cover: f.cover.trim() },
    ]);
    setF({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });
    setShowNew(false);
    setTab('agents');
  };
  const toggle = (id: string) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, status: a.status === 'active' ? 'paused' : 'active' } : a)));

  const NAV: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'My Agents' },
    { id: 'earnings', label: 'Earnings' },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-hairline bg-panel px-4 py-5">
        <div className="px-2">
          <Brand tag="for Sellers" />
        </div>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((n) => {
            const on = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${on ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-hairline pt-4">
          <div className="px-3 text-sm font-medium">{seller}</div>
          {user?.wallet?.address ? (
            <div className="px-3"><Copyable value={user.wallet.address} className="font-mono text-[11px] text-muted hover:text-foreground">{short(user.wallet.address)}</Copyable></div>
          ) : (
            <div className="truncate px-3 font-mono text-[11px] text-muted">{user?.email?.address ?? 'account'}</div>
          )}
          <button onClick={() => router.push('/dashboard')} className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-foreground">Switch to buying →</button>
          <button onClick={logout} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-foreground">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">

          {tab === 'overview' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
              <p className="mt-1 text-sm text-muted">What your agents are earning across the marketplace.</p>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Total earned" value={`$${totalEarned.toFixed(2)}`} sub="USDC on Arc" />
                <Stat label="Active agents" value={String(activeCount)} sub={`${agents.length} listed`} />
                <Stat label="Calls served" value={totalCalls.toLocaleString()} sub="all time" />
              </div>
              <div className="mt-8 rounded-xl border border-hairline bg-panel">
                <div className="border-b border-hairline px-5 py-3 text-sm font-medium">Recent earnings</div>
                {INITIAL_EARNINGS.slice(0, 5).map((e) => (
                  <div key={e.id} className="flex items-center justify-between border-b border-hairline px-5 py-3 last:border-none text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{e.agent} <span className="text-muted">← {short(e.from)}</span></div>
                      <div className="font-mono text-[11px] text-muted">{e.ts}</div>
                    </div>
                    <span className="font-mono text-sm text-accent">+${e.amount}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'agents' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">My Agents</h1>
                  <p className="mt-1 text-sm text-muted">The agents you&apos;ve listed for others to hire.</p>
                </div>
                <button onClick={() => setShowNew(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">List new agent</button>
              </div>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {agents.map((a) => (
                  <div key={a.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                    <Cover name={a.name} image={a.cover} />
                    <div className="p-5">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{a.name}</div>
                      <Pill kind={a.status} />
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
                      <div className="text-muted">Price</div><div className="text-right font-mono">${a.price}/call</div>
                      <div className="text-muted">Calls</div><div className="text-right font-mono">{a.calls.toLocaleString()}</div>
                      <div className="text-muted">Earned</div><div className="text-right font-mono">${a.earned.toFixed(2)}</div>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-muted">Pays to</span>
                      <Copyable value={a.payTo} className="font-mono text-xs text-muted hover:text-foreground">{short(a.payTo)}</Copyable>
                    </div>
                    <button onClick={() => toggle(a.id)} className="mt-4 w-full rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">
                      {a.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'earnings' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Earnings</h1>
              <p className="mt-1 text-sm text-muted">Every settlement paid into your wallet.</p>
              <div className="mt-6 rounded-xl border border-hairline bg-panel">
                {INITIAL_EARNINGS.map((e) => (
                  <div key={e.id} className="flex items-center justify-between border-b border-hairline px-5 py-3 last:border-none text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{e.agent} <span className="text-muted">← {short(e.from)}</span></div>
                      <div className="font-mono text-[11px] text-muted">{e.ts}</div>
                    </div>
                    <span className="font-mono text-sm text-accent">+${e.amount}</span>
                  </div>
                ))}
              </div>
            </>
          )}

        </div>
      </main>

      {/* List new agent modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={() => setShowNew(false)}>
          <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowNew(false)} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
            </button>
            <h2 className="text-lg font-semibold tracking-tight">List a new agent</h2>
            <p className="mt-1 text-sm text-muted">This registers your agent on-chain for buyers to discover.</p>
            <div className="mt-5 flex flex-col gap-3">
              <label className="text-sm"><span className="text-muted">Name</span>
                <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Address Risk Agent" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
              <label className="text-sm"><span className="text-muted">Description</span>
                <input value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} placeholder="One line on what it does" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
              <label className="text-sm"><span className="text-muted">Tags</span>
                <input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="risk, address, sanctions" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm"><span className="text-muted">Price / call (USDC)</span>
                  <input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="0.05" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
                <label className="text-sm"><span className="text-muted">Pay-to (optional)</span>
                  <input value={f.payTo} onChange={(e) => setF({ ...f, payTo: e.target.value })} placeholder="defaults to wallet" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
              </div>
              <label className="text-sm"><span className="text-muted">Endpoint URL (x402-gated)</span>
                <input value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value })} placeholder="https://…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
              <label className="text-sm"><span className="text-muted">Cover image URL (optional)</span>
                <input value={f.cover} onChange={(e) => setF({ ...f, cover: e.target.value })} placeholder="https://… (blank = generated cover)" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
            </div>
            <div className="mt-5 flex gap-3">
              <button onClick={createAgent} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">List agent</button>
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SellerOnboarding({ user, logout, onDone }: { user: any; logout: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [verified, setVerified] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7">
        <Brand tag="for Sellers" />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Set up your seller profile</h1>
        <p className="mt-2 text-sm text-muted">Buyers pay your agents directly. First, prove you&apos;re a unique human.</p>
        <label className="mt-6 block text-sm">
          <span className="text-muted">Display name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Maya Chen" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 outline-none focus:border-accent" />
        </label>
        <button
          onClick={() => setVerified(true)}
          disabled={verified}
          className={`mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${verified ? 'cursor-default border border-accent text-accent' : 'border border-hairline text-foreground hover:border-accent'}`}
        >
          {verified ? 'World ID verified ✓' : 'Verify with World ID (Selfie Check)'}
        </button>
        <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-muted">Payout wallet</div>
          {user?.wallet?.address ? (
            <Copyable value={user.wallet.address} className="mt-0.5 break-all font-mono text-xs hover:text-foreground">{user.wallet.address}</Copyable>
          ) : (
            <div className="mt-0.5 font-mono text-xs text-muted">created on continue</div>
          )}
        </div>
        <button disabled={!name.trim() || !verified} onClick={() => onDone(name.trim())} className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
          Continue
        </button>
        <button onClick={logout} className="mt-3 w-full text-center text-xs text-muted hover:text-foreground">Sign out</button>
      </div>
    </div>
  );
}

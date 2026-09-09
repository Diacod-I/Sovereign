'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import Brand from '../components/Brand';
import Copyable from '../components/Copyable';
import Cover from '../components/Cover';
import Avatar from '../components/Avatar';
import { useWalletData, useWithdraw, BalanceCard, ActivityFeed, DepositModal, WithdrawModal } from '../components/wallet';
import { buildBalanceSeries, fetchAgentsByOwner, fetchReceived, formatUsdc, type RangeKey, type RegistryAgent } from '../lib/arc';

type Tab = 'overview' | 'agents' | 'profile';
type Agent = RegistryAgent;

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

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

  // live agents this wallet has registered on-chain (The Graph)
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // top earner (most USDC received at a worker's payout address)
  const [topEarner, setTopEarner] = useState<{ name: string; amount: number } | null>(null);
  const [topLoading, setTopLoading] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [f, setF] = useState({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });

  // profile
  const [pName, setPName] = useState('');
  const [pBio, setPBio] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  // worker edit modal
  const [editId, setEditId] = useState<string | null>(null);

  // live wallet (same Privy embedded wallet as the buyer view)
  const walletAddress = user?.wallet?.address ?? null;
  const wallet = useWalletData(walletAddress);
  const withdraw = useWithdraw(walletAddress, wallet.reload);
  const [range, setRange] = useState<RangeKey>('1w');
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);

  const series = useMemo(() => buildBalanceSeries(wallet.history, wallet.balance ?? 0, range), [wallet.history, wallet.balance, range]);
  const feed = useMemo(() => wallet.txs.filter((t) => t.ts > 0), [wallet.txs]);

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  useEffect(() => {
    try {
      const s = localStorage.getItem('sovereign_seller');
      if (s) { setSeller(s); setPName(s); }
      const b = localStorage.getItem('sovereign_seller_bio');
      if (b) setPBio(b);
    } catch {}
    setSellerReady(true);
  }, []);

  // Load the agents this wallet owns from the subgraph.
  useEffect(() => {
    if (!walletAddress) return;
    let alive = true;
    setAgentsLoading(true);
    setAgentsError(null);
    fetchAgentsByOwner(walletAddress)
      .then((rows) => { if (alive) { setAgents(rows); setAgentsLoading(false); } })
      .catch(() => { if (alive) { setAgentsError('Could not reach the subgraph.'); setAgentsLoading(false); } });
    return () => { alive = false; };
  }, [walletAddress]);

  const activeCount = agents.filter((a) => a.active).length;

  // Compute the top-earning worker by summing USDC received at each distinct payout address.
  useEffect(() => {
    if (agentsLoading || agents.length === 0) { setTopEarner(null); return; }
    let alive = true;
    setTopLoading(true);
    const byPayTo = new Map<string, string>();
    for (const a of agents) {
      const key = a.payTo.toLowerCase();
      if (!byPayTo.has(key)) byPayTo.set(key, a.name);
    }
    Promise.all(
      [...byPayTo.entries()].map(async ([addr, name]) => ({ name, amount: await fetchReceived(addr).catch(() => 0) }))
    ).then((rows) => {
      if (!alive) return;
      const top = rows.slice().sort((x, y) => y.amount - x.amount)[0] || null;
      setTopEarner(top);
      setTopLoading(false);
    });
    return () => { alive = false; };
  }, [agents, agentsLoading]);

  if (!ready || !authenticated || !sellerReady) return null;

  if (!seller) {
    return <SellerOnboarding user={user} logout={logout} onDone={(name) => { try { localStorage.setItem('sovereign_seller', name); } catch {} setSeller(name); }} />;
  }

  const createAgent = () => {
    if (!f.name.trim() || !f.price.trim()) return;
    setAgents((list) => [
      { id: 'sa_' + Date.now(), name: f.name.trim(), description: f.desc.trim(), tags: f.tags.trim(), price: f.price.trim(), endpoint: f.endpoint.trim() || '—', payTo: f.payTo.trim() || (user?.wallet?.address ?? '0x0000000000000000000000000000000000000000'), owner: (walletAddress ?? '').toLowerCase(), active: true },
      ...list,
    ]);
    setF({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });
    setShowNew(false);
    setTab('agents');
  };
  const toggle = (id: string) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, active: !a.active } : a)));
  const updateAgent = (id: string, patch: Partial<Agent>) => setAgents((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const editing = agents.find((a) => a.id === editId) || null;

  const saveProfile = () => {
    const nm = pName.trim();
    if (!nm) return;
    setSeller(nm);
    try {
      localStorage.setItem('sovereign_seller', nm);
      localStorage.setItem('sovereign_seller_bio', pBio);
    } catch {}
    setProfileSaved(true);
  };

  const NAV: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'My Workers' },
    { id: 'profile', label: 'Profile' },
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-hairline bg-panel px-4 py-5 mt-1">
        <div className="px-2">
          <Brand tag="for Sellers" />
        </div>
        <nav className="mt-6 flex flex-col gap-1">
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
                  <p className="mt-1 text-sm text-muted">What your agents are earning across the marketplace.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowDeposit(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">Add funds</button>
                  <button onClick={() => setShowWithdraw(true)} className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted transition-colors hover:text-foreground">Withdraw</button>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Balance" value={wallet.balance === null ? '—' : formatUsdc(wallet.balance)} sub={wallet.error ? 'balance unavailable' : 'USDC on Arc'} />
                <Stat label="Active agents" value={agentsLoading ? '—' : String(activeCount)} sub={agentsError ? 'unavailable' : 'live on-chain'} />
                <Stat label="Top earner" value={topLoading || !topEarner ? '—' : `${formatUsdc(topEarner.amount)}`} sub={topEarner ? topEarner.name : 'no earnings yet'} />
              </div>

              <BalanceCard series={series} range={range} setRange={setRange} loading={wallet.loading} error={wallet.error} hasWallet={!!walletAddress} onAdd={() => setShowDeposit(true)} />

              <ActivityFeed items={feed} loading={wallet.loading} error={wallet.error} title="Settlements & activity" />
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
              {agentsLoading ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">Loading your agents from the subgraph…</div>
              ) : agentsError ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-red-400">{agentsError}</div>
              ) : agents.length === 0 ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">You haven&apos;t registered any agents from this wallet yet.</div>
              ) : (
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {agents.map((a) => {
                    const tags = a.tags ? a.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
                    return (
                      <div key={a.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                        <Cover name={a.name} />
                        <div className="p-5">
                          <div className="flex items-center justify-between">
                            <div className="font-medium">{a.name}</div>
                            <Pill kind={a.active ? 'active' : 'paused'} />
                          </div>
                          {a.description && <div className="mt-1 truncate text-xs text-muted">{a.description}</div>}
                          {tags.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {tags.slice(0, 4).map((t) => (
                                <span key={t} className="rounded-full border border-hairline bg-background px-2 py-0.5 font-mono text-[10px] text-muted">{t}</span>
                              ))}
                            </div>
                          )}
                          <div className="mt-4 flex items-center justify-between text-sm">
                            <span className="text-muted">Price</span>
                            <span className="font-mono">{a.price} USDC/call</span>
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="text-[10px] uppercase tracking-wider text-muted">Pays to</span>
                            <Copyable value={a.payTo} className="font-mono text-xs text-muted hover:text-foreground">{short(a.payTo)}</Copyable>
                          </div>
                          <div className="mt-2 break-all font-mono text-[11px] text-muted">{a.endpoint}</div>
                          <div className="mt-4 flex gap-2">
                            <button onClick={() => setEditId(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">Edit</button>
                            <button onClick={() => toggle(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">
                              {a.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'profile' && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
              <p className="mt-1 text-sm text-muted">How buyers see you across the marketplace.</p>

              <div className="mt-6 rounded-xl border border-hairline bg-panel p-6">
                <div className="flex items-center gap-4">
                  <Avatar name={pName || seller || 'S'} size={56} />
                  <div>
                    <div className="font-medium">{pName || seller}</div>
                    <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />World ID verified
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex flex-col gap-4">
                  <label className="text-sm">
                    <span className="text-muted">Display name</span>
                    <input value={pName} onChange={(e) => { setPName(e.target.value); setProfileSaved(false); }} placeholder="Maya Chen" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" />
                  </label>
                  <label className="text-sm">
                    <span className="text-muted">Bio</span>
                    <textarea value={pBio} onChange={(e) => { setPBio(e.target.value); setProfileSaved(false); }} rows={3} placeholder="What you build, and what buyers can trust you for." className="mt-1 w-full resize-none rounded-lg border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-accent" />
                  </label>
                  <div className="rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
                    <div className="text-[10px] uppercase tracking-wider text-muted">Payout wallet (Arc)</div>
                    {user?.wallet?.address ? (
                      <Copyable value={user.wallet.address} className="mt-0.5 break-all font-mono text-xs text-muted hover:text-foreground">{user.wallet.address}</Copyable>
                    ) : (
                      <div className="mt-0.5 font-mono text-xs text-muted">wallet not ready</div>
                    )}
                  </div>
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <button disabled={!pName.trim()} onClick={saveProfile} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">Save changes</button>
                  {profileSaved && <span className="text-sm text-accent">Saved ✓</span>}
                </div>
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
            </div>
            <div className="mt-5 flex gap-3">
              <button onClick={createAgent} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">List agent</button>
              <button onClick={() => setShowNew(false)} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showDeposit && (
        <DepositModal address={walletAddress} onFunded={wallet.reload} onClose={() => setShowDeposit(false)} />
      )}
      {showWithdraw && (
        <WithdrawModal address={walletAddress} balance={wallet.balance} onWithdraw={withdraw} onClose={() => setShowWithdraw(false)} />
      )}
      {editing && (
        <EditWorkerModal agent={editing} onSave={(patch) => updateAgent(editing.id, patch)} onClose={() => setEditId(null)} />
      )}
    </div>
  );
}

// Edit an existing worker's public details.
function EditWorkerModal({ agent, onSave, onClose }: { agent: Agent; onSave: (patch: Partial<Agent>) => void; onClose: () => void }) {
  const [name, setName] = useState(agent.name);
  const [price, setPrice] = useState(agent.price);
  const [endpoint, setEndpoint] = useState(agent.endpoint);
  const [payTo, setPayTo] = useState(agent.payTo);
  const [description, setDescription] = useState(agent.description);
  const [tags, setTags] = useState(agent.tags);

  const save = () => {
    if (!name.trim() || !price.trim()) return;
    onSave({
      name: name.trim(),
      price: price.trim(),
      endpoint: endpoint.trim() || '—',
      payTo: payTo.trim() || agent.payTo,
      description: description.trim(),
      tags: tags.trim(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
        <h2 className="text-lg font-semibold tracking-tight">Edit worker</h2>
        <p className="mt-1 text-sm text-muted">Update the details buyers see for this agent.</p>
        <div className="mt-5 flex flex-col gap-3">
          <label className="text-sm"><span className="text-muted">Name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
          <label className="text-sm"><span className="text-muted">Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line on what it does" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
          <label className="text-sm"><span className="text-muted">Tags</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="risk, address, sanctions" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm"><span className="text-muted">Price / call (USDC)</span>
              <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.05" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
            <label className="text-sm"><span className="text-muted">Pay-to</span>
              <input value={payTo} onChange={(e) => setPayTo(e.target.value)} placeholder="0x…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent" /></label>
          </div>
          <label className="text-sm"><span className="text-muted">Endpoint URL (x402-gated)</span>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
        </div>
        <div className="mt-5 flex gap-3">
          <button disabled={!name.trim() || !price.trim()} onClick={save} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">Save changes</button>
          <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
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

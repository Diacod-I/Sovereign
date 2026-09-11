'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import SideNav, { tabFromUrl } from '../components/SideNav';
import Copyable from '../components/Copyable';
import Cover from '../components/Cover';
import Avatar from '../components/Avatar';
import { fetchAgentsByOwner, txUrl, type RegistryAgent } from '../lib/arc';
import { SITE_URL } from '../lib/hosted';
import { useRegistry, type ListingInput } from '../lib/registry';
import WorldVerify from '../components/WorldVerify';
import VerifyGate from '../components/VerifyGate';
import Onboarding from '../components/Onboarding';
import EndpointProbe from '../components/EndpointProbe';
import HostedWorkerForm from '../components/HostedWorkerForm';
import TestBench from '../components/TestBench';
import type { ProbeResult } from '../lib/probe';
import { useEmbeddedWallet } from '../lib/useEmbeddedWallet';
import { readVerification, mergeVerification, shortNullifier, levelLabel, type SellerVerification } from '../lib/world';
import { fetchVerification } from '../lib/verification';
import { readProfile, writeProfile } from '../lib/profile';

type Tab = 'workers' | 'profile';
type Agent = RegistryAgent;

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

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
  // Shown when an unverified account reaches for something other people will see.
  const [gate, setGate] = useState(false);
  const [tab, setTab] = useState<Tab>('workers');

  // live agents this wallet has registered on-chain (The Graph)
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsNonce, setAgentsNonce] = useState(0); // bump to refetch from the subgraph

  // on-chain listing tx state (register / update / setActive)
  const [txPending, setTxPending] = useState<string | null>(null); // human label of the in-flight tx
  const [txError, setTxError] = useState<string | null>(null);
  const [txNote, setTxNote] = useState<{ msg: string; hash: string } | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [f, setF] = useState({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });
  // Result of the pre-listing endpoint check. Registering is gated on this so a
  // dead or mispriced endpoint cannot reach the marketplace by accident.
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [forceList, setForceList] = useState(false);
  /**
   * How this worker will be reached. 'hosted' is the default because it is the
   * only one a person without a server can finish: the alternative asks them to
   * already own an x402-gated URL, which was the whole barrier.
   */
  const [hosting, setHosting] = useState<'hosted' | 'own'>('hosted');
  /** Slug of the hosted worker backing the current form, if any. */
  const [hostedSlug, setHostedSlug] = useState<string | null>(null);

  // profile
  const [pName, setPName] = useState('');
  const [pBio, setPBio] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  // Profile reads as a page by default and only becomes a form on request. Edits
  // go to a draft so Cancel discards rather than silently keeping them.
  const [editingProfile, setEditingProfile] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftBio, setDraftBio] = useState('');
  const [worldV, setWorldV] = useState<SellerVerification | null>(null);

  // worker edit modal
  const [editId, setEditId] = useState<string | null>(null);
  /** Which worker's test bench is open. Opening it costs a signature, so it is
   *  never opened for them. */
  const [benchFor, setBenchFor] = useState<string | null>(null);

  // live wallet (same Privy embedded wallet as the buyer view). Resolved via
  // useEmbeddedWallet so a MetaMask login still signs with the embedded wallet.
  const embedded = useEmbeddedWallet();
  const walletAddress = embedded.address;
  const registry = useRegistry(walletAddress);

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  useEffect(() => {
    const p = readProfile();
    if (p) { setSeller(p.name); setPName(p.name); setPBio(p.bio); }
    const fromUrl = tabFromUrl(['workers', 'profile']);
    if (fromUrl) setTab(fromUrl as Tab);
    setSellerReady(true);
  }, []);

  // Local cache first so the badge does not flicker, then the chain, which is the
  // record everyone else reads. The chain wins: a local badge with no on-chain row
  // is a verification that was never published.
  useEffect(() => {
    setWorldV(readVerification(walletAddress));
    if (!walletAddress) return;
    let alive = true;
    fetchVerification(walletAddress).then((onChain) => {
      if (!alive) return;
      setWorldV((local) => mergeVerification(local, onChain, walletAddress));
    });
    return () => { alive = false; };
  }, [walletAddress]);

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
  }, [walletAddress, agentsNonce]);

  // The subgraph lags the chain by a few seconds — refetch a couple of times after
  // a listing tx confirms so "My Workers" catches up to on-chain truth.
  const reloadAgentsSoon = () => {
    setTimeout(() => setAgentsNonce((n) => n + 1), 4000);
    setTimeout(() => setAgentsNonce((n) => n + 1), 9000);
  };

  const activeCount = agents.filter((a) => a.active).length;

  /** The slug, if this listing points at a Sovereign-hosted endpoint. */
  const hostedSlugOf = (endpoint: string): string | null => {
    const prefix = `${SITE_URL}/w/`;
    if (!endpoint.startsWith(prefix)) return null;
    const rest = endpoint.slice(prefix.length).split(/[/?#]/)[0];
    return rest || null;
  };

  if (!ready || !authenticated || !sellerReady) return null;

  if (!seller) {
    return <Onboarding logout={logout} onDone={(p) => { setSeller(p.name); setPName(p.name); setPBio(p.bio); }} />;
  }

  const fToInput = (): ListingInput => ({
    name: f.name.trim(),
    description: f.desc.trim(),
    tags: f.tags.trim(),
    price: f.price.trim(),
    endpoint: f.endpoint.trim(),
    payTo: f.payTo.trim() || walletAddress || '',
  });

  const createWorker = async () => {
    const input = fToInput();
    if (!input.name || !input.price || txPending) return;
    if (!input.endpoint) {
      setTxError('An endpoint URL is required — buyers have nothing to call without one.');
      return;
    }
    // Listing an unverified endpoint is possible, but only deliberately.
    if (!probe && !forceList) {
      setTxError('Run the endpoint check first.');
      return;
    }
    if (probe && !probe.ok && !forceList) {
      setTxError('The endpoint check failed. Fix it, or tick “list anyway” to publish it as-is.');
      return;
    }
    setTxError(null); setTxNote(null); setTxPending('Registering worker on-chain…');
    try {
      const { hash, id } = await registry.register(input);
      setAgents((list) => [
        { id, name: input.name, description: input.description, tags: input.tags, price: input.price, endpoint: input.endpoint, payTo: input.payTo || (walletAddress ?? ''), owner: (walletAddress ?? '').toLowerCase(), active: true },
        ...list.filter((a) => a.id !== id),
      ]);
      setTxNote({ msg: `Listed “${input.name}” on-chain`, hash });
      setF({ name: '', desc: '', tags: '', price: '', endpoint: '', payTo: '', cover: '' });
      setProbe(null);
      setForceList(false);
      setHostedSlug(null);
      setHosting('hosted');
      setShowNew(false);
      setTab('workers');
      reloadAgentsSoon();
    } catch (e: any) {
      setTxError(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setTxPending(null);
    }
  };

  const toggle = async (id: string) => {
    const a = agents.find((x) => x.id === id);
    if (!a || txPending) return;
    const next = !a.active;
    setTxError(null); setTxNote(null); setTxPending(`${next ? 'Reactivating' : 'Deactivating'} “${a.name}”…`);
    try {
      const hash = await registry.setActive(id, next);
      setAgents((list) => list.map((x) => (x.id === id ? { ...x, active: next } : x)));
      setTxNote({ msg: `${next ? 'Reactivated' : 'Deactivated'} “${a.name}”`, hash });
      reloadAgentsSoon();
    } catch (e: any) {
      setTxError(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setTxPending(null);
    }
  };

  const updateWorker = async (id: string, input: ListingInput): Promise<void> => {
    if (txPending) return;
    setTxError(null); setTxNote(null); setTxPending(`Updating “${input.name}”…`);
    try {
      const hash = await registry.update(id, input);
      setAgents((list) => list.map((a) => (a.id === id ? { ...a, name: input.name, description: input.description, tags: input.tags, price: input.price, endpoint: input.endpoint, payTo: input.payTo || a.payTo } : a)));
      setTxNote({ msg: `Updated “${input.name}” on-chain`, hash });
      reloadAgentsSoon();
    } catch (e: any) {
      setTxError(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
      throw e;
    } finally {
      setTxPending(null);
    }
  };
  const editing = agents.find((a) => a.id === editId) || null;

  const startEditProfile = () => {
    setDraftName(pName || seller || '');
    setDraftBio(pBio);
    setProfileSaved(false);
    setEditingProfile(true);
  };

  const saveProfile = () => {
    const nm = draftName.trim();
    if (!nm) return;
    setPName(nm);
    setPBio(draftBio);
    setSeller(nm);
    writeProfile({ name: nm, bio: draftBio });
    setEditingProfile(false);
    setProfileSaved(true);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <SideNav
        route="seller"
        tab={tab}
        onTab={(t) => setTab(t as Tab)}
        name={seller}
        address={walletAddress}
        fallback={user?.email?.address}
        onSignOut={logout}
      />

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">

          {tab === 'workers' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
                  <p className="mt-1 text-sm text-muted">The workers you have listed for others to hire.</p>
                </div>
                <button onClick={() => (worldV ? setShowNew(true) : setGate(true))} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">List new worker</button>
              </div>

              {txPending && (
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-2 text-sm text-muted">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  {txPending} confirm in your wallet.
                </div>
              )}
              {!txPending && txNote && (
                <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
                  <span className="flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />{txNote.msg} — indexing…</span>
                  <a href={txUrl(txNote.hash)} target="_blank" rel="noreferrer" className="font-mono text-xs underline-offset-2 hover:underline">Arcscan ↗</a>
                </div>
              )}
              {!txPending && txError && (
                <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-sm text-red-400">{txError}</div>
              )}

              {agentsLoading ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">Loading your workers from the subgraph…</div>
              ) : agentsError ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-red-400">{agentsError}</div>
              ) : agents.length === 0 ? (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">You have not listed any workers from this wallet yet.</div>
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
                            <button disabled={!!txPending} onClick={() => setEditId(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-40">Edit</button>
                            <button disabled={!!txPending} onClick={() => toggle(a.id)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-40">
                              {a.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </div>
                          {hostedSlugOf(a.endpoint) && (
                            <button
                              onClick={() => setBenchFor(benchFor === a.id ? null : a.id)}
                              className="mt-2 w-full rounded-lg border border-hairline px-3 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground"
                            >
                              {benchFor === a.id ? 'Hide test bench' : 'Test bench'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {benchFor && (() => {
                const a = agents.find((x) => x.id === benchFor);
                const slug = a ? hostedSlugOf(a.endpoint) : null;
                if (!a || !slug) return null;
                return (
                  <div className="mt-4">
                    <div className="mb-2 text-[11px] text-muted">
                      Testing <span className="text-foreground">{a.name}</span>
                    </div>
                    <TestBench walletAddress={walletAddress} slug={slug} />
                  </div>
                );
              })()}
            </>
          )}

          {tab === 'profile' && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
                  <p className="mt-1 text-sm text-muted">
                    {editingProfile ? 'Editing how you appear to buyers.' : 'How buyers see you across the marketplace.'}
                  </p>
                </div>
                {!editingProfile && (
                  <button
                    onClick={startEditProfile}
                    className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
                  >
                    {profileSaved && <span className="mb-2 text-sm text-accent">Saved</span> || <span className="mb-2 text-sm text-muted">Edit Profile</span>}
                  </button>
                )}
              </div>

              {/* ---------- view: the page, not the form ---------- */}
              {!editingProfile && (
                <div className="mt-6 rounded-xl border border-hairline bg-panel">
                  <Cover name={pName || seller || 'S'} className="overflow-hidden rounded-t-xl" />

                  <div className="px-6 pb-6">
                    <div className="-mt-10 flex items-end gap-4">
                      {/* Avatar is drawn at 12% alpha, so without an opaque fill
                          behind it the cover gradient shows through the overlapping
                          half and the circle reads as cropped. bg-panel gives it
                          something solid to sit on; z-10 keeps it above the cover. */}
                      <span className="relative z-10 inline-flex shrink-0 rounded-full border-4 border-panel bg-panel">
                        <Avatar name={pName || seller || 'S'} size={72} />
                      </span>
                    </div>

                    <h2 className="mt-3 text-xl font-semibold tracking-tight">{pName || seller}</h2>

                    {worldV ? (
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-accent">
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                          World ID verified · {levelLabel(worldV.level)}
                        </span>
                        {/* The nullifier is the only durable handle on this
                            verification, so make it copyable rather than decorative. */}
                        {!worldV.onChain && (
                          <span className="text-amber-400">· not published, buyers cannot see this</span>
                        )}
                        {worldV.nullifierHash !== 'demo' && (
                          <Copyable
                            value={worldV.nullifierHash}
                            copiedLabel="nullifier copied"
                            className="font-mono text-muted transition-colors hover:text-foreground"
                          >
                            {shortNullifier(worldV.nullifierHash)}
                          </Copyable>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-muted">
                        Not verified as a unique human. Buyers see this, and you cannot
                        list a worker until you are.
                      </div>
                    )}

                    <p className={`mt-4 max-w-prose text-sm leading-relaxed ${pBio ? '' : 'text-muted'}`}>
                      {pBio || 'No bio yet. Buyers use this to decide whether to trust you, so it is worth a line.'}
                    </p>

                    {!worldV && (
                      <div className="mt-4 max-w-xs">
                        <WorldVerify wallet={walletAddress} onVerified={setWorldV} label="Verify with World ID" />
                      </div>
                    )}

                    {/* What a buyer is actually here to see. Balance and payout
                        address deliberately excluded: one is private, the other is
                        on-chain anyway and reads as clutter on a public profile. */}
                    <div className="mt-6 border-t border-hairline pt-5">
                      <div className="flex items-baseline justify-between">
                        <h3 className="text-sm font-medium">Workers</h3>
                        <span className="font-mono text-[11px] text-muted">
                          {agentsLoading ? 'loading…' : `${activeCount} live${agents.length > activeCount ? ` · ${agents.length - activeCount} paused` : ''}`}
                        </span>
                      </div>

                      {agentsLoading ? (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          {[0, 1].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-[#1c1c1c]" />)}
                        </div>
                      ) : agents.length === 0 ? (
                        <div className="mt-3 rounded-xl border border-dashed border-hairline p-6 text-center">
                          <p className="text-sm text-muted">No workers listed yet.</p>
                          <button
                            onClick={() => setTab('workers')}
                            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
                          >
                            List your first worker
                          </button>
                        </div>
                      ) : (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          {agents.map((a) => {
                            const tags = a.tags ? a.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
                            return (
                              <button
                                key={a.id}
                                onClick={() => setTab('workers')}
                                className="overflow-hidden rounded-xl border border-hairline bg-background text-left transition-colors hover:border-muted"
                              >
                                <div className="relative">
                                  <Cover name={a.name} className="h-14 overflow-hidden" />
                                  <div className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 backdrop-blur-sm">
                                    <Pill kind={a.active ? 'active' : 'paused'} />
                                  </div>
                                </div>
                                <div className="p-3">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="truncate text-sm font-medium">{a.name}</span>
                                    <span className="shrink-0 font-mono text-xs">{a.price}<span className="text-muted"> USDC</span></span>
                                  </div>
                                  {a.description && (
                                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">{a.description}</p>
                                  )}
                                  {tags.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                      {tags.slice(0, 3).map((t) => (
                                        <span key={t} className="rounded-full border border-hairline px-1.5 py-0.5 font-mono text-[9px] text-muted">{t}</span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ---------- edit: the form, on request ---------- */}
              {editingProfile && (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-6">
                  <div className="flex flex-col gap-4">
                    <label className="text-sm">
                      <span className="text-muted">Display name</span>
                      <input
                        autoFocus
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="Maya Chen"
                        className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="text-muted">Bio</span>
                      <textarea
                        value={draftBio}
                        onChange={(e) => setDraftBio(e.target.value)}
                        rows={3}
                        maxLength={280}
                        placeholder="What you build, and what buyers can trust you for."
                        className="mt-1 w-full resize-none rounded-lg border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-accent"
                      />
                      <span className="mt-1 block text-right text-[10px] text-muted">{draftBio.length}/280</span>
                    </label>
                  </div>

                  <div className="mt-5 flex items-center gap-3">
                    <button
                      disabled={!draftName.trim()}
                      onClick={saveProfile}
                      className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      Save changes
                    </button>
                    <button
                      onClick={() => setEditingProfile(false)}
                      className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </main>

      {/* List new worker modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-6 py-10 sm:items-center" onClick={() => setShowNew(false)}>
          <div className="relative flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowNew(false)} aria-label="Close" className="absolute right-4 top-4 z-10 text-muted transition-colors hover:text-foreground">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
            </button>
            <h2 className="shrink-0 text-lg font-semibold tracking-tight">List a new worker</h2>
            <p className="mt-1 shrink-0 text-sm text-muted">This registers your worker on-chain for buyers to discover.</p>
            <div className="-mx-6 mt-5 flex flex-1 flex-col gap-3 overflow-y-auto px-6">
              <label className="text-sm"><span className="text-muted">Name</span>
                <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Address Risk Worker" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>
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
              <div className="rounded-lg border border-hairline bg-background p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted">How buyers reach it</div>
                <div className="mt-2 flex flex-col gap-2">
                  {([
                    ['hosted', 'Sovereign hosts it', 'Paste a webhook from a tool you already use. We add the payment wall, the https URL and the Circle account.'],
                    ['own', 'I already have an x402 endpoint', 'You run the server and speak x402 yourself.'],
                  ] as const).map(([mode, title, sub]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => { setHosting(mode); setProbe(null); setForceList(false); }}
                      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${hosting === mode ? 'border-accent bg-accent/5' : 'border-hairline hover:border-muted'}`}
                    >
                      <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${hosting === mode ? 'border-accent bg-accent' : 'border-hairline'}`} />
                      <span className="text-[11px]">
                        {title}
                        <span className="block leading-relaxed text-muted">{sub}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-3 border-t border-hairline pt-3">
                  {hosting === 'hosted' ? (
                    <HostedWorkerForm
                      walletAddress={walletAddress}
                      name={f.name}
                      price={f.price}
                      payTo={f.payTo.trim() || walletAddress || ''}
                      onHosted={(url, slug) => { setF((prev) => ({ ...prev, endpoint: url })); setHostedSlug(slug); setProbe(null); setForceList(false); }}
                    />
                  ) : (
                    <label className="text-sm"><span className="text-muted">Endpoint URL (x402-gated)</span>
                      <input value={f.endpoint} onChange={(e) => { setF({ ...f, endpoint: e.target.value }); setProbe(null); setForceList(false); setHostedSlug(null); }} placeholder="https://…" className="mt-1 w-full rounded-lg border border-hairline bg-panel px-3 py-2 outline-none focus:border-accent" /></label>
                  )}
                </div>
              </div>

              <EndpointProbe
                endpoint={f.endpoint}
                payTo={f.payTo.trim() || walletAddress || undefined}
                price={f.price.trim() || undefined}
                owner={walletAddress || undefined}
                result={probe}
                onResult={setProbe}
              />

              {probe && !probe.ok && (
                <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-muted">
                  <input
                    type="checkbox"
                    checked={forceList}
                    onChange={(e) => setForceList(e.target.checked)}
                    className="mt-0.5 accent-[color:var(--accent)]"
                  />
                  <span>List anyway — I understand buyers will see a listing they cannot pay.</span>
                </label>
              )}
            </div>
            {txError && <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{txError}</div>}
            <div className="mt-5 flex shrink-0 gap-3 border-t border-hairline pt-4">
              <button
                disabled={
                  !f.name.trim() || !f.price.trim() || !f.endpoint.trim() || !!txPending ||
                  (!probe && !forceList) || (!!probe && !probe.ok && !forceList)
                }
                onClick={createWorker}
                className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {txPending ? 'Confirm in wallet…' : probe?.ok ? 'List verified worker' : 'List worker'}
              </button>
              <button onClick={() => { setShowNew(false); setProbe(null); setForceList(false); setHostedSlug(null); }} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {gate && (
        <VerifyGate
          wallet={walletAddress}
          action="list a worker"
          reason="A listing is a promise to strangers that something on the other end will do the work. Tying it to one verified human is what stops the same person filling the marketplace with a hundred of them."
          onVerified={(v) => { setWorldV(v); setGate(false); setShowNew(true); }}
          onClose={() => setGate(false)}
        />
      )}
      {editing && (
        <EditWorkerModal agent={editing} onSave={(input) => updateWorker(editing.id, input)} onClose={() => setEditId(null)} />
      )}
    </div>
  );
}

// Edit an existing worker's public details — saving fires an on-chain update() tx.
function EditWorkerModal({ agent, onSave, onClose }: { agent: Agent; onSave: (input: ListingInput) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(agent.name);
  const [price, setPrice] = useState(agent.price);
  const [endpoint, setEndpoint] = useState(agent.endpoint);
  const [payTo, setPayTo] = useState(agent.payTo);
  const [description, setDescription] = useState(agent.description);
  const [tags, setTags] = useState(agent.tags);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const save = async () => {
    if (!name.trim() || !price.trim() || busy) return;
    if (!endpoint.trim()) {
      setErr('An endpoint URL is required.');
      return;
    }
    // Editing price or endpoint is exactly when a listing drifts out of sync with
    // what the endpoint actually quotes, so warn rather than silently publish.
    if (probe && !probe.ok) {
      setErr('The endpoint check failed — buyers would not be able to pay this listing.');
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        price: price.trim(),
        endpoint: endpoint.trim(),
        payTo: payTo.trim() || agent.payTo,
        description: description.trim(),
        tags: tags.trim(),
      });
      onClose();
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-6 py-10 sm:items-center" onClick={onClose}>
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
            <input value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setProbe(null); }} placeholder="https://…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent" /></label>

          <EndpointProbe
            endpoint={endpoint}
            payTo={payTo.trim() || agent.payTo}
            price={price.trim() || undefined}
            owner={agent.owner || undefined}
            result={probe}
            onResult={setProbe}
          />
        </div>
        {err && <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}
        <div className="mt-5 flex gap-3">
          <button disabled={!name.trim() || !price.trim() || busy} onClick={save} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">{busy ? 'Confirm in wallet…' : 'Save changes'}</button>
          <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
        </div>
      </div>
    </div>
  );
}

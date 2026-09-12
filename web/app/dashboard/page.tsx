'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useSendTransaction } from '@privy-io/react-auth';
import { parseUnits } from 'viem';
import { useRouter } from 'next/navigation';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import QRCode from 'qrcode';
import SideNav, { tabFromUrl } from '../components/SideNav';
import Copyable from '../components/Copyable';
import Avatar from '../components/Avatar';
import Cover from '../components/Cover';
import VerifyGate from '../components/VerifyGate';
import WorkerEarnings from '../components/WorkerEarnings';
import OnboardingCard from '../components/Onboarding';
import { useEmbeddedWallet } from '../lib/useEmbeddedWallet';
import { readProfile } from '../lib/profile';
import { displayName, type PublicProfile } from '../lib/directory';
import {
  APPROVAL_HEADROOM_USDC,
  approveData,
  depositData,
  gatewayAllowance,
  gatewayAvailable,
  GATEWAY,
} from '../lib/gateway';
import { withoutHidden } from '../lib/curation';
import { useDirectory } from '../lib/useDirectory';
import { readVerification, mergeVerification, type SellerVerification } from '../lib/world';
import { fetchVerification, useVerified } from '../lib/verification';
import {
  TRACK_RECORD_FIELDS, addPending, fetchReceipts, readPending, removePending,
  readHandoff, receiptsConfigured, toTrackRecord, useFileReceipt,
  type PendingReview, type ReceiptRow,
} from '../lib/receipts';
import { MET_COLOR, MET_LABEL, formatLatency, scoreOf, type Score, type TrackRecord } from '../lib/reputation';
import {
  ARC_CHAIN_ID,
  FAUCET_URL,
  RANGES,
  buildBalanceSeries,
  fetchAgentsByOwner,
  fetchBalance,
  ARC_RPC_URL,
  fetchWalletData,
  formatUsdc,
  rangeDef,
  relTime,
  shortHash,
  txUrl,
  type ArcTx,
  type BalancePoint,
  type RangeKey,
  type RegistryAgent,
} from '../lib/arc';

type Tab = 'overview' | 'marketplace' | 'allowlist';

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

/**
 * One spend policy per account, not a list of named buyer agents.
 *
 * The multi-agent model asked the user to invent and manage a roster before they
 * could spend a cent, and then to wire each one into Claude Code separately. In
 * practice everybody made exactly one, so the roster was ceremony: the same
 * treasury, the same allowlist, a different label. Collapsing it to a single
 * policy means one set of limits, one MCP command, and one word — worker — for
 * the things being hired.
 */
export type SpendPolicy = {
  dailyBudget: number;
  perAction: number;
  approvalThreshold: number;
  spentToday: number;
  /** UTC day (YYYY-MM-DD) that spentToday counts against. */
  spentOn?: string;
  /** Paused stops every hire without throwing the limits away. */
  paused: boolean;
};

const DEFAULT_POLICY: SpendPolicy = {
  dailyBudget: 250,
  perAction: 50,
  approvalThreshold: 100,
  spentToday: 0,
  paused: false,
};

type AllowEntry = {
  id: string;
  listingId: string;
  name: string;
  address: string;
  cap: number;
  /**
   * Dead field, kept so entries written by the multi-agent build still parse.
   * Scoping an entry to particular buyer agents stopped meaning anything when
   * there stopped being more than one.
   */
  agentIds?: string[] | null;
};

const INITIAL_ALLOWLIST: AllowEntry[] = [];

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * The command that wires this account into Claude Code. `sovereign-mcp` is a
 * published stdio MCP server; SUBGRAPH_URL points it at the live registry. There
 * is one of these per account now, so it is the same string every time — copy it
 * once and Claude can reach the whole marketplace.
 */
function mcpAddCommand() {
  return [
    'claude mcp add sovereign',
    `--env SUBGRAPH_URL=${SUBGRAPH_URL}`,
    '-- npx -y sovereign-mcp',
  ].join(' ');
}

/**
 * Reads the stored policy, migrating the old `sovereign_agents` array on the way.
 *
 * Anyone who used the multi-agent build has a list in localStorage. Its first
 * entry carried their real limits, so it becomes the single policy rather than
 * being dropped on the floor and silently replaced by defaults.
 */
function loadPolicy(): SpendPolicy {
  try {
    const raw = localStorage.getItem('sovereign_policy');
    if (raw) return rollDaily({ ...DEFAULT_POLICY, ...JSON.parse(raw) });
    const legacy = localStorage.getItem('sovereign_agents');
    if (legacy) {
      const list = JSON.parse(legacy);
      const a = Array.isArray(list) ? list[0] : null;
      if (a) {
        return rollDaily({
          dailyBudget: Number(a.dailyBudget) || DEFAULT_POLICY.dailyBudget,
          perAction: Number(a.perAction) || DEFAULT_POLICY.perAction,
          approvalThreshold: Number(a.approvalThreshold) || DEFAULT_POLICY.approvalThreshold,
          spentToday: Number(a.spentToday) || 0,
          spentOn: a.spentOn,
          paused: a.status === 'paused',
        });
      }
    }
  } catch {}
  return { ...DEFAULT_POLICY, spentOn: utcDay() };
}

/** Rolls spentToday back to 0 when the stored day is no longer today (UTC). */
function rollDaily(p: SpendPolicy): SpendPolicy {
  const today = utcDay();
  return p.spentOn === today ? p : { ...p, spentToday: 0, spentOn: today };
}

// The buyer-side copy of the spend policy check used to live here, gating the
// browser's "Hire & pay". That button is gone, and with it the only caller: the
// policy is now enforced where the money actually moves, in policy.server.ts,
// which a stolen token or a tampered localStorage cannot talk its way past.

type Listing = {
  id: string;
  name: string;
  summary: string;
  tags: string;
  price: string;
  payTo: string;
  owner: string;
  endpoint: string;
  /** Aggregated from on-chain receipts. Empty until anyone has hired it. */
  record: TrackRecord;
};

const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

// Live discovery — reads active agents straight from the Sovereign subgraph.
async function fetchMarket(): Promise<Listing[]> {
  // Track-record fields ride along with discovery so the marketplace can rank and
  // badge without a second round trip per listing.
  const query =
    `{ agents(where: { active: true }, orderBy: createdAt, orderDirection: desc, first: 100) { id name description tags endpoint pricePerCall payTo owner ${TRACK_RECORD_FIELDS} } }`;
  let json = await (await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })).json();
  // Before the Receipts datasource is deployed the aggregate fields do not exist
  // and the whole query 400s. Fall back to plain discovery rather than showing an
  // empty marketplace.
  if (json.errors) {
    const bare =
      '{ agents(where: { active: true }, orderBy: createdAt, orderDirection: desc, first: 100) { id name description tags endpoint pricePerCall payTo owner } }';
    json = await (await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: bare }),
    })).json();
    if (json.errors) throw new Error('subgraph error');
  }
  return (json.data?.agents ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    summary: a.description,
    tags: a.tags,
    price: (Number(a.pricePerCall) / 1e6).toString(),
    payTo: a.payTo,
    owner: a.owner,
    endpoint: a.endpoint,
    record: toTrackRecord(a),
  }));
}

/**
 * `delta` is the net movement over the chart's window, printed small beside the
 * figure it moved. Signed and coloured, because the sign is the whole point: the
 * number on its own does not say whether the account is earning or burning.
 * Rounded to cents before the zero test, so a few wei of gas does not render as
 * a green +$0.00.
 */
function Stat({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: number }) {
  const d = delta === undefined ? 0 : Math.round(delta * 100) / 100;
  return (
    <div className="rounded-xl border border-hairline bg-panel p-5">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {delta !== undefined && d !== 0 && (
          <span className={`font-mono text-xs ${d > 0 ? 'text-accent' : 'text-red-400'}`}>
            {d > 0 ? '+' : '−'}{formatUsdc(Math.abs(d))}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Whether this account has proved it is one human, as the chain reports it.
 *
 * `null` while the subgraph is still answering: a listing that has not loaded
 * its verification yet must not be labelled unverified, because "unverified" is
 * a claim about someone and a spinner is not.
 */
/**
 * Shown only when there is something to show.
 *
 * An "unverified" tag on everyone who has not been through World ID reads as an
 * accusation, and it is on the wrong party: the absence of a badge is already
 * the absence of a claim. Marking a positive and staying quiet otherwise says
 * the same thing without telling every new seller that the marketplace doubts
 * them.
 */
function HumanBadge({ verified }: { verified: boolean | null }) {
  if (verified !== true) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-accent">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
      verified human
    </span>
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

/** Compact reputation badge for marketplace cards. */
function ScoreBadge({ record, overlay = false }: { record: TrackRecord; overlay?: boolean }) {
  const sc = scoreOf(record);
  // Sitting on a cover gradient, the badge needs its own opaque ground or it is
  // unreadable against the brighter palettes.
  const base = overlay
    ? 'bg-black/55 backdrop-blur-sm border-white/20'
    : '';

  // No graded calls yet means no score to show. Previously this said
  // "Unproven", which is true of every new listing and reads as a warning
  // rather than a fact -- it made the marketplace look like it was full of
  // things not to buy. Silence is the honest rendering of no evidence.
  if (sc.overall === null) return null;
  const tone = sc.overall >= 75 ? 'text-accent border-accent/40' : sc.overall >= 50 ? 'text-amber-400 border-amber-400/40' : 'text-red-400 border-red-400/40';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] ${tone} ${base}`}>
      {sc.overall}
      <span className={overlay ? 'text-white/60' : 'text-muted'}>· {record.receiptCount} call{record.receiptCount === 1 ? '' : 's'}</span>
    </span>
  );
}

/** The four axes, as bars. Null axes render as "not enough evidence". */
function ScoreAxes({ score }: { score: Score }) {
  return (
    <div className="flex flex-col gap-2.5">
      {score.axes.map((ax) => (
        <div key={ax.key}>
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-muted">{ax.label}</span>
            <span className={`font-mono ${ax.value === null ? 'text-muted' : ''}`}>{ax.display}</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
            <div
              className={`h-full rounded-full ${ax.value === null ? 'bg-[#2a2a2a]' : 'bg-accent'}`}
              style={{ width: ax.value === null ? '100%' : `${Math.round(ax.value * 100)}%` }}
            />
          </div>
          <div className="mt-1 text-[10px] leading-relaxed text-muted">{ax.hint}</div>
        </div>
      ))}
    </div>
  );
}

/** One piece of previous work: what was asked for, and whether it landed. */
function ReceiptRowView({ r }: { r: ReceiptRow }) {
  return (
    <li className="border-t border-hairline py-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px]">
            {r.expectation || <span className="text-muted">no expectation recorded</span>}
          </div>
          {r.note && <div className="mt-0.5 text-[10px] leading-relaxed text-muted">{r.note}</div>}
        </div>
        <span className={`shrink-0 font-mono text-[10px] ${MET_COLOR[r.met] ?? 'text-muted'}`}>
          {MET_LABEL[r.met] ?? '—'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted">
        <span>{short(r.buyer)}</span>
        <span>{formatUsdc(r.amount)} USDC</span>
        {r.latencyMs > 0 && <span>{formatLatency(r.latencyMs)}</span>}
        {!r.delivered && <span className="text-red-400">no output</span>}
        <span>{relTime(r.at * 1000)}</span>
      </div>
    </li>
  );
}

// The MCP detail body — shown in the click modal. Every field here is on-chain.
function McpDetails({ l, sellerName }: { l: Listing; sellerName: string }) {
  const tags = l.tags ? l.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const score = scoreOf(l.record);
  const [history, setHistory] = useState<ReceiptRow[] | null>(null);

  // Previous work is fetched lazily — the marketplace grid only needs the
  // aggregates, and most listings are never opened.
  useEffect(() => {
    let alive = true;
    fetchReceipts(l.id, 12).then((rows) => { if (alive) setHistory(rows); });
    return () => { alive = false; };
  }, [l.id]);

  return (
    <>
      <div className="flex items-center gap-3">
        <Avatar name={l.name} size={40} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{l.name}</span>
            <ScoreBadge record={l.record} />
          </div>
          <div className="text-xs text-muted">by {sellerName} · {score.tierLabel}</div>
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

      <div className="mt-4 rounded-lg border border-hairline bg-background p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">Track record</span>
          {score.overall !== null && (
            <span className="font-mono text-[10px] text-muted">
              {l.record.receiptCount} graded call{l.record.receiptCount === 1 ? '' : 's'} · {formatUsdc(l.record.totalPaid)} USDC earned
            </span>
          )}
        </div>
        <div className="mt-2.5">
          <ScoreAxes score={score} />
        </div>
        {score.overall === null && (
          <p className="mt-2.5 text-[10px] leading-relaxed text-muted">
            Nobody has hired this worker yet. Its score appears once buyers grade
            their calls — hiring it first is a bet, and priced like one.
          </p>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-background p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Previous work</div>
        {history === null ? (
          <div className="mt-2 h-8 animate-pulse rounded bg-[#1c1c1c]" />
        ) : history.length === 0 ? (
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            No graded calls yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {history.map((r) => <ReceiptRowView key={r.id} r={r} />)}
          </ul>
        )}
      </div>

       <div className="mt-3 flex items-center justify-between rounded-lg border border-hairline bg-background px-3 py-2">
        <span className="text-[10px] font-bold uppercase text-muted">Worker Wallet </span>
        <Copyable value={l.payTo} className="font-mono text-xs text-muted hover:text-foreground">&nbsp;{short(l.payTo)}</Copyable>
      </div>

      <div className="mt-3 rounded-lg border border-hairline bg-background p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">Endpoint</span>
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

  const [policy, setPolicy] = useState<SpendPolicy>(DEFAULT_POLICY);
  const [allowlist, setAllowlist] = useState<AllowEntry[]>(INITIAL_ALLOWLIST);
  const [policyReady, setPolicyReady] = useState(false);

  // Listing awaiting a per-call cap before it joins the allowlist.
  const [allowFor, setAllowFor] = useState<Listing | null>(null);
  // Paid calls the buyer has not graded yet.
  const [pending, setPending] = useState<PendingReview[]>([]);
  const [reviewing, setReviewing] = useState<PendingReview | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [editPolicy, setEditPolicy] = useState(false);
  // This account's own verification, and every verified account on the marketplace.
  const [worldV, setWorldV] = useState<SellerVerification | null>(null);
  // A review the buyer wants to file but has not proved they are a person for.
  const [gatedReview, setGatedReview] = useState<PendingReview | null>(null);
  const verified = useVerified();

  // ---- live wallet (Privy embedded wallet, on Arc) ----
  // Resolved explicitly rather than via `user.wallet`: for a MetaMask login that
  // field is the MetaMask account, which `useSendTransaction` cannot sign with.
  const embedded = useEmbeddedWallet();
  const walletAddress = embedded.address;
  // Must sit with the other hooks: everything below the `if (!ready) return null`
  // guard runs conditionally, and a hook there breaks the hook order.
  const fileReceipt = useFileReceipt(embedded.address);
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<ArcTx[]>([]);
  const [history, setHistory] = useState<BalancePoint[]>([]);
  const [walletLoading, setWalletLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('1w');
  const [walletNonce, setWalletNonce] = useState(0); // bump to refetch

  // The Gateway balance: separate from the treasury, and the only one an agent
  // payment can actually spend. Read straight from the GatewayWallet contract,
  // so it needs no Circle API key. null means "not read yet or unreadable",
  // which the card must not render as zero.
  const [gatewayBalance, setGatewayBalance] = useState<number | null>(null);
  const [gatewayNonce, setGatewayNonce] = useState(0);
  /** Which wallet prompt the user is looking at, so the button can name it. */
  const [fundStep, setFundStep] = useState<'approving' | 'depositing' | null>(null);
  /** Null until read. Decides whether topping up needs one prompt or two. */
  const [allowance, setAllowance] = useState<number | null>(null);

  useEffect(() => {
    if (!walletAddress) return;
    let alive = true;
    gatewayAllowance(ARC_RPC_URL, walletAddress).then((v) => { if (alive) setAllowance(v); });
    return () => { alive = false; };
  }, [walletAddress, gatewayNonce]);
  const reloadGateway = useCallback(() => setGatewayNonce((n) => n + 1), []);

  useEffect(() => {
    if (!walletAddress) return;
    let alive = true;
    gatewayAvailable(ARC_RPC_URL, walletAddress).then((v) => { if (alive) setGatewayBalance(v); });
    return () => { alive = false; };
  }, [walletAddress, gatewayNonce]);

  /**
   * Verification, used as a filter rather than a decoration.
   *
   * A badge nobody can act on is a sticker. Being able to say "only people who
   * have proved they are one human" is what makes the World check worth doing:
   * it is the difference between a claim on a profile and a rule about who you
   * are willing to hire. It also puts the cost on the right side -- one person
   * spinning up ten seller wallets gets ten listings that this switch hides.
   */
  const isVerifiedOwner = useCallback(
    (owner: string) => !!verified && verified.has(owner.toLowerCase()),
    [verified],
  );

  // money modals
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);

  // live marketplace (subgraph)
  const [market, setMarket] = useState<Listing[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketNonce, setMarketNonce] = useState(0);

  // marketplace detail modal
  const [openId, setOpenId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState<string | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  // Names for every wallet with something listed, so a card can credit a person
  // rather than a hex string. Resolved as a batch: one request for the page,
  // not one per card.
  const directory: Record<string, PublicProfile> | null = useDirectory(
    useMemo(() => market.map((l) => l.owner), [market]),
  );
  const nameFor = useCallback(
    (address: string) => displayName(address, directory),
    [directory],
  );
  const [q, setQ] = useState('');

  // Workers this wallet has published, for the Overview count. The list itself
  // lives on the Workers tab; here we only need how many are live.
  const [ownWorkers, setOwnWorkers] = useState<RegistryAgent[] | null>(null);

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  useEffect(() => {
    try {
      const p = readProfile();
      if (p) setOrg(p.name);
      const w = localStorage.getItem('sovereign_allowlist');
      if (w) setAllowlist(JSON.parse(w));
      setPending(readPending());
    } catch {}
    setPolicy(loadPolicy());
    const fromUrl = tabFromUrl(['overview', 'marketplace', 'allowlist']);
    if (fromUrl) setTab(fromUrl as Tab);
    setOrgReady(true);
    setPolicyReady(true);
  }, []);

  // Persist spend policy + allowlist locally so limits survive a reload.
  useEffect(() => {
    if (!policyReady) return;
    try {
      localStorage.setItem('sovereign_policy', JSON.stringify(policy));
      localStorage.setItem('sovereign_allowlist', JSON.stringify(allowlist));
    } catch {}
  }, [policy, allowlist, policyReady]);

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

  // The workers this wallet has published — one number on Overview, read from
  // the same subgraph the Workers tab reads.
  useEffect(() => {
    if (!walletAddress) return;
    let alive = true;
    fetchAgentsByOwner(walletAddress)
      .then((rows) => { if (alive) setOwnWorkers(rows); })
      .catch(() => { if (alive) setOwnWorkers([]); });
    return () => { alive = false; };
  }, [walletAddress]);

  useEffect(() => {
    let alive = true;
    setMarketLoading(true);
    setMarketError(null);
    fetchMarket()
      .then((rows) => { if (alive) { setMarket(rows); setMarketLoading(false); } })
      .catch(() => { if (alive) { setMarketError('Could not reach the subgraph.'); setMarketLoading(false); } });
    return () => { alive = false; };
  }, [marketNonce]);

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

  // A link from sovereign-mcp: the agent already knows the worker and what was
  // asked for, so carry that straight into the right modal instead of making the
  // human retype it. Runs once the market is loaded, since `hire` needs the
  // Listing. The query string is stripped afterwards so a refresh does not
  // re-open the modal.
  const handoffDone = useRef(false);
  useEffect(() => {
    if (handoffDone.current || marketLoading) return;
    const h = readHandoff(window.location.search);
    if (!h) return;
    handoffDone.current = true;

    if (h.kind === 'hire') {
      // Older sovereign-mcp builds sent people here to pay by hand. That path is
      // gone: a transfer made in this tab never called the worker, so it could
      // take the money and return nothing. Paying now happens in the same breath
      // as the call, in the terminal. Show the worker rather than a dead end.
      const listing = market.find((l) => l.id === h.agentId);
      if (listing) {
        setTab('marketplace');
        setOpenId(listing.id);
        setHandoffError(
          `Claude sent you here to pay ${h.agentName} by hand. Paying from this page is no longer possible, ` +
          `because a transfer made here does not call the worker — it could charge you for nothing. ` +
          `Let the terminal pay: it only releases the money when the worker answers.`,
        );
      } else {
        setHandoffError(`Claude referred you to "${h.agentName}", but it is not an active listing.`);
      }
    } else {
      const review: PendingReview = {
        settlementRef: h.settlementRef,
        agentId: h.agentId,
        agentName: h.agentName,
        amountUsdc: h.amountUsdc,
        expectation: h.expectation,
        hiredAt: Date.now(),
        buyerAgentId: '',
        latencyMs: h.latencyMs,
        delivered: h.delivered,
      };
      addPending(review);
      setPending(readPending());
      setTab('overview');
      setReviewing(review);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, [marketLoading, market]);

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

  /**
   * What the treasury actually did over the window the chart is showing.
   *
   * Earnings and expenditure were a separate page, which made the one question
   * anybody has — am I up or down — a navigation problem. Netting the transfers
   * in the selected range answers it beside the balance itself. Gas is included
   * in the outgoing side: on Arc it is paid in USDC, so leaving it out would
   * overstate the result by exactly the amount the user was charged.
   */
  const pnl = useMemo(() => {
    const win = rangeDef(range).windowMs;
    const since = win === null ? 0 : Date.now() - win;
    let earned = 0;
    let spent = 0;
    for (const t of txs) {
      if (t.ts < since || t.status !== 'ok') continue;
      if (t.direction === 'in') earned += t.value;
      else if (t.direction === 'out') spent += t.value + t.fee;
      else spent += t.fee; // self-transfer: only the gas actually leaves
    }
    return { earned, spent, net: earned - spent };
  }, [txs, range]);

  const activeWorkers = ownWorkers === null ? null : ownWorkers.filter((a) => a.active).length;

  if (!ready || !authenticated || !orgReady) return null;

  // ---------- Onboarding ----------
  if (!org) {
    return <OnboardingCard logout={logout} onDone={(p) => setOrg(p.name)} />;
  }

  const setCap = (id: string, v: string) =>
    setAllowlist((list) => list.map((w) => (w.id === id ? { ...w, cap: Number(v) || 0 } : w)));
  const removeWl = (id: string) => setAllowlist((list) => list.filter((w) => w.id !== id));

  const openListing = market.find((l) => l.id === openId) || null;
  // Curated before anything else. A listing this deployment declines to serve
  // should not be findable by search either, or the search box becomes the way
  // around the decision.
  const servable = withoutHidden(market);
  const filtered = servable.filter((l) => {
    if (verifiedOnly && !isVerifiedOwner(l.owner)) return false;
    return (l.name + ' ' + l.summary + ' ' + l.tags + ' ' + l.owner)
      .toLowerCase()
      .includes(q.trim().toLowerCase());
  });
  const verifiedCount = servable.filter((l) => isVerifiedOwner(l.owner)).length;
  const isAllowlisted = (id: string) => allowlist.some((w) => w.listingId === id);

  /** Asks for a per-call cap before trusting a worker, rather than assuming one. */
  const addToAllowlist = (l: Listing) => {
    if (isAllowlisted(l.id)) return;
    setAllowFor(l);
  };

  const commitAllowlist = (l: Listing, cap: number) => {
    setAllowlist((list) => [
      ...list.filter((w) => w.listingId !== l.id),
      { id: 'wl_' + l.id, listingId: l.id, name: l.name, address: l.payTo, cap },
    ]);
    setAllowFor(null);
  };

  const reloadWallet = () => setWalletNonce((n) => n + 1);


  /**
   * Move USDC from the treasury into Gateway, so agents can spend it.
   *
   * ERC-20 makes this two transactions the first time and there is no way
   * around it here: GatewayWallet has no permit or receiveWithAuthorization, so
   * `deposit` can only move tokens an allowance already covers, and this Privy
   * version has no EIP-5792 batching to fold the pair into one confirmation.
   *
   * What we can do is stop charging for it twice. The allowance is read first,
   * and when it already covers the amount only the deposit is sent, which is
   * one prompt. When it does not, the approval asks for headroom rather than
   * the exact amount, so the next several top-ups are also one prompt.
   *
   * A failed allowance read approves rather than assuming: guessing wrong the
   * optimistic way costs a prompt AND a gas fee to discover a revert.
   */
  const fundGateway = async (amount: string): Promise<void> => {
    if (!walletAddress) throw new Error('No wallet');
    const want = Number(amount);
    const current = await gatewayAllowance(ARC_RPC_URL, walletAddress);

    try {
      if (current === null || current < want) {
        setFundStep('approving');
        await sendTransaction(
          {
            to: GATEWAY.usdc,
            data: approveData(String(Math.max(want, APPROVAL_HEADROOM_USDC))),
            chainId: ARC_CHAIN_ID,
          },
          { address: walletAddress },
        );
      }

      setFundStep('depositing');
      await sendTransaction(
        { to: GATEWAY.wallet, data: depositData(amount), chainId: ARC_CHAIN_ID },
        { address: walletAddress },
      );
    } finally {
      // Cleared even when a prompt is rejected, or the button keeps claiming to
      // be waiting on a confirmation that is no longer coming. Refreshed on the
      // way out too: an approval that landed before the deposit was rejected
      // still changed the allowance, and the next attempt should know.
      setFundStep(null);
      reloadWallet();
      reloadGateway();
    }
  };
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

  // There is deliberately no pay-from-the-browser path any more. Sending USDC
  // from this tab moved money without ever calling the worker's endpoint, so a
  // broken worker could be paid in full and deliver nothing — which is exactly
  // what happened. Payment belongs inside the call, where a failure can stop
  // settlement, and that lives in sovereign-mcp.

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <SideNav
        route="dashboard"
        tab={tab}
        onTab={(t) => { setTab(t as Tab); setSellerId(null); }}
        name={org}
        address={walletAddress}
        fallback={user?.email?.address}
        onSignOut={logout}
      />

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">

          {/* Above the tab switch, because a handoff from Claude can land the
              buyer on any tab and the note explaining why is the first thing
              they need to read. */}
          {handoffError && (
            <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-[11px] leading-relaxed text-amber-400">
              {handoffError}
            </div>
          )}

          {tab === 'overview' && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
                  <p className="mt-1 text-sm text-muted">What you earn, what you spend, and the rules it happens under.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowDeposit(true)} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">Add funds</button>
                  <button onClick={() => setShowWithdraw(true)} className="rounded-lg border border-hairline px-4 py-2 text-sm text-muted transition-colors hover:text-foreground">Withdraw</button>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat
                  label="Treasury balance"
                  value={balance === null ? '—' : `$${formatUsdc(balance)}`}
                  delta={balance === null || walletLoading ? undefined : pnl.net}
                  sub={walletError ? 'balance unavailable' : `as of today`}
                />
                <Stat
                  label="Active workers"
                  value={activeWorkers === null ? '—' : String(activeWorkers)}
                  sub={ownWorkers === null ? 'reading the registry' : `${ownWorkers.length} listed`}
                />
                <Stat label="Allowlisted workers" value={String(allowlist.length)} sub="with autopay" />
              </div>

              {pending.length > 0 && (
                <div className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/5 p-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium">Awaiting your review</h2>
                    <span className="font-mono text-[11px] text-muted">{pending.length}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    You paid for these. Grading them is what gives the next buyer something to go on.
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {pending.map((r) => (
                      <li key={r.settlementRef} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-background px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm">{r.agentName}</div>
                          <div className="truncate text-[10px] text-muted">
                            {r.expectation || 'no expectation recorded'} · {relTime(r.hiredAt)}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            onClick={() => { removePending(r.settlementRef); setPending(readPending()); }}
                            className="text-[11px] text-muted transition-colors hover:text-foreground"
                          >
                            Dismiss
                          </button>
                          <button
                            onClick={() => (worldV ? setReviewing(r) : setGatedReview(r))}
                            className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-black transition-opacity hover:opacity-90"
                          >
                            Rate
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <BalanceCard series={series} range={range} setRange={setRange} loading={walletLoading} error={walletError} hasWallet={!!walletAddress} onAdd={() => setShowDeposit(true)} />

              <AgentFunds
                available={gatewayBalance}
                allowance={allowance}
                step={fundStep}
                onFund={fundGateway}
                onRefresh={reloadGateway}
                hasWallet={!!walletAddress}
              />

              {/* The spend policy used to be a card in a roster of buyer agents.
                  There is one of them now, and it governs every hire, so it reads
                  as a property of the account rather than an object to manage. */}
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-hairline bg-panel p-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-medium">Spend limits</h2>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
                    <div className="text-muted">Daily budget</div><div className="text-right font-mono">${policy.dailyBudget}</div>
                    <div className="text-muted">Per action</div><div className="text-right font-mono">${policy.perAction}</div>
                    <div className="text-muted">Approval over</div><div className="text-right font-mono">${policy.approvalThreshold}</div>
                  </div>
                  <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (policy.spentToday / policy.dailyBudget) * 100 || 0)}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-muted">${policy.spentToday} of ${policy.dailyBudget} today</div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => setEditPolicy(true)} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">Edit limits</button>
                    <button onClick={() => setPolicy((p) => ({ ...p, paused: !p.paused }))} className="flex-1 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">
                      {policy.paused ? 'Resume spending' : 'Pause spending'}
                    </button>
                  </div>
                </div>

                <WorkerEarnings owner={walletAddress} />
              </div>

              <ActivityFeed items={feed} loading={walletLoading} error={walletError} />
            </>
          )}

          {tab === 'marketplace' && (
            <>
              {sellerId ? (
                <>
                  <button onClick={() => setSellerId(null)} className="text-sm text-muted transition-colors hover:text-foreground">← Back to marketplace</button>
                  <div className="mt-4 flex items-center gap-4">
                    <Avatar name={nameFor(sellerId)} size={56} />
                    <div>
                      <h1 className="text-xl font-semibold tracking-tight">{nameFor(sellerId)}</h1>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <HumanBadge verified={verified === null ? null : verified.has(sellerId.toLowerCase())} />
                        <Copyable value={sellerId} className="font-mono text-muted hover:text-foreground">{short(sellerId)}</Copyable>
                      </div>
                    </div>
                  </div>
                  <p className="mt-6 text-sm text-muted">Workers published by this wallet</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {servable.filter((l) => l.owner === sellerId).map((l) => (
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
              <p className="mt-1 text-sm text-muted">Workers you can hire — live from the on-chain registry.</p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search workers…"
                  className="min-w-[12rem] flex-1 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
                {/* Hidden entirely while the verified set is still loading or
                    the contract is not deployed: a filter that would blank the
                    board is worse than no filter. */}
                {verified && verified.size > 0 && (
                  <button
                    onClick={() => setVerifiedOnly((v) => !v)}
                    aria-pressed={verifiedOnly}
                    className={`shrink-0 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                      verifiedOnly
                        ? 'border-accent text-accent'
                        : 'border-hairline text-muted hover:text-foreground'
                    }`}
                  >
                    <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${verifiedOnly ? 'bg-accent' : 'bg-muted'}`} />
                    Verified humans only
                  </button>
                )}
              </div>
              {marketLoading && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">Loading workers from the subgraph…</div>}
              {!marketLoading && marketError && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-red-400">{marketError}</div>}
              {!marketLoading && !marketError && servable.length === 0 && <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">No workers registered on-chain yet.</div>}
              {!marketLoading && !marketError && servable.length > 0 && filtered.length === 0 && (
                <div className="mt-6 rounded-xl border border-hairline bg-panel p-8 text-center text-sm text-muted">
                  {verifiedOnly && !q.trim()
                    ? 'No listings yet from sellers who have proved they are a unique human.'
                    : `No workers match “${q}”${verifiedOnly ? ' among verified sellers' : ''}.`}
                </div>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {filtered.map((l) => (
                  <div key={l.id} className="overflow-hidden rounded-xl border border-hairline bg-panel">
                    <div className="relative">
                      <Cover name={l.name} />
                      <div className="absolute right-3 top-3">
                        <ScoreBadge record={l.record} overlay />
                      </div>
                    </div>
                    <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <button onClick={() => setSellerId(l.owner)} aria-label="View seller profile" className="shrink-0">
                          <Avatar name={nameFor(l.owner)} />
                        </button>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{l.name}</div>
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                            <span>by <button onClick={() => setSellerId(l.owner)} className="underline underline-offset-2 hover:text-foreground">{nameFor(l.owner)}</button></span>
                            <HumanBadge verified={verified === null ? null : verified.has(l.owner.toLowerCase())} />
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setOpenId(l.id)}
                        className="inline-flex shrink-0 items-center gap-1 text-sm text-muted transition-colors hover:text-foreground"
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
              <p className="mt-1 text-sm text-muted">Workers you can pay without approving each call, each with its own per-call cap.</p>
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
                            <span className="text-muted">Per-call cap</span>
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
        <ModalShell
          onClose={() => setOpenId(null)}
          footer={
            <button
              onClick={() => addToAllowlist(openListing)}
              disabled={isAllowlisted(openListing.id)}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${isAllowlisted(openListing.id) ? 'cursor-default border border-accent text-accent opacity-70' : 'border border-hairline text-muted hover:text-foreground'}`}
            >
              {isAllowlisted(openListing.id) ? 'Allowlisted ✓' : 'Add to allowlist'}
            </button>
          }
        >
          <McpDetails l={openListing} sellerName={nameFor(openListing.owner)} />
        </ModalShell>
      )}

      {/* Add funds (deposit) modal */}
      {showDeposit && (
        <DepositModal address={walletAddress} onFunded={reloadWallet} onClose={() => setShowDeposit(false)} />
      )}

      {/* Withdraw modal */}
      {showWithdraw && (
        <WithdrawModal address={walletAddress} balance={balance} onWithdraw={withdraw} onClose={() => setShowWithdraw(false)} />
      )}

      {reviewing && (
        <ReviewModal
          review={reviewing}
          onFile={async (met, delivered, note, latencyMs) => {
            const hash = await fileReceipt({
              agentId: reviewing.agentId,
              settlementRef: reviewing.settlementRef,
              amountUsdc: reviewing.amountUsdc,
              latencyMs,
              delivered,
              met,
              expectation: reviewing.expectation,
              note,
            });
            removePending(reviewing.settlementRef);
            setPending(readPending());
            // The subgraph needs a few seconds to index the receipt before the
            // worker's profile reflects it.
            setTimeout(() => setMarketNonce((n) => n + 1), 5000);
            return hash;
          }}
          onClose={() => setReviewing(null)}
        />
      )}
      {gatedReview && (
        <VerifyGate
          wallet={walletAddress}
          action="review a worker"
          reason="A review is the only thing another buyer has to go on. One person with ten wallets could five-star their own worker to the top of the marketplace, so a receipt has to come from a human who can only do it once."
          onVerified={(v) => { setWorldV(v); const r = gatedReview; setGatedReview(null); setReviewing(r); }}
          onClose={() => setGatedReview(null)}
        />
      )}
      {allowFor && (
        <AllowlistCapModal
          listing={allowFor}
          policy={policy}
          onConfirm={(cap) => commitAllowlist(allowFor, cap)}
          onClose={() => setAllowFor(null)}
        />
      )}

      {/* Edit the account's spend limits */}
      {editPolicy && (
        <EditPolicyModal
          policy={policy}
          onSave={(patch) => setPolicy((p) => ({ ...p, ...patch }))}
          onClose={() => setEditPolicy(false)}
        />
      )}
    </div>
  );
}

/**
 * Grades one paid call against the expectation the buyer stated before hiring.
 *
 * The expectation is shown read-only at the top: the point is to judge the result
 * against what was actually asked for, not to rewrite the ask after seeing the
 * answer. Filing writes a receipt on-chain, which is what the next buyer reads.
 */
function ReviewModal({
  review, onFile, onClose,
}: {
  review: PendingReview;
  onFile: (met: number, delivered: boolean, note: string, latencyMs: number) => Promise<string>;
  onClose: () => void;
}) {
  const [met, setMet] = useState<number | null>(null);
  // Prefilled when the agent made the call itself and measured it.
  const [delivered, setDelivered] = useState(review.delivered !== false);
  const [note, setNote] = useState('');
  const [latency, setLatency] = useState(review.latencyMs ? String(review.latencyMs) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const OPTIONS = [
    { v: 2, label: 'Met', hint: 'Got what I asked for.' },
    { v: 1, label: 'Partially', hint: 'Useful, but incomplete.' },
    { v: 0, label: 'Not met', hint: 'Did not answer the ask.' },
  ];

  const submit = async () => {
    if (met === null || busy) return;
    setErr(null);
    setBusy(true);
    try {
      // A worker that produced nothing cannot have met the expectation.
      const effectiveMet = delivered ? met : 0;
      setHash(await onFile(effectiveMet, delivered, note.trim(), Number(latency) || 0));
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : 'Could not file the receipt.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      {hash ? (
        <>
          <h2 className="text-lg font-semibold tracking-tight">Review filed</h2>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            On-chain for {review.agentName}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            It will appear on this worker&apos;s profile once the subgraph indexes it, a few seconds from now.
          </p>
          <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
            View on Arcscan <ArrowUpRight />
          </a>
          <button onClick={onClose} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Done</button>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold tracking-tight">Did it meet expectations?</h2>
          <p className="mt-1 text-sm text-muted">{review.agentName} · {formatUsdc(Number(review.amountUsdc))} USDC</p>

          <div className="mt-4 rounded-lg border border-hairline bg-background p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted">You asked for</div>
            <div className="mt-1 text-[11px] leading-relaxed">
              {review.expectation || <span className="text-muted">No expectation was recorded at hire time.</span>}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {OPTIONS.map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setMet(o.v)}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${met === o.v ? 'border-accent bg-accent/5' : 'border-hairline hover:border-muted'}`}
              >
                <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${met === o.v ? 'border-accent bg-accent' : 'border-hairline'}`} />
                <span className="text-sm">
                  {o.label}
                  <span className="block text-[11px] text-muted">{o.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-muted">
            <input type="checkbox" checked={!delivered} onChange={(e) => setDelivered(!e.target.checked)} className="mt-0.5 accent-[color:var(--accent)]" />
            <span>It returned nothing usable at all (error, timeout, or empty output).</span>
          </label>

          <div className="mt-3 grid grid-cols-[1fr_auto] gap-3">
            <label className="text-sm">
              <span className="text-muted">Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={400}
                placeholder="What was good or missing"
                className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="text-sm">
              <span className="text-muted">Took (ms)</span>
              <input
                value={latency}
                onChange={(e) => setLatency(e.target.value)}
                inputMode="numeric"
                placeholder="—"
                className="mt-1 w-24 rounded-lg border border-hairline bg-background px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>

          {!receiptsConfigured && (
            <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-400">
              NEXT_PUBLIC_RECEIPTS_ADDRESS is not set — deploy Receipts.sol and add it before reviews can be filed.
            </div>
          )}
          {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

          <div className="mt-5 flex gap-3">
            <button
              disabled={met === null || busy || !receiptsConfigured}
              onClick={submit}
              className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Confirm in wallet…' : 'File review on-chain'}
            </button>
            <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Later</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/**
 * The one decision worth making at the moment you trust a worker: how much a
 * single call of theirs may cost.
 *
 * This used to also ask which of your buyer agents the entry applied to. With one
 * policy per account that question has no answer left to give, so the modal is
 * the cap and nothing else — pre-filled from the listing's own price, which is
 * what a buyer almost always means by "yes, this much".
 */
function AllowlistCapModal({
  listing, policy, onConfirm, onClose,
}: {
  listing: Listing;
  policy: SpendPolicy;
  onConfirm: (cap: number) => void;
  onClose: () => void;
}) {
  const price = Number(listing.price || 0);
  // Headroom rather than the exact price: a worker that later raises its price by
  // a cent would otherwise be silently blocked by a cap the buyer never revisited.
  const [cap, setCap] = useState(String(Math.max(1, Math.ceil(price * 2)) || 5));
  const capNum = Number(cap) || 0;

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Allowlist “{listing.name}”</h2>
      <p className="mt-1 text-sm text-muted">
        Allowlisted workers can be paid without approving each call, up to the cap you set here.
      </p>

      <div className="mt-4 rounded-lg border border-hairline bg-background p-3 text-sm">
        <div className="flex items-center justify-between"><span className="text-muted">Charges</span><span className="font-mono">{listing.price} USDC/call</span></div>
        <div className="mt-1 flex items-center justify-between"><span className="text-muted">Pays to</span><span className="font-mono text-xs">{shortHash(listing.payTo)}</span></div>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-muted">Per-call cap for this worker (USDC)</span>
        <input
          autoFocus
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          inputMode="decimal"
          className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent"
        />
      </label>

      {capNum > 0 && price > capNum && (
        <div className="mt-2 text-[11px] leading-relaxed text-amber-400">
          This worker charges ${price} per call, above the ${capNum} cap — every hire would be refused.
        </div>
      )}
      {price > policy.perAction && (
        <div className="mt-2 text-[11px] leading-relaxed text-amber-400">
          Your per-action limit is ${policy.perAction}, below this worker&apos;s ${price} — raise it on Overview or hires will still be blocked.
        </div>
      )}

      <div className="mt-5 flex gap-3">
        <button
          onClick={() => onConfirm(capNum)}
          className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
        >
          Add to allowlist
        </button>
        <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
      </div>
    </ModalShell>
  );
}

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
/**
 * The shell every modal sits in.
 *
 * The panel is capped and scrolls INSIDE itself rather than letting the page
 * scroll around it. Centring a taller-than-viewport box with flexbox puts its
 * top above the scroll container's origin, and overflow cannot reach backwards
 * past that origin -- so the top of a long modal becomes unreachable no matter
 * how much you scroll. Capping the height means centring never has to overflow,
 * which removes the condition rather than patching the symptom.
 *
 * 5rem is the outer py-10 top and bottom, subtracted so the cap accounts for
 * its own padding. dvh rather than vh because mobile browser chrome changes the
 * viewport and vh does not notice.
 *
 * `footer` stays outside the scroll area: the primary action of a long modal
 * should not require scrolling to reach.
 */
function ModalShell({
  onClose, children, footer,
}: {
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-6 py-10 sm:items-center" onClick={onClose}>
      <div
        className="relative flex max-h-[calc(100dvh-5rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* On the panel, not inside the scroller, or it scrolls out of reach. */}
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 text-muted transition-colors hover:text-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
        {footer && <div className="shrink-0 border-t border-hairline p-4">{footer}</div>}
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

/**
 * The balance agent payments actually draw on.
 *
 * Given its own card rather than folded into the treasury because they are
 * genuinely two balances and conflating them produces the worst bug in this
 * product: a wallet visibly full of USDC where every agent call fails with a
 * signing error that mentions neither USDC nor balances. Funding is one-way and
 * deliberate; what comes back out goes through Circle's withdrawal, which is
 * why this does not offer a button for it.
 */
function AgentFunds({
  available, allowance, step, onFund, onRefresh, hasWallet,
}: {
  available: number | null;
  /** USDC the Gateway contract may already take. Null if unread. */
  allowance: number | null;
  step: 'approving' | 'depositing' | null;
  onFund: (amount: string) => Promise<void>;
  onRefresh: () => void;
  hasWallet: boolean;
}) {
  const [amount, setAmount] = useState('5');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // How many wallet prompts this will cost, worked out before they commit
  // rather than discovered halfway through. An unread allowance counts as two,
  // because that is what the code will do.
  const needsApproval = allowance === null || allowance < (Number(amount) || 0);
  const prompts = needsApproval ? 2 : 1;

  const fund = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) { setErr('Enter an amount above zero.'); return; }
    setErr(null);
    setBusy(true);
    try {
      await onFund(amount);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  // Empty and unknown are different states and must not look the same: one
  // means top up, the other means we could not reach the chain.
  const empty = available !== null && available <= 0;

  return (
    <div className="mt-8 rounded-xl border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Agent spending balance</h2>
          <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
            What Claude can spend on your behalf. It is held separately from your
            treasury, because an x402 payment is authorised against this balance
            rather than transferred out of your wallet. Topping it up is the one
            step that decides how much an agent can ever spend without you.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg">
            {available === null ? '—' : `$${formatUsdc(available)}`}
          </div>
          <button onClick={onRefresh} className="text-[10px] text-muted underline underline-offset-2 hover:text-foreground">
            refresh
          </button>
        </div>
      </div>

      {available === null && hasWallet && (
        <div className="mt-3 text-[11px] text-muted">
          Could not read this balance just now. It is not necessarily empty.
        </div>
      )}
      {empty && (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
          Empty, so every agent payment will fail at signing time even though your
          treasury has funds. Move some across to start.
        </div>
      )}

      {open ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="flex items-center rounded-lg border border-hairline bg-background pl-2 focus-within:border-accent">
            <span className="text-sm text-muted">$</span>
            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="w-20 bg-transparent px-1.5 py-2 text-sm outline-none"
            />
          </span>
          <button
            disabled={busy}
            onClick={fund}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {!busy
              ? `Move across${prompts === 2 ? ' (2 confirmations)' : ''}`
              : step === 'approving'
                ? 'Confirm the approval…'
                : step === 'depositing'
                  ? 'Confirm the transfer…'
                  : 'Working…'}
          </button>
          <button onClick={() => { setOpen(false); setErr(null); }} className="text-sm text-muted hover:text-foreground">
            Cancel
          </button>
          <span className="w-full text-[10px] leading-relaxed text-muted">
            {needsApproval ? (
              <>
                Two confirmations this time: one allowing the Gateway contract to take
                USDC, one moving it. The allowance is set to $
                {Math.max(Number(amount) || 0, APPROVAL_HEADROOM_USDC)} rather than
                just this amount, so later top-ups take a single confirmation.
              </>
            ) : (
              <>One confirmation. The Gateway contract is already allowed to take up to ${allowance}.</>
            )}
          </span>
        </div>
      ) : (
        <button
          disabled={!hasWallet}
          onClick={() => setOpen(true)}
          className="mt-4 rounded-lg border border-hairline px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-40"
        >
          Top up agent spending
        </button>
      )}

      {err && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>
      )}
    </div>
  );
}

function EditPolicyModal({
  policy, onSave, onClose,
}: {
  policy: SpendPolicy;
  onSave: (patch: Partial<SpendPolicy>) => void;
  onClose: () => void;
}) {
  const [dailyBudget, setDailyBudget] = useState(String(policy.dailyBudget));
  const [perAction, setPerAction] = useState(String(policy.perAction));
  const [approvalThreshold, setApprovalThreshold] = useState(String(policy.approvalThreshold));

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
      <h2 className="text-lg font-semibold tracking-tight">Edit spend limits</h2>
      <p className="mt-1 text-sm text-muted">Enforced before every hire, whether you or Claude starts it.</p>
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

// app/lib/arc.ts
// Live on-chain data for a Privy embedded wallet on Arc (Circle's USDC-native L1).
//
// Arc quirk that shapes everything here: USDC is the NATIVE gas token and native
// value fields are denominated in 6 decimals (not 18). So a transaction's `value`
// and an address's `coin_balance` are raw base-6 integers — divide by 1e6 for USDC.
// Because USDC is native, payments are native value-transfers, NOT ERC-20 Transfer
// events, so the address's transaction list is the single source of truth for both
// the balance history / expenditure chart and the activity feed.
//
// Data source: Arcscan (a Blockscout instance) REST API v2.

export const ARC_CHAIN_ID = 5042002;
// Arc's native value fields (eth_getBalance, tx `value`, Blockscout coin_balance)
// are 18-decimal wei — verified empirically against a real faucet balance. (USDC as
// an asset is a 6-decimal token, but the native coin the chain moves is 18-decimal.)
export const USDC_DECIMALS = 18;
const USDC_SCALE = 1e18;

export const ARC_EXPLORER =
  process.env.NEXT_PUBLIC_ARC_EXPLORER || 'https://testnet.arcscan.app';
export const FAUCET_URL = 'https://faucet.circle.com';

export const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

// ---- registry (The Graph) ----

export type RegistryAgent = {
  id: string;
  name: string;
  description: string;
  tags: string;
  price: string; // USDC per call
  endpoint: string;
  payTo: string;
  owner: string;
  active: boolean;
};

function mapAgent(a: any): RegistryAgent {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    tags: a.tags,
    price: (Number(a.pricePerCall) / 1e6).toString(),
    endpoint: a.endpoint,
    payTo: a.payTo,
    owner: a.owner,
    active: !!a.active,
  };
}

/** All agents registered on-chain by a given owner address (newest first). */
export async function fetchAgentsByOwner(owner: string): Promise<RegistryAgent[]> {
  const query = `{ agents(where: { owner: "${owner.toLowerCase()}" }, orderBy: createdAt, orderDirection: desc, first: 100) { id name description tags endpoint pricePerCall payTo owner active } }`;
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('subgraph error');
  return (json.data?.agents ?? []).map(mapAgent);
}

// ---------------------------------------------------------------- types

export type ArcTx = {
  hash: string;
  from: string;
  to: string | null;
  value: number; // USDC
  fee: number; // USDC gas (Arc pays gas in native USDC)
  ts: number; // ms epoch
  status: 'ok' | 'error';
  method: string | null;
  direction: 'in' | 'out' | 'self';
};

export type RangeKey = '1d' | '1w' | '1m' | '6m' | '1y' | '5y' | 'all';
type BucketUnit = 'hour' | 'day' | 'week' | 'month';

export type RangeDef = {
  key: RangeKey;
  label: string;
  windowMs: number | null; // null = all-time
  chart: 'line' | 'bar';
  bucket: BucketUnit;
  fallback: boolean; // eligible to fall back to all-time when history is too short
};

const DAY = 86_400_000;

export const RANGES: RangeDef[] = [
  { key: '1d', label: '1D', windowMs: DAY, chart: 'line', bucket: 'hour', fallback: false },
  { key: '1w', label: '1W', windowMs: 7 * DAY, chart: 'bar', bucket: 'day', fallback: false },
  { key: '1m', label: '1M', windowMs: 30 * DAY, chart: 'bar', bucket: 'day', fallback: false },
  { key: '6m', label: '6M', windowMs: 182 * DAY, chart: 'bar', bucket: 'week', fallback: false },
  { key: '1y', label: '1Y', windowMs: 365 * DAY, chart: 'bar', bucket: 'month', fallback: false },
  { key: '5y', label: '5Y', windowMs: 5 * 365 * DAY, chart: 'bar', bucket: 'month', fallback: false },
  { key: 'all', label: 'All', windowMs: null, chart: 'bar', bucket: 'month', fallback: false },
];

export const rangeDef = (key: RangeKey): RangeDef =>
  RANGES.find((r) => r.key === key) || RANGES[0];

// ---------------------------------------------------------------- fetching

const api = (path: string) => `${ARC_EXPLORER.replace(/\/$/, '')}/api/v2${path}`;

/** Live native-USDC balance of an address (0 if the address has no history yet). */
export async function fetchBalance(address: string): Promise<number> {
  const res = await fetch(api(`/addresses/${address}`));
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`balance ${res.status}`);
  const json = await res.json();
  const raw = json?.coin_balance;
  return raw ? Number(raw) / USDC_SCALE : 0;
}

type RawTx = {
  hash: string;
  timestamp: string | null;
  value: string | null;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  status?: string | null; // "ok" | "error"
  result?: string | null;
  method?: string | null;
  fee?: { value?: string | null } | null;
};

function normalize(t: RawTx, wallet: string): ArcTx {
  const w = wallet.toLowerCase();
  const from = (t.from?.hash || '').toLowerCase();
  const to = t.to?.hash ? t.to.hash.toLowerCase() : null;
  const direction: ArcTx['direction'] =
    from === w && to === w ? 'self' : from === w ? 'out' : 'in';
  return {
    hash: t.hash,
    from,
    to,
    value: t.value ? Number(t.value) / USDC_SCALE : 0,
    fee: t.fee?.value ? Number(t.fee.value) / USDC_SCALE : 0,
    ts: t.timestamp ? new Date(t.timestamp).getTime() : 0,
    status: t.status === 'error' || t.result === 'error' ? 'error' : 'ok',
    method: t.method || null,
    direction,
  };
}

// ---- balance history (actual on-chain balance after every change) ----

export type BalancePoint = { ts: number; balance: number };

type RawBalanceItem = {
  block_timestamp?: string | null;
  value?: string | null; // coin balance AFTER the change, base units
};

/**
 * The wallet's native-USDC balance after each change, oldest→newest. This captures
 * ALL balance movements — including internal transfers (e.g. faucet payouts) that
 * never appear in the plain transactions list — so it's the right source for a
 * balance-over-time chart.
 */
export async function fetchBalanceHistory(
  address: string,
  opts: { maxPages?: number } = {}
): Promise<BalancePoint[]> {
  const maxPages = opts.maxPages ?? 10;
  const out: BalancePoint[] = [];
  let params: Record<string, string | number> | null = null;

  for (let page = 0; page < maxPages; page++) {
    const qs: string = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const res: Response = await fetch(api(`/addresses/${address}/coin-balance-history${qs}`));
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`balance-history ${res.status}`);
    const json: any = await res.json();
    const items: RawBalanceItem[] = json?.items ?? [];
    for (const it of items) {
      if (!it.block_timestamp) continue;
      out.push({ ts: new Date(it.block_timestamp).getTime(), balance: it.value ? Number(it.value) / USDC_SCALE : 0 });
    }
    if (!json?.next_page_params) break;
    params = json.next_page_params;
  }
  // API returns newest-first; sort oldest-first for sampling.
  return out.filter((p) => p.ts > 0).sort((a, b) => a.ts - b.ts);
}

/**
 * Paginate an address's transactions (newest first). Stops at `maxPages`, or once
 * results are older than `sinceMs` (results are block-desc, so once we pass the
 * cutoff nothing newer follows). A page cap keeps "all-time" from running forever.
 */
export async function fetchWalletTxs(
  address: string,
  opts: { maxPages?: number; sinceMs?: number } = {}
): Promise<ArcTx[]> {
  const maxPages = opts.maxPages ?? 12;
  const out: ArcTx[] = [];
  let params: Record<string, string | number> | null = null;

  for (let page = 0; page < maxPages; page++) {
    const qs: string = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const res: Response = await fetch(api(`/addresses/${address}/transactions${qs}`));
    if (res.status === 404) break; // address not seen on-chain yet
    if (!res.ok) throw new Error(`txs ${res.status}`);
    const json: any = await res.json();
    const items: RawTx[] = json?.items ?? [];
    for (const it of items) out.push(normalize(it, address));

    const oldest = items.length ? out[out.length - 1].ts : 0;
    if (opts.sinceMs && oldest && oldest < opts.sinceMs) break;
    if (!json?.next_page_params) break;
    params = json.next_page_params;
  }
  return out;
}

type RawInternalTx = {
  timestamp?: string | null;
  value?: string | null;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  transaction_hash?: string | null;
};

/**
 * Internal transactions (value moved inside a contract call). Faucet payouts and
 * many contract-mediated transfers land here rather than in the top-level tx list,
 * so the activity feed needs these to show incoming deposits.
 */
export async function fetchInternalTxs(
  address: string,
  opts: { maxPages?: number } = {}
): Promise<ArcTx[]> {
  const maxPages = opts.maxPages ?? 6;
  const out: ArcTx[] = [];
  const w = address.toLowerCase();
  let params: Record<string, string | number> | null = null;

  for (let page = 0; page < maxPages; page++) {
    const qs: string = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const res: Response = await fetch(api(`/addresses/${address}/internal-transactions${qs}`));
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`internal-txs ${res.status}`);
    const json: any = await res.json();
    const items: RawInternalTx[] = json?.items ?? [];
    for (const it of items) {
      const from = (it.from?.hash || '').toLowerCase();
      const to = it.to?.hash ? it.to.hash.toLowerCase() : null;
      const value = it.value ? Number(it.value) / USDC_SCALE : 0;
      if (value <= 0) continue; // only value-moving internals are interesting here
      out.push({
        hash: it.transaction_hash || '',
        from,
        to,
        value,
        fee: 0,
        ts: it.timestamp ? new Date(it.timestamp).getTime() : 0,
        status: 'ok',
        method: 'internal',
        direction: from === w && to === w ? 'self' : from === w ? 'out' : 'in',
      });
    }
    if (!json?.next_page_params) break;
    params = json.next_page_params;
  }
  return out;
}

/**
 * Total USDC ever received at an address (incoming value transfers, regular +
 * internal). In this marketplace buyers pay an agent's payTo per call, so summed
 * received-at-payTo is a reasonable proxy for what a worker has earned. (Precise
 * per-call attribution would need a settlement indexer.)
 */
export async function fetchReceived(address: string): Promise<number> {
  const [txs, internal] = await Promise.all([
    fetchWalletTxs(address).catch(() => [] as ArcTx[]),
    fetchInternalTxs(address).catch(() => [] as ArcTx[]),
  ]);
  const seen = new Set<string>();
  let sum = 0;
  for (const t of [...txs, ...internal]) {
    if (t.direction !== 'in' || t.value <= 0 || t.status !== 'ok') continue;
    const key = `${t.hash}:${t.from}:${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sum += t.value;
  }
  return +sum.toFixed(6);
}

export async function fetchWalletData(
  address: string
): Promise<{ balance: number; txs: ArcTx[]; history: BalancePoint[] }> {
  const [balance, txs, internal, history] = await Promise.all([
    fetchBalance(address),
    fetchWalletTxs(address),
    fetchInternalTxs(address).catch(() => [] as ArcTx[]),
    fetchBalanceHistory(address).catch(() => [] as BalancePoint[]),
  ]);
  // Merge regular + internal transfers for the activity feed, dedupe, newest first.
  const seen = new Set<string>();
  const merged: ArcTx[] = [];
  for (const t of [...txs, ...internal]) {
    const key = `${t.hash}:${t.from}:${t.to}:${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  merged.sort((a, b) => b.ts - a.ts);
  return { balance, txs: merged, history };
}

// ---------------------------------------------------------------- range resolution + fallback

export type ResolvedRange = {
  requested: RangeKey;
  effective: RangeDef; // may differ from requested when we fall back
  fellBack: boolean;
};

/**
 * The requested range's window may be longer than the wallet's actual history.
 * For the long ranges (6M/1Y/5Y) that reads as an almost-empty axis, so we fall
 * back to all-time, which frames the real data. Short ranges stay literal (empty
 * buckets simply render as zero).
 */
export function resolveRange(requested: RangeKey, txs: ArcTx[], now = Date.now()): ResolvedRange {
  const def = rangeDef(requested);
  const dated = txs.filter((t) => t.ts > 0);
  if (def.fallback && def.windowMs && dated.length) {
    const earliest = Math.min(...dated.map((t) => t.ts));
    if (now - earliest < def.windowMs) {
      return { requested, effective: rangeDef('all'), fellBack: true };
    }
  }
  return { requested, effective: def, fellBack: false };
}

// ---------------------------------------------------------------- bucketing

export type ChartPoint = { label: string; ts: number; usdc: number };
export type ExpenditureSeries = {
  points: ChartPoint[];
  chart: 'line' | 'bar';
  effectiveKey: RangeKey;
  fellBack: boolean;
  total: number; // total USDC spent across the window
};

const startOfHour = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1).getTime();
function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x.getTime();
}

const floorTo = (unit: BucketUnit, ts: number) => {
  const d = new Date(ts);
  return unit === 'hour' ? startOfHour(d) : unit === 'day' ? startOfDay(d) : unit === 'week' ? startOfWeek(d) : startOfMonth(d);
};
const stepFrom = (unit: BucketUnit, ts: number) => {
  const d = new Date(ts);
  if (unit === 'hour') d.setHours(d.getHours() + 1);
  else if (unit === 'day') d.setDate(d.getDate() + 1);
  else if (unit === 'week') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
};

function pickBucket(spanMs: number): BucketUnit {
  if (spanMs <= 1.5 * DAY) return 'hour';
  if (spanMs <= 60 * DAY) return 'day';
  if (spanMs <= 550 * DAY) return 'week';
  return 'month';
}

function labelFor(unit: BucketUnit, ts: number, includeYear: boolean): string {
  const d = new Date(ts);
  if (unit === 'hour') return d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '');
  if (unit === 'month')
    return includeYear
      ? d.toLocaleDateString([], { month: 'short', year: '2-digit' }).replace(' ', " '")
      : d.toLocaleDateString([], { month: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Build the expenditure series (outgoing USDC per bucket) for a requested range. */
export function buildExpenditure(txs: ArcTx[], requested: RangeKey, now = Date.now()): ExpenditureSeries {
  const { effective, fellBack } = resolveRange(requested, txs, now);
  const dated = txs.filter((t) => t.ts > 0);

  // Window start.
  let start: number;
  if (effective.windowMs) {
    start = now - effective.windowMs;
  } else {
    start = dated.length ? Math.min(...dated.map((t) => t.ts)) : now - 7 * DAY;
  }

  // Bucket unit: adaptive for all-time, otherwise the range's own unit.
  let unit: BucketUnit = effective.windowMs ? effective.bucket : pickBucket(now - start);

  // Safety: never emit an absurd number of buckets.
  const approx = (now - start) / (unit === 'hour' ? 3.6e6 : unit === 'day' ? DAY : unit === 'week' ? 7 * DAY : 30 * DAY);
  if (approx > 200) unit = 'month';

  const includeYear = now - start > 366 * DAY;

  // Seed ordered, zeroed buckets across the window.
  const points: ChartPoint[] = [];
  const index = new Map<number, number>();
  let cursor = floorTo(unit, start);
  const end = now;
  let guard = 0;
  while (cursor <= end && guard++ < 2000) {
    index.set(cursor, points.length);
    points.push({ label: labelFor(unit, cursor, includeYear), ts: cursor, usdc: 0 });
    cursor = stepFrom(unit, cursor);
  }
  if (points.length === 0) {
    const b = floorTo(unit, now);
    index.set(b, 0);
    points.push({ label: labelFor(unit, b, includeYear), ts: b, usdc: 0 });
  }

  // Sum outgoing spend into buckets.
  let total = 0;
  for (const t of dated) {
    if (t.direction !== 'out' || t.status !== 'ok' || t.value <= 0) continue;
    if (t.ts < points[0].ts || t.ts > end) continue;
    const b = floorTo(unit, t.ts);
    const i = index.get(b);
    if (i === undefined) continue;
    points[i].usdc = +(points[i].usdc + t.value).toFixed(6);
    total += t.value;
  }

  return { points, chart: effective.chart, effectiveKey: effective.key, fellBack, total: +total.toFixed(6) };
}

export type BalanceSeries = {
  points: ChartPoint[];
  chart: 'area';
  effectiveKey: RangeKey;
  fellBack: boolean;
  latest: number;
};

/**
 * Balance-over-time series. Samples the wallet's actual balance (from balance
 * history) at each bucket boundary across the requested range, anchoring the final
 * point to the true current balance. Same long-range → all-time fallback as spend.
 * If balance history is unavailable, degrades to a flat line at the current balance.
 */
export function buildBalanceSeries(
  history: BalancePoint[],
  currentBalance: number,
  requested: RangeKey,
  now = Date.now()
): BalanceSeries {
  const pts = history.filter((p) => p.ts > 0).slice().sort((a, b) => a.ts - b.ts);
  const earliest = pts.length ? pts[0].ts : now;

  // "All" shows the true full span, but never a window shorter than 5 years — with
  // under 5 years of history, All renders the 5-year view instead.
  let effective = rangeDef(requested);
  let fellBack = false;
  if (requested === 'all' && pts.length && now - earliest < 5 * 365 * DAY) {
    effective = rangeDef('5y');
    fellBack = true;
  }

  let start: number;
  if (effective.windowMs) start = now - effective.windowMs;
  else start = pts.length ? earliest : now - 7 * DAY;

  let unit: BucketUnit = effective.windowMs ? effective.bucket : pickBucket(now - start);
  const approx = (now - start) / (unit === 'hour' ? 3.6e6 : unit === 'day' ? DAY : unit === 'week' ? 7 * DAY : 30 * DAY);
  if (approx > 200) unit = 'month';
  const includeYear = now - start > 366 * DAY;

  const balanceAsOf = (ts: number): number => {
    if (!pts.length) return currentBalance; // no history → flat at current
    if (ts < pts[0].ts) return 0; // wallet empty before its first recorded balance
    let lo = 0, hi = pts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].ts <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return pts[ans].balance;
  };

  const points: ChartPoint[] = [];
  let cursor = floorTo(unit, start);
  let guard = 0;
  while (cursor <= now && guard++ < 2000) {
    const next = stepFrom(unit, cursor);
    const sampleAt = Math.min(next, now); // balance as of the end of this bucket
    points.push({ label: labelFor(unit, cursor, includeYear), ts: cursor, usdc: +balanceAsOf(sampleAt).toFixed(6) });
    cursor = next;
  }
  if (points.length === 0) {
    points.push({ label: labelFor(unit, floorTo(unit, now), includeYear), ts: now, usdc: +currentBalance.toFixed(6) });
  } else {
    points[points.length - 1].usdc = +currentBalance.toFixed(6);
  }

  return { points, chart: 'area', effectiveKey: effective.key, fellBack, latest: currentBalance };
}

// ---------------------------------------------------------------- formatting

export function formatUsdc(n: number, maxFrac = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
}

export const shortHash = (a: string) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a);

/** Compact relative time, e.g. "3m ago", "2h ago", "5d ago". */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(1, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export const txUrl = (hash: string) => `${ARC_EXPLORER.replace(/\/$/, '')}/tx/${hash}`;

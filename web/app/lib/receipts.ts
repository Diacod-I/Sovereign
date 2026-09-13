// app/lib/receipts.ts
// Reading agent track records from the subgraph, and filing new receipts on-chain.

'use client';

import { useSendTransaction } from '@privy-io/react-auth';
import { encodeFunctionData, parseUnits, type Abi } from 'viem';
import { ARC_CHAIN_ID } from './arc';
import abiJson from './Receipts.abi.json';
import { EMPTY_RECORD, type TrackRecord } from './reputation';

const abi = abiJson as Abi;

export const RECEIPTS_ADDRESS = (process.env.NEXT_PUBLIC_RECEIPTS_ADDRESS || '') as `0x${string}` | '';

export const receiptsConfigured = /^0x[a-fA-F0-9]{40}$/.test(RECEIPTS_ADDRESS);

export const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

export type ReceiptRow = {
  id: string;
  agentId: string;
  buyer: string;
  settlementRef: string;
  amount: number;      // USDC
  latencyMs: number;
  delivered: boolean;
  met: number;         // 0 | 1 | 2
  expectation: string;
  note: string;
  at: number;          // unix seconds
};

/** The aggregate fields the subgraph maintains on each Agent. */
export const TRACK_RECORD_FIELDS =
  'receiptCount deliveredCount metScore totalPaid latencyTotalMs distinctBuyers repeatBuyers lastHiredAt';

/**
 * Maps subgraph aggregates onto a TrackRecord.
 *
 * Tolerates the fields being absent: until the Receipts datasource is deployed
 * and indexed the marketplace still has to render, it just shows every worker as
 * unproven — which is honest rather than broken.
 */
export function toTrackRecord(a: Record<string, unknown> | null | undefined): TrackRecord {
  if (!a || a.receiptCount === undefined || a.receiptCount === null) return EMPTY_RECORD;
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const count = num(a.receiptCount);
  const latencyTotalMs = num(a.latencyTotalMs);
  return {
    receiptCount: count,
    deliveredCount: num(a.deliveredCount),
    metScore: num(a.metScore),
    totalPaid: num(a.totalPaid) / 1e6,
    latencyTotalMs,
    // The chain stores no separate sample count; a zero total means nothing was
    // ever timed, so treat latency as unmeasured rather than as "instant".
    latencySamples: latencyTotalMs > 0 ? count : 0,
    distinctBuyers: num(a.distinctBuyers),
    repeatBuyers: num(a.repeatBuyers),
    lastHiredAt: a.lastHiredAt ? num(a.lastHiredAt) : null,
  };
}

async function query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('subgraph error');
  return json.data as T;
}

/** Recent graded work for one agent — the "previous work" on its profile. */
export async function fetchReceipts(agentId: string, first = 20): Promise<ReceiptRow[]> {
  try {
    const data = await query<{ receipts: Record<string, string>[] }>(
      `query($id: String!, $first: Int!) {
         receipts(where: { agentId: $id }, orderBy: at, orderDirection: desc, first: $first) {
           id agentId buyer settlementRef amount latencyMs delivered met expectation note at
         }
       }`,
      { id: agentId, first },
    );
    return (data.receipts ?? []).map((r) => ({
      id: r.id,
      agentId: r.agentId,
      buyer: r.buyer,
      settlementRef: r.settlementRef,
      amount: Number(r.amount) / 1e6,
      latencyMs: Number(r.latencyMs) || 0,
      delivered: Boolean(r.delivered),
      met: Number(r.met) || 0,
      expectation: r.expectation ?? '',
      note: r.note ?? '',
      at: Number(r.at) || 0,
    }));
  } catch {
    // Receipts not indexed yet — an empty history is the correct answer.
    return [];
  }
}

/**
 * The live aggregates for ONE agent.
 *
 * The marketplace grid loads every listing's track record once, which is right
 * for a grid and wrong for a profile: a buyer who grades a call in their
 * terminal and then opens the worker comes back to the numbers as they were
 * when the page loaded. The receipt list refetches on open and the bars did
 * not, so the profile disagreed with itself. This is the missing half.
 */
export async function fetchTrackRecord(agentId: string): Promise<TrackRecord | null> {
  try {
    const data = await query<{ agent: Record<string, unknown> | null }>(
      `query($id: ID!) { agent(id: $id) { ${TRACK_RECORD_FIELDS} } }`,
      { id: agentId },
    );
    return data.agent ? toTrackRecord(data.agent) : null;
  } catch {
    // Keep whatever the grid already had rather than blanking a real record.
    return null;
  }
}

export type ReceiptInput = {
  agentId: string;
  /** Tx hash of the payment this grades. Doubles as the anti-replay key. */
  settlementRef: string;
  amountUsdc: string;
  latencyMs: number;
  delivered: boolean;
  met: number;          // 0 | 1 | 2
  expectation: string;
  note: string;
};

const ZERO32 = '0x' + '0'.repeat(64);

/** Files a receipt on-chain, signed by the buyer's embedded wallet. */
export function useFileReceipt(address: string | null) {
  const { sendTransaction } = useSendTransaction();

  return async (input: ReceiptInput): Promise<string> => {
    if (!address) throw new Error('No wallet');
    if (!receiptsConfigured) {
      throw new Error('NEXT_PUBLIC_RECEIPTS_ADDRESS is not set — deploy Receipts.sol first.');
    }
    const ref = /^0x[a-fA-F0-9]{64}$/.test(input.settlementRef) ? input.settlementRef : ZERO32;
    const data = encodeFunctionData({
      abi,
      functionName: 'file',
      args: [
        input.agentId,
        ref as `0x${string}`,
        parseUnits(input.amountUsdc || '0', 6),
        Math.max(0, Math.round(input.latencyMs)),
        input.delivered,
        input.met,
        input.expectation.slice(0, 400),
        input.note.slice(0, 400),
      ],
    });
    const { hash } = await sendTransaction(
      { to: RECEIPTS_ADDRESS as `0x${string}`, data, chainId: ARC_CHAIN_ID },
      { address },
    );
    return hash;
  };
}

// ---------------------------------------------------------------- pending reviews
// A hire and its grading are separated by however long the work takes, so the
// expectation is parked locally between the two. Keyed by the payment tx, which
// is also what the contract dedupes on.

export type PendingReview = {
  settlementRef: string;
  agentId: string;
  agentName: string;
  amountUsdc: string;
  expectation: string;
  hiredAt: number;
  buyerAgentId: string;
  /** Measured by the MCP when the agent made the call itself. */
  latencyMs?: number;
  delivered?: boolean;
};

// ---------------------------------------------------------------- handoff links
// sovereign-mcp encodes the context of a call into a URL so the human confirms
// what happened rather than retyping it. `?hire=` prefills the payment modal
// with the expectation the agent stated; `?review=` prefills the grading modal
// after an autonomous payment has already settled.

export type HireHandoff = {
  kind: 'hire';
  agentId: string;
  agentName: string;
  amountUsdc: string;
  expectation: string;
};

export type ReviewHandoff = {
  kind: 'review';
  agentId: string;
  agentName: string;
  amountUsdc: string;
  expectation: string;
  settlementRef: string;
  latencyMs: number;
  delivered: boolean;
};

export type Handoff = HireHandoff | ReviewHandoff;

function decodeB64Url(raw: string): unknown {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  // atob yields a *binary* string, one char per byte — it does not decode UTF-8.
  // Passing it straight to JSON.parse mangles anything non-ASCII, and an
  // expectation is free text: curly quotes, em dashes and emoji all show up in
  // practice, and a corrupted one would be written on-chain corrupted. So decode
  // the bytes explicitly.
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Reads a handoff out of the URL. Returns null on anything malformed — this is
 * untrusted input from a link, so it is validated field by field rather than
 * trusted because it parsed.
 */
export function readHandoff(search: string): Handoff | null {
  try {
    const params = new URLSearchParams(search);
    const kind = params.get('review') ? 'review' : params.get('hire') ? 'hire' : null;
    if (!kind) return null;
    const raw = params.get(kind);
    if (!raw) return null;
    const d = decodeB64Url(raw) as Record<string, unknown>;

    const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
    const agentId = str(d.agentId, 100);
    if (!agentId) return null;

    const base = {
      agentId,
      agentName: str(d.agentName, 120) || agentId,
      amountUsdc: /^[0-9]*\.?[0-9]+$/.test(String(d.amountUsdc ?? '')) ? String(d.amountUsdc) : '0',
      expectation: str(d.expectation),
    };

    if (kind === 'hire') return { kind: 'hire', ...base };

    const ref = str(d.settlementRef, 66);
    return {
      kind: 'review',
      ...base,
      settlementRef: /^0x[a-fA-F0-9]{64}$/.test(ref) ? ref : '',
      latencyMs: Number.isFinite(Number(d.latencyMs)) ? Math.max(0, Math.round(Number(d.latencyMs))) : 0,
      delivered: d.delivered !== false,
    };
  } catch {
    return null;
  }
}

const KEY = 'sovereign_pending_reviews';

export function readPending(): PendingReview[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingReview[]) : [];
  } catch {
    return [];
  }
}

export function addPending(p: PendingReview) {
  try {
    const list = readPending().filter((x) => x.settlementRef !== p.settlementRef);
    localStorage.setItem(KEY, JSON.stringify([p, ...list].slice(0, 50)));
  } catch {}
}

export function removePending(settlementRef: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(readPending().filter((x) => x.settlementRef !== settlementRef)));
  } catch {}
}

export type WorkerEarning = {
  id: string;
  name: string;
  /** USDC across graded calls. See the note below on why this is a floor. */
  earned: number;
  calls: number;
  active: boolean;
};

/**
 * What each of this wallet's workers has earned.
 *
 * Summed from receipts rather than from transfers into the payout address,
 * because payTo defaults to the seller's own wallet and most sellers never
 * change it: on-chain those transfers are indistinguishable between workers, so
 * per-worker attribution is only possible from the receipts themselves.
 *
 * The consequence is that this is a FLOOR, not a total. A paid call that nobody
 * graded leaves no receipt and is invisible here, which is why the chart says
 * "graded calls" rather than "earnings" and why the two can disagree with the
 * treasury balance.
 */
export async function fetchWorkerEarnings(owner: string): Promise<WorkerEarning[]> {
  const fields = 'id name active totalPaid receiptCount';
  const bare = 'id name active';
  const run = async (sel: string) =>
    query<{ agents: Record<string, unknown>[] }>(
      `query($owner: Bytes!) { agents(where: { owner: $owner }, first: 100) { ${sel} } }`,
      { owner: owner.toLowerCase() },
    );

  let rows: Record<string, unknown>[];
  try {
    rows = (await run(fields)).agents ?? [];
  } catch {
    // Before the Receipts datasource is deployed the aggregate fields do not
    // exist and the whole query 400s. Fall back so the panel renders "nothing
    // earned yet" instead of an error that looks like a broken page.
    try {
      rows = (await run(bare)).agents ?? [];
    } catch {
      return [];
    }
  }

  return rows
    .map((a) => ({
      id: String(a.id ?? ''),
      name: String(a.name ?? a.id ?? 'worker'),
      earned: (Number(a.totalPaid ?? 0) || 0) / 1e6,
      calls: Number(a.receiptCount ?? 0) || 0,
      active: a.active !== false,
    }))
    .sort((x, y) => y.earned - x.earned);
}

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
};

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

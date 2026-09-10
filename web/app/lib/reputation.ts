// app/lib/reputation.ts
// Turning receipts into something a buyer — or a buyer's agent — can decide on.
//
// Deliberately NOT a star rating. Agents emit machine-checkable telemetry that
// human freelancers never did, so the score is built from what can be observed
// (did it deliver, how fast, did buyers come back) plus one judged axis (did it
// meet the expectation the buyer wrote down before hiring).

export type TrackRecord = {
  receiptCount: number;
  deliveredCount: number;
  metScore: number;        // sum of 0 | 1 | 2 across receipts
  totalPaid: number;       // USDC
  latencyTotalMs: number;
  latencySamples: number;  // receipts that actually reported a latency
  distinctBuyers: number;
  repeatBuyers: number;
  lastHiredAt: number | null;
};

export const EMPTY_RECORD: TrackRecord = {
  receiptCount: 0, deliveredCount: 0, metScore: 0, totalPaid: 0,
  latencyTotalMs: 0, latencySamples: 0, distinctBuyers: 0, repeatBuyers: 0,
  lastHiredAt: null,
};

/**
 * Wilson score lower bound.
 *
 * The reason a new worker with 2/2 perfect calls must not outrank one with
 * 480/500: this returns the low end of the plausible range, so a small sample is
 * penalised for being small rather than rewarded for being lucky. Without it,
 * every leaderboard is topped by whoever has been used least.
 */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / d);
}

export type Axis = {
  key: 'reliability' | 'quality' | 'speed' | 'demand';
  label: string;
  /** 0–1, or null when there is not enough evidence to say. */
  value: number | null;
  display: string;
  hint: string;
};

export type Score = {
  /** 0–100 composite, or null when unproven. */
  overall: number | null;
  tier: 'unproven' | 'early' | 'established' | 'proven';
  tierLabel: string;
  axes: Axis[];
  metRate: number | null;
  deliveredRate: number | null;
  repeatRate: number | null;
  meanLatencyMs: number | null;
};

function tierOf(n: number): Score['tier'] {
  if (n === 0) return 'unproven';
  if (n < 5) return 'early';
  if (n < 20) return 'established';
  return 'proven';
}

const TIER_LABEL: Record<Score['tier'], string> = {
  unproven: 'Unproven',
  early: 'Early track record',
  established: 'Established',
  proven: 'Proven',
};

export function scoreOf(r: TrackRecord): Score {
  const n = r.receiptCount;
  const tier = tierOf(n);

  if (n === 0) {
    return {
      overall: null, tier, tierLabel: TIER_LABEL[tier],
      metRate: null, deliveredRate: null, repeatRate: null, meanLatencyMs: null,
      axes: [
        { key: 'reliability', label: 'Reliability', value: null, display: '—', hint: 'No completed calls yet.' },
        { key: 'quality', label: 'Met expectations', value: null, display: '—', hint: 'No buyer has graded this worker.' },
        { key: 'speed', label: 'Speed', value: null, display: '—', hint: 'No timing recorded.' },
        { key: 'demand', label: 'Repeat buyers', value: null, display: '—', hint: 'Nobody has hired this worker.' },
      ],
    };
  }

  const deliveredRate = r.deliveredCount / n;
  const metRate = r.metScore / (2 * n);              // metScore is 0–2 per receipt
  const repeatRate = r.distinctBuyers > 0 ? r.repeatBuyers / r.distinctBuyers : 0;
  const meanLatencyMs = r.latencySamples > 0 ? r.latencyTotalMs / r.latencySamples : null;

  // Small samples are shrunk toward "unknown", not toward "great".
  const reliability = wilsonLower(r.deliveredCount, n);
  const quality = wilsonLower(r.metScore / 2, n);

  // Speed is scored on a log curve: 200ms vs 400ms barely matters to a buyer,
  // 2s vs 20s matters a lot. Full marks under ~500ms, zero past ~60s.
  const speed =
    meanLatencyMs === null
      ? null
      : Math.max(0, Math.min(1, 1 - Math.log10(Math.max(500, meanLatencyMs) / 500) / Math.log10(120)));

  const axes: Axis[] = [
    {
      key: 'reliability', label: 'Reliability', value: reliability,
      display: `${Math.round(deliveredRate * 100)}%`,
      hint: `${r.deliveredCount} of ${n} calls returned usable output.`,
    },
    {
      key: 'quality', label: 'Met expectations', value: quality,
      display: `${Math.round(metRate * 100)}%`,
      hint: `Graded by buyers against what they said they wanted, before hiring.`,
    },
    {
      key: 'speed', label: 'Speed', value: speed,
      display: meanLatencyMs === null ? '—' : formatLatency(meanLatencyMs),
      hint: meanLatencyMs === null ? 'No timing recorded.' : `Mean across ${r.latencySamples} timed call${r.latencySamples === 1 ? '' : 's'}.`,
    },
    {
      key: 'demand', label: 'Repeat buyers', value: repeatRate,
      display: `${r.repeatBuyers}/${r.distinctBuyers}`,
      hint: 'Buyers who came back and paid again — the hardest signal to fake.',
    },
  ];

  // Weighted composite. Quality and reliability dominate; repeat business is the
  // tiebreaker; speed matters least because a slow worker is still a worker.
  const parts: [number, number][] = [
    [quality, 0.4],
    [reliability, 0.35],
    [repeatRate, 0.15],
    [speed ?? 0.5, 0.1],
  ];
  const overall = Math.round(100 * parts.reduce((s, [v, w]) => s + v * w, 0));

  return {
    overall, tier, tierLabel: TIER_LABEL[tier],
    axes, metRate, deliveredRate, repeatRate, meanLatencyMs,
  };
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export const MET_LABEL: Record<number, string> = {
  0: 'Not met',
  1: 'Partially met',
  2: 'Met',
};

export const MET_COLOR: Record<number, string> = {
  0: 'text-red-400',
  1: 'text-amber-400',
  2: 'text-accent',
};

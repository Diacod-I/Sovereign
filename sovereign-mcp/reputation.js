// Agent-side mirror of the marketplace's scoring, so a buyer agent can rank on
// evidence rather than keyword overlap. Kept deliberately small and dependency
// free — this must stay in step with web/app/lib/reputation.ts.

/** Wilson lower bound: small samples are penalised for being small, not rewarded for being lucky. */
export function wilsonLower(successes, n, z = 1.96) {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / d);
}

export function trackRecord(a) {
  const num = (v) => Number(v ?? 0) || 0;
  const receiptCount = num(a.receiptCount);
  const latencyTotalMs = num(a.latencyTotalMs);
  return {
    receiptCount,
    deliveredCount: num(a.deliveredCount),
    metScore: num(a.metScore),
    totalPaid: num(a.totalPaid) / 1e6,
    latencyTotalMs,
    meanLatencyMs: receiptCount > 0 && latencyTotalMs > 0 ? latencyTotalMs / receiptCount : null,
    distinctBuyers: num(a.distinctBuyers),
    repeatBuyers: num(a.repeatBuyers),
    lastHiredAt: a.lastHiredAt ? num(a.lastHiredAt) : null,
  };
}

/** 0–100, or null when nobody has graded this worker yet. */
export function score(r) {
  const n = r.receiptCount;
  if (n === 0) return null;
  const reliability = wilsonLower(r.deliveredCount, n);
  const quality = wilsonLower(r.metScore / 2, n);
  const repeatRate = r.distinctBuyers > 0 ? r.repeatBuyers / r.distinctBuyers : 0;
  const speed =
    r.meanLatencyMs === null
      ? 0.5
      : Math.max(0, Math.min(1, 1 - Math.log10(Math.max(500, r.meanLatencyMs) / 500) / Math.log10(120)));
  return Math.round(100 * (quality * 0.4 + reliability * 0.35 + repeatRate * 0.15 + speed * 0.1));
}

export function tier(n) {
  if (n === 0) return 'unproven';
  if (n < 5) return 'early';
  if (n < 20) return 'established';
  return 'proven';
}

/** One-line trust summary for tool output. */
export function summarise(r) {
  if (r.receiptCount === 0) return 'unproven — no graded calls yet';
  const met = Math.round((r.metScore / (2 * r.receiptCount)) * 100);
  const delivered = Math.round((r.deliveredCount / r.receiptCount) * 100);
  const bits = [
    `score ${score(r)}/100 (${tier(r.receiptCount)})`,
    `${met}% met expectations`,
    `${delivered}% delivered`,
    `${r.receiptCount} graded call${r.receiptCount === 1 ? '' : 's'}`,
    `${r.repeatBuyers}/${r.distinctBuyers} buyers returned`,
  ];
  if (r.meanLatencyMs !== null) {
    bits.push(r.meanLatencyMs < 1000 ? `${Math.round(r.meanLatencyMs)}ms avg` : `${(r.meanLatencyMs / 1000).toFixed(1)}s avg`);
  }
  return bits.join(' · ');
}

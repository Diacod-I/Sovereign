'use client';

import { useState } from 'react';
import {
  probeEndpoint,
  statusColor,
  statusGlyph,
  type ProbeResult,
} from '../lib/probe';

type Props = {
  endpoint: string;
  payTo?: string;
  price?: string;
  owner?: string;
  /** Bubbles the latest result up so the parent can gate its submit button. */
  onResult: (r: ProbeResult | null) => void;
  result: ProbeResult | null;
};

/**
 * Runs the pre-listing endpoint check and renders each assertion.
 *
 * Shown before the on-chain tx rather than after, because a bad listing costs
 * gas to fix and is publicly visible in the meantime.
 */
export default function EndpointProbe({ endpoint, payTo, price, owner, onResult, result }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!endpoint.trim() || busy) return;
    setBusy(true);
    setErr(null);
    onResult(null);
    try {
      onResult(await probeEndpoint({ endpoint: endpoint.trim(), payTo, price, owner }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Check failed.');
    } finally {
      setBusy(false);
    }
  };

  // Passes collapse to a compact row; anything needing action gets full detail.
  const passed = result?.checks.filter((c) => c.status === 'pass') ?? [];
  // Skips stay visible: a check that did not run is not a check that passed, and
  // hiding it would let "Verified" imply more than was actually tested.
  const notable = result?.checks.filter((c) => c.status !== 'pass') ?? [];

  return (
    <div className="rounded-lg border border-hairline bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">Endpoint check</div>
        <button
          type="button"
          onClick={run}
          disabled={!endpoint.trim() || busy}
          className="rounded-md border border-hairline px-2.5 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
        >
          {busy ? 'Checking…' : result ? 'Re-check' : 'Check endpoint'}
        </button>
      </div>

      {!result && !busy && !err && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          We call your endpoint once, unpaid. It should refuse with a 402 quoting your
          payout address and price — that proves buyers can actually pay it.
        </p>
      )}

      {err && <div className="mt-2 text-[11px] text-red-400">{err}</div>}

      {result && (
        <>
          {/* A passing check needs no explanation — the tick is the message.
              Only failures and warnings earn a line of detail, which keeps the
              panel short enough that the modal's action row stays in view. */}
          {passed.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
              {passed.map((c) => (
                <li key={c.id} className="flex items-center gap-1 text-[11px] text-muted">
                  <span className="font-mono text-accent" aria-hidden="true">✓</span>
                  {c.label}
                </li>
              ))}
            </ul>
          )}

          {notable.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {notable.map((c) => (
                <li key={c.id} className="flex gap-2 text-[11px] leading-relaxed">
                  <span className={`mt-px font-mono ${statusColor[c.status]}`} aria-hidden="true">
                    {statusGlyph[c.status]}
                  </span>
                  <span className="flex-1">
                    <span className={c.status === 'skip' ? 'text-muted' : ''}>{c.label}</span>
                    <span className="block text-muted">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className={`mt-2.5 border-t border-hairline pt-2 text-[11px] ${result.ok ? 'text-accent' : 'text-red-400'}`}>
            {result.ok ? (
              <>
                Verified in {result.elapsedMs}ms
                {result.quote?.amount && (
                  <span className="text-muted">
                    {' · quoted '}
                    {(Number(result.quote.amount) / 1e6).toString()} USDC
                    {result.quote.payTo ? ` to ${result.quote.payTo.slice(0, 6)}…${result.quote.payTo.slice(-4)}` : ''}
                  </span>
                )}
              </>
            ) : (
              'Endpoint is not ready to list.'
            )}
          </div>
        </>
      )}
    </div>
  );
}

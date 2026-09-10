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

  const warnings = result?.checks.filter((c) => c.status === 'warn').length ?? 0;

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
          <ul className="mt-2.5 flex flex-col gap-1.5">
            {result.checks.map((c) => (
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
          <div className={`mt-2.5 border-t border-hairline pt-2 text-[11px] ${result.ok ? 'text-accent' : 'text-red-400'}`}>
            {result.ok
              ? `Endpoint verified in ${result.elapsedMs}ms${warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`
              : 'Endpoint is not ready to list.'}
          </div>
        </>
      )}
    </div>
  );
}

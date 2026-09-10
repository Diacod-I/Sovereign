// app/lib/probe.ts
// Shared types + client helper for endpoint verification.
//
// A listing is only worth anything if its endpoint is real. Before this existed
// any string could be registered on-chain — including '—', which is what the
// seller form substituted for an empty field — and buyers only discovered it
// when a paid call failed. The probe moves that discovery to registration time.

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://sovereign-marketplace.vercel.app';

/** Base for Sovereign-hosted worker endpoints (`/w/<slug>`). */
export const HOSTED_WORKER_BASE = `${SITE_URL}/w`;

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type ProbeCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

/** The payment terms the endpoint actually quoted in its 402. */
export type ProbeQuote = {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
};

export type ProbeResult = {
  /** True when no check failed. Warnings do not block. */
  ok: boolean;
  endpoint: string;
  checks: ProbeCheck[];
  quote: ProbeQuote | null;
  elapsedMs: number;
};

export type ProbeRequest = {
  endpoint: string;
  /** The payout address about to be written on-chain. */
  payTo?: string;
  /** Human USDC price about to be written on-chain, e.g. "0.05". */
  price?: string;
  /** Seller wallet, for the optional /.well-known ownership proof. */
  owner?: string;
};

export async function probeEndpoint(req: ProbeRequest): Promise<ProbeResult> {
  const res = await fetch('/api/probe-endpoint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok && !data?.checks) {
    throw new Error(data?.detail || 'Could not run the endpoint check.');
  }
  return data as ProbeResult;
}

export const statusColor: Record<CheckStatus, string> = {
  pass: 'text-accent',
  fail: 'text-red-400',
  warn: 'text-amber-400',
  skip: 'text-muted',
};

export const statusGlyph: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✕',
  warn: '!',
  skip: '·',
};

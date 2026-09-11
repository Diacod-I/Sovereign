// app/lib/hosted.ts
// Shared shapes for Sovereign-hosted workers. Safe to import from the browser:
// nothing here touches a secret or a node builtin.

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://sovereign-marketplace.vercel.app';

/** Where a hosted worker answers. This is what goes on-chain as the endpoint. */
export const hostedUrl = (slug: string) => `${SITE_URL}/w/${slug}`;

/**
 * How a hosted worker produces its output.
 *
 * Only `proxy` exists today: the seller already built something in n8n, Dify,
 * Flowise, an OpenAI Agent Builder workflow, a Zap — anything with a webhook —
 * and we put the payment wall in front of it. That covers the people who are
 * stuck on x402 and hosting, which is most of them, without us running models
 * or holding anybody's LLM key.
 *
 * `prompt` is the eventual second mode, where the agent itself lives here. The
 * route is written to dispatch on this field so adding it is a new branch rather
 * than a new endpoint, and everything around it — the payment wall, the probe,
 * the listing flow, the test bench — already works.
 */
export type WorkerMode = 'proxy';

/** What the seller filled in. Never includes the upstream secret. */
export type HostedWorkerPublic = {
  slug: string;
  owner: string;        // lowercase wallet
  mode: WorkerMode;
  /** Human USDC price per call, e.g. "0.05". Must match the on-chain listing. */
  price: string;
  /** Where settlement lands. Must match the on-chain listing's payTo. */
  payTo: string;
  upstreamUrl: string;
  /** Name of the header we attach the seller's secret to, if any. */
  authHeaderName?: string;
  /** True when a secret is stored. The secret itself never leaves the server. */
  hasSecret: boolean;
  /** Seconds we will wait on the upstream before giving up. */
  timeoutSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type TestCase = {
  id: string;
  /** JSON the buyer would send as `input`. Stored as text so it round-trips. */
  input: string;
  /** What a good answer looks like, in the seller's own words. */
  expectation: string;
  /** Last result, on the same scale buyers grade with. */
  lastMet?: 0 | 1 | 2 | null;
  lastOutput?: string;
  lastLatencyMs?: number;
  lastRunAt?: number;
  lastError?: string;
};

export const MAX_TEST_CASES = 8;
export const MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** URL-safe slug from a display name plus a short random suffix. */
export function slugForWorker(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base.slice(0, 40)}-${suffix}`;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

/**
 * The message a seller signs to prove the wallet creating this worker is theirs.
 *
 * Without it anyone could point a Sovereign-hosted URL at anything and register
 * it under someone else's payout address. Signed rather than session-based
 * because the wallet is the identity the whole product already runs on, and
 * because it binds the exact upstream being saved — a session cookie would
 * authorise the account, not the contents.
 */
export type WorkerAction = 'save' | 'list' | 'test' | 'delete';

export function workerAuthMessage(fields: {
  action: WorkerAction;
  /** Empty for actions that are not about one worker, e.g. `list`. */
  slug: string;
  owner: string;
  /** Empty unless the action sets it. Binding it stops a captured signature
   *  from being replayed to repoint a worker at a different host. */
  upstreamUrl: string;
  issuedAt: string;
}): string {
  return [
    `Sovereign: ${fields.action} hosted worker`,
    `slug: ${fields.slug}`,
    `owner: ${fields.owner.toLowerCase()}`,
    `upstream: ${fields.upstreamUrl}`,
    `issued: ${fields.issuedAt}`,
  ].join('\n');
}

/** How long a signed request stays acceptable. */
export const AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * What the proxy answers with when a call did not produce work.
 *
 * `paid` is the field that matters, and it has two very different meanings:
 *
 *  - `paid: false` — the normal failure. The work was attempted between verify
 *    and settle, it failed, and settlement was aborted. The buyer keeps their
 *    money and owes no receipt. Try another worker.
 *
 *  - `paid: true` — money moved and nothing came back. With the reorder in
 *    lib/x402-next.ts this should not happen on a hosted worker, and it is kept
 *    because a seller's own x402 endpoint may still settle before it works, and
 *    because a guarantee you have stopped checking is not a guarantee. The
 *    settlement reference is included so a not-delivered receipt can be filed
 *    against it, which is what costs that worker its score.
 *
 * It arrives under a `sovereign` key in an otherwise 200 response. That looks
 * wrong and is deliberate: Circle's GatewayClient throws away the body of any
 * non-2xx, so a 502 would reach a buyer's agent as a status code with none of
 * the above — see the long note in app/w/[slug]/route.ts.
 */
export type UndeliveredBody = {
  delivered: false;
  /** True only if money actually moved. See above. */
  paid: boolean;
  /** Present when paid. What to file the receipt against. */
  settlement?: string;
  reason: string;
  upstreamStatus?: number;
  latencyMs?: number;
};

/** Envelope a buyer checks to tell a failed delivery from a seller's payload. */
export type SovereignEnvelope = { sovereign?: UndeliveredBody };

/**
 * The failure envelope, if this response is one.
 *
 * A buyer's agent should call this before treating a 200 as a result. A
 * delivered response is the seller's own payload, passed through untouched, and
 * never carries a `sovereign` key.
 */
export function undelivered(data: unknown): UndeliveredBody | null {
  const env = data as SovereignEnvelope | null;
  if (env && typeof env === 'object' && env.sovereign && env.sovereign.delivered === false) {
    return env.sovereign;
  }
  return null;
}

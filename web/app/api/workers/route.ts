// web/app/api/workers/route.ts
// Creating, updating and listing Sovereign-hosted workers.
//
// Everything here is authorised by a signature from the seller's wallet rather
// than a session. The wallet is already the identity the product runs on, and a
// signature binds the specific upstream being saved — a cookie would authorise
// the account and leave the contents unchecked, which is the difference that
// matters when the saved value is a URL we will later fetch on the seller's
// behalf and attach their secret to.

import {
  authorize,
  authorizeOwnerOf,
  claimSlug,
  getWorker,
  listWorkers,
  putWorker,
  seal,
  secretsConfigured,
  toPublic,
  type StoredWorker,
} from '../../lib/hosted.server';
import { assertFetchableUrl } from '../../lib/ssrf';
import { kvConfigured } from '../../lib/kv';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  SLUG_RE,
  hostedUrl,
} from '../../lib/hosted';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A header name we are willing to attach a secret to. */
const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'user-agent', 'connection',
  'transfer-encoding', 'x-sovereign-worker', 'payment-signature', 'payment-response',
]);

type SaveBody = {
  action?: 'save' | 'list';
  owner?: string;
  slug?: string;
  upstreamUrl?: string;
  issuedAt?: string;
  signature?: string;
  price?: string;
  payTo?: string;
  authHeaderName?: string;
  authSecret?: string;
  /** Send true to clear a stored secret without supplying a new one. */
  clearSecret?: boolean;
  timeoutSeconds?: number;
};

export async function POST(request: Request) {
  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  if (body.action === 'list') return handleList(body);
  return handleSave(body as SaveBody);
}

async function handleList(body: { owner?: string; issuedAt?: string; signature?: string }) {
  const auth = await authorize({ ...body, action: 'list', slug: '', upstreamUrl: '' });
  if (!auth.ok) return json({ error: auth.detail }, auth.status);
  const workers = await listWorkers(auth.owner);
  return json({
    ok: true,
    // Never the sealed secret, and never the plaintext — only whether one exists.
    workers: workers.map((w) => ({ ...toPublic(w), url: hostedUrl(w.slug) })),
    storage: { durable: kvConfigured },
  });
}

async function handleSave(body: SaveBody) {
  if (!secretsConfigured && body.authSecret) {
    return json(
      { error: 'WORKER_SECRET_KEY is not set on the server, so an upstream secret cannot be stored safely. Save without one, or set the key.' },
      503,
    );
  }

  const slug = (body.slug || '').trim();
  if (!SLUG_RE.test(slug)) return json({ error: 'That is not a valid worker slug.' }, 400);

  const upstreamUrl = (body.upstreamUrl || '').trim();
  if (!upstreamUrl) return json({ error: 'An upstream URL is required.' }, 400);

  // Vetted before the signature is checked only in the sense of shape; the real
  // network check happens next, and again on every call, because DNS can change
  // under us between saving and being paid.
  let url: URL;
  try {
    url = await assertFetchableUrl(upstreamUrl);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'That URL cannot be used.' }, 400);
  }

  const auth = await authorize({ ...body, action: 'save', slug, upstreamUrl });
  if (!auth.ok) return json({ error: auth.detail }, auth.status);

  const price = (body.price || '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(price) || Number(price) <= 0) {
    return json({ error: 'Price must be a positive USDC amount with at most 6 decimals.' }, 400);
  }

  const payTo = (body.payTo || auth.owner).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    return json({ error: 'payTo must be an Arc address.' }, 400);
  }

  const authHeaderName = (body.authHeaderName || '').trim();
  if (authHeaderName) {
    if (!HEADER_RE.test(authHeaderName) || FORBIDDEN_HEADERS.has(authHeaderName.toLowerCase())) {
      return json({ error: `“${authHeaderName}” cannot be used as an auth header name.` }, 400);
    }
    if (!body.authSecret && !body.clearSecret) {
      // Allowed: keeping an existing secret while renaming nothing. Only reject
      // when there is no secret anywhere to go with the name.
      const existing = await getWorker(slug);
      if (!existing?.authSecretSealed) {
        return json({ error: 'An auth header name was given with no secret to put in it.' }, 400);
      }
    }
  }

  const timeoutSeconds = Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(1, Number(body.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS),
  );

  const existing = await getWorker(slug);
  if (existing) {
    if (existing.owner.toLowerCase() !== auth.owner) {
      return json({ error: 'That slug belongs to another wallet.' }, 403);
    }
  } else {
    const claimed = await claimSlug(slug, auth.owner);
    if (!claimed) return json({ error: 'That slug is taken. Try another name.' }, 409);
  }

  // Keep the old secret unless a new one is supplied or it is explicitly cleared.
  let authSecretSealed = existing?.authSecretSealed;
  if (body.clearSecret) authSecretSealed = undefined;
  if (body.authSecret) {
    try {
      authSecretSealed = seal(body.authSecret);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Could not store the secret.' }, 503);
    }
  }

  const now = Date.now();
  const worker: StoredWorker = {
    slug,
    owner: auth.owner,
    mode: 'proxy',
    price,
    payTo,
    upstreamUrl: url.toString(),
    authHeaderName: authHeaderName && authSecretSealed ? authHeaderName : undefined,
    hasSecret: !!authSecretSealed,
    authSecretSealed,
    timeoutSeconds,
    tests: existing?.tests ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await putWorker(worker);

  return json({
    ok: true,
    worker: { ...toPublic(worker), url: hostedUrl(slug) },
    // Surfaced rather than buried: without a durable store this endpoint stops
    // existing on the next cold start, and a seller about to register it
    // on-chain should know that before they pay gas.
    storage: { durable: kvConfigured },
  });
}

export async function DELETE(request: Request) {
  let body: { owner?: string; slug?: string; issuedAt?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  const slug = (body.slug || '').trim();
  const auth = await authorizeOwnerOf(slug, { ...body, action: 'delete', upstreamUrl: '' });
  if (!auth.ok) return json({ error: auth.detail }, auth.status);

  // Deliberately not a hard delete of the slug claim: a listing on-chain may
  // still point here, and freeing the name would let someone else take over a
  // URL buyers have already paid. Emptying the config is enough to stop it.
  await putWorker({ ...auth.worker, upstreamUrl: '', authSecretSealed: undefined, hasSecret: false });
  return json({ ok: true });
}

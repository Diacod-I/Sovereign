// web/app/api/link/route.ts
// The pairing endpoints, as one route keyed by `op`.
//
//   start   — the terminal asks for a code
//   status  — the approval page asks what it is being asked to approve
//   approve — the account holder signs off
//   deny    — the account holder refuses
//   collect — the terminal exchanges its verifier for a token
//
// One file because they are one protocol and reading them apart makes the flow
// harder to check than it needs to be.

import {
  approveLink,
  collectLink,
  denyLink,
  describeLink,
  startLink,
} from '../../lib/link.server';
import { formatCode, type LinkScope } from '../../lib/link';
import { storageUsable } from '../../lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // The terminal is not a browser origin; this route is safe to call from
      // anywhere because every state change needs either the verifier or a
      // wallet signature.
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });
}

const scopeOf = (v: unknown): LinkScope => (v === 'spend' ? 'spend' : 'identity');

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const op = String(body.op ?? '');

  if (op === 'start') {
    // A pairing that evaporates on the next cold start is worse than one that
    // refuses: the person would approve, the terminal would poll forever, and
    // nothing would say why. So without a durable store this refuses by default.
    //
    // The escape hatch exists because that reasoning is about serverless, not
    // about correctness: a single long-lived process (local dev, a self-hosted
    // box) keeps the in-memory map perfectly well. Same shape as
    // ALLOW_PRIVATE_PROBE, and just as much not-for-Vercel.
    if (!storageUsable) {
      return json(
        {
          error:
            'Pairing is unavailable: this deployment has no durable store. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or SOVEREIGN_ALLOW_EPHEMERAL_LINKS=true if this is a single long-lived process.',
        },
        503,
      );
    }
    try {
      const rec = await startLink(
        String(body.challenge ?? ''),
        typeof body.label === 'string' ? body.label : undefined,
        scopeOf(body.scope),
      );
      return json({ ok: true, code: rec.code, expiresAt: rec.expiresAt, scope: rec.scope });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Could not start pairing.' }, 400);
    }
  }

  if (op === 'status') {
    const rec = await describeLink(formatCode(String(body.code ?? '')));
    if (!rec) return json({ error: 'No such code.' }, 404);
    return json({
      ok: true,
      code: rec.code,
      scope: rec.scope,
      label: rec.label ?? null,
      state: rec.state,
      expiresAt: rec.expiresAt,
    });
  }

  if (op === 'approve') {
    const res = await approveLink({
      code: formatCode(String(body.code ?? '')),
      account: String(body.account ?? ''),
      scope: scopeOf(body.scope),
      issuedAt: String(body.issuedAt ?? ''),
      signature: String(body.signature ?? ''),
    });
    if (!res.ok) return json({ error: res.detail }, res.status);
    return json({ ok: true });
  }

  if (op === 'deny') {
    await denyLink(formatCode(String(body.code ?? '')));
    return json({ ok: true });
  }

  if (op === 'collect') {
    const res = await collectLink(formatCode(String(body.code ?? '')), String(body.verifier ?? ''));
    return json({ ok: true, ...res });
  }

  return json({ error: `Unknown op "${op}".` }, 400);
}

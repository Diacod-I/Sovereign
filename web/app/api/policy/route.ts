// web/app/api/policy/route.ts
// Reading and writing the account's spend limits, where they bind.
//
// Authorised by a wallet signature, same as every other write in this app: the
// account IS the wallet, and a signature proves it without a session to steal.

import { verifyMessage } from 'viem';
import { readPolicy, writePolicy, DEFAULT_POLICY } from '../../lib/policy.server';
import { listTokens, revokeToken } from '../../lib/link.server';
import { kvConfigured, storageUsable } from '../../lib/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Signed per operation, so a read signature cannot be replayed as a write. */
export function policyMessage(op: string, account: string, issuedAt: string): string {
  return [
    `Sovereign: ${op} spend policy`,
    `account: ${account.toLowerCase()}`,
    `issued: ${issuedAt}`,
  ].join('\n');
}

async function authorize(body: Record<string, unknown>, op: string) {
  const account = String(body.account ?? '');
  const issuedAt = String(body.issuedAt ?? '');
  const signature = String(body.signature ?? '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return { ok: false as const, status: 400, detail: 'A wallet address is required.' };
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > 5 * 60 * 1000) {
    return { ok: false as const, status: 401, detail: 'This request has expired. Try again.' };
  }
  let valid = false;
  try {
    valid = await verifyMessage({
      address: account as `0x${string}`,
      message: policyMessage(op, account, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch { valid = false; }
  if (!valid) return { ok: false as const, status: 401, detail: 'The signature does not match this wallet.' };
  return { ok: true as const, account: account.toLowerCase() };
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const op = String(body.op ?? 'read');

  if (op === 'read') {
    const auth = await authorize(body, 'read');
    if (!auth.ok) return json({ error: auth.detail }, auth.status);
    const saved = await readPolicy(auth.account);
    return json({
      ok: true,
      saved,
      // Surfaced so the browser can say plainly that limits are advisory here.
      durable: kvConfigured,
      agents: (await listTokens(auth.account)).map((t) => ({
        hash: t.hash,
        scope: t.scope,
        label: t.label ?? null,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt ?? null,
      })),
    });
  }

  if (op === 'write') {
    const auth = await authorize(body, 'write');
    if (!auth.ok) return json({ error: auth.detail }, auth.status);
    if (!storageUsable) {
      return json(
        {
          error:
            'This deployment has no durable store, so server-side limits cannot be saved. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or SOVEREIGN_ALLOW_EPHEMERAL_LINKS=true if this is a single long-lived process.',
        },
        503,
      );
    }
    const saved = await writePolicy(auth.account, {
      policy: { ...DEFAULT_POLICY, ...(body.policy as object) },
      allowlist: Array.isArray(body.allowlist) ? (body.allowlist as never[]) : [],
    });
    return json({ ok: true, saved });
  }

  if (op === 'revoke') {
    const auth = await authorize(body, 'revoke');
    if (!auth.ok) return json({ error: auth.detail }, auth.status);
    await revokeToken(auth.account, String(body.hash ?? ''));
    return json({ ok: true, agents: await listTokens(auth.account) });
  }

  return json({ error: `Unknown op "${op}".` }, 400);
}

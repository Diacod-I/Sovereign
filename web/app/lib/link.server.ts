// app/lib/link.server.ts
// The pairing store and the tokens it mints. Server-only.

import crypto from 'node:crypto';
import { verifyMessage } from 'viem';
import { kvDel, kvGet, kvSet, kvSetAdd, kvSetMembers, kvSetRemove } from './kv';
import {
  CODE_RE,
  CODE_TTL_MS,
  linkApprovalMessage,
  randomCode,
  type LinkScope,
} from './link';

const codeKey = (code: string) => `link:${code}`;
const tokenKey = (hash: string) => `agent-token:${hash}`;
const accountTokensKey = (account: string) => `agent-tokens:${account.toLowerCase()}`;

type PendingLink = {
  code: string;
  /** sha256 of the terminal's verifier. Proves the collector started this. */
  challenge: string;
  label?: string;
  scope: LinkScope;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  account?: string;
  /** Minted at approval, handed over once, then removed from this record. */
  token?: string;
};

export type AgentToken = {
  account: string;
  scope: LinkScope;
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
};

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- pairing

export async function startLink(challenge: string, label: string | undefined, scope: LinkScope) {
  if (!/^[0-9a-f]{64}$/.test(challenge)) throw new Error('challenge must be a sha256 hex digest');

  // Retry on collision rather than trusting 8 characters to be unique forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode(crypto.randomBytes(8));
    if (await kvGet(codeKey(code))) continue;
    const now = Date.now();
    const rec: PendingLink = {
      code,
      challenge,
      label: label?.slice(0, 80),
      scope,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      state: 'pending',
    };
    await kvSet(codeKey(code), JSON.stringify(rec));
    return rec;
  }
  throw new Error('could not allocate a code');
}

async function readLink(code: string): Promise<PendingLink | null> {
  if (!CODE_RE.test(code)) return null;
  const raw = await kvGet(codeKey(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingLink;
  } catch {
    return null;
  }
}

/** The pending request, for the approval page. Never includes the token. */
export async function describeLink(code: string) {
  const rec = await readLink(code);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) return { ...rec, state: 'expired' as const, token: undefined };
  return { ...rec, token: undefined };
}

/**
 * Approves a pairing, authenticated by a signature from the account itself.
 *
 * Signature rather than a session cookie for the same reason the hosted worker
 * writes are signed: the thing being authorised is specific (this code, this
 * scope), and a cookie would only prove someone is logged in somewhere.
 */
export async function approveLink(input: {
  code: string;
  account: string;
  scope: LinkScope;
  issuedAt: string;
  signature: string;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const rec = await readLink(input.code);
  if (!rec) return { ok: false, status: 404, detail: 'That code does not exist. Check the terminal.' };
  if (Date.now() > rec.expiresAt) {
    return { ok: false, status: 410, detail: 'That code has expired. Run the command again.' };
  }
  if (rec.state !== 'pending') {
    return { ok: false, status: 409, detail: 'That code has already been used.' };
  }
  // The scope is fixed by the terminal at start. Approving a different one would
  // let a page ask for more than the command the person actually ran.
  if (input.scope !== rec.scope) {
    return { ok: false, status: 400, detail: 'This approval is for a different permission than the terminal asked for.' };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.account)) {
    return { ok: false, status: 400, detail: 'A wallet address is required.' };
  }
  const issued = Date.parse(input.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > 5 * 60 * 1000) {
    return { ok: false, status: 401, detail: 'This approval has expired. Try again.' };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: input.account as `0x${string}`,
      message: linkApprovalMessage({
        code: rec.code,
        account: input.account,
        scope: rec.scope,
        issuedAt: input.issuedAt,
      }),
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, detail: 'The signature does not match this wallet.' };

  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const meta: AgentToken = {
    account: input.account.toLowerCase(),
    scope: rec.scope,
    label: rec.label,
    createdAt: Date.now(),
  };
  await kvSet(tokenKey(hash), JSON.stringify(meta));
  await kvSetAdd(accountTokensKey(meta.account), hash);
  await kvSet(codeKey(rec.code), JSON.stringify({ ...rec, state: 'approved', account: meta.account, token }));
  return { ok: true };
}

export async function denyLink(code: string) {
  const rec = await readLink(code);
  if (!rec || rec.state !== 'pending') return;
  await kvSet(codeKey(rec.code), JSON.stringify({ ...rec, state: 'denied' }));
}

/**
 * The terminal collecting its token.
 *
 * The verifier is checked here, not at approval: knowing the code is enough to
 * approve (you are looking at it) but never enough to collect.
 */
export async function collectLink(code: string, verifier: string) {
  const rec = await readLink(code);
  if (!rec) return { state: 'expired' as const };
  if (Date.now() > rec.expiresAt) return { state: 'expired' as const };
  if (rec.state === 'denied') return { state: 'denied' as const };
  if (rec.state !== 'approved') return { state: 'pending' as const };
  if (sha256(verifier) !== rec.challenge) {
    // Someone who is not the terminal is trying to collect. Say nothing useful.
    return { state: 'pending' as const };
  }
  // One-shot: the code is spent the moment its token is handed over.
  await kvDel(codeKey(rec.code));
  return { state: 'approved' as const, account: rec.account!, token: rec.token!, scope: rec.scope };
}

// ---------------------------------------------------------------- tokens

/** Resolves a bearer token to the account it acts for, or null. */
export async function resolveToken(token: string | null | undefined): Promise<(AgentToken & { hash: string }) | null> {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const hash = sha256(token);
  const raw = await kvGet(tokenKey(hash));
  if (!raw) return null;
  try {
    return { ...(JSON.parse(raw) as AgentToken), hash };
  } catch {
    return null;
  }
}

export async function touchToken(hash: string, meta: AgentToken) {
  await kvSet(tokenKey(hash), JSON.stringify({ ...meta, lastUsedAt: Date.now() }));
}

export async function listTokens(account: string): Promise<(AgentToken & { hash: string })[]> {
  const hashes = await kvSetMembers(accountTokensKey(account));
  const out: (AgentToken & { hash: string })[] = [];
  for (const h of hashes) {
    const raw = await kvGet(tokenKey(h));
    if (raw) {
      try { out.push({ ...(JSON.parse(raw) as AgentToken), hash: h }); } catch {}
    } else {
      await kvSetRemove(accountTokensKey(account), h);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Revoking is the only reason any of this is storable rather than a JWT. */
export async function revokeToken(account: string, hash: string) {
  const raw = await kvGet(tokenKey(hash));
  if (!raw) return;
  try {
    const meta = JSON.parse(raw) as AgentToken;
    if (meta.account.toLowerCase() !== account.toLowerCase()) return;
  } catch {
    return;
  }
  await kvDel(tokenKey(hash));
  await kvSetRemove(accountTokensKey(account), hash);
}

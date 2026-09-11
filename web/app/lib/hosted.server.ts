// app/lib/hosted.server.ts
// Storage for hosted workers, and the encryption around the one secret they hold.
//
// Server-only. Importing this from a client component would ship the key.

import crypto from 'node:crypto';
import { verifyMessage } from 'viem';
import { kvGet, kvSet, kvSetAdd, kvSetIfAbsent, kvSetMembers, kvSetRemove } from './kv';
import {
  AUTH_WINDOW_MS,
  SLUG_RE,
  workerAuthMessage,
  type HostedWorkerPublic,
  type TestCase,
  type WorkerAction,
} from './hosted';

const SECRET_KEY = process.env.WORKER_SECRET_KEY || '';

const key = (slug: string) => `worker:${slug}`;
const ownerKey = (owner: string) => `worker-owner:${owner.toLowerCase()}`;

/** The stored shape: public fields plus the sealed upstream secret. */
type StoredWorker = HostedWorkerPublic & {
  /** AES-256-GCM, "iv.tag.ciphertext" in base64url. Absent when there is none. */
  authSecretSealed?: string;
  tests: TestCase[];
};

// ------------------------------------------------------------------ crypto

/**
 * The seller's upstream token is the one piece of someone else's property this
 * app holds. It is encrypted so that reading the database is not by itself
 * enough to use it — an attacker needs the store and the key, which live in
 * different places.
 *
 * AES-256-GCM rather than plain AES: the tag means a tampered ciphertext fails
 * to decrypt instead of silently yielding a different token we would then send
 * to the seller's upstream.
 */
function derivedKey(): Buffer {
  if (!SECRET_KEY) throw new Error('WORKER_SECRET_KEY is not set.');
  // Accept either 32 raw bytes of hex or an arbitrary passphrase.
  const hex = SECRET_KEY.startsWith('0x') ? SECRET_KEY.slice(2) : SECRET_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  return crypto.createHash('sha256').update(SECRET_KEY).digest();
}

export const secretsConfigured = !!SECRET_KEY;

export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.');
}

export function unseal(sealed: string): string {
  const [ivB, tagB, bodyB] = sealed.split('.');
  if (!ivB || !tagB || !bodyB) throw new Error('malformed sealed secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(bodyB, 'base64url')), decipher.final()]).toString('utf8');
}

// ------------------------------------------------------------------ storage

export async function getWorker(slug: string): Promise<StoredWorker | null> {
  if (!SLUG_RE.test(slug)) return null;
  const raw = await kvGet(key(slug));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredWorker;
  } catch {
    return null;
  }
}

/** Strips the sealed secret. This is what may cross to the browser. */
export function toPublic(w: StoredWorker): HostedWorkerPublic & { tests: TestCase[] } {
  const { authSecretSealed, ...rest } = w;
  void authSecretSealed;
  return rest;
}

export async function putWorker(w: StoredWorker): Promise<void> {
  await kvSet(key(w.slug), JSON.stringify(w));
  await kvSetAdd(ownerKey(w.owner), w.slug);
}

/**
 * Claims a slug, failing if it is taken. Separate from putWorker because the
 * check and the write have to be one operation: two sellers creating a worker
 * with the same name in the same second would otherwise both be told they won,
 * and the second would quietly overwrite the first's upstream.
 */
export async function claimSlug(slug: string, owner: string): Promise<boolean> {
  return kvSetIfAbsent(`worker-slug:${slug}`, owner.toLowerCase());
}

export async function listWorkers(owner: string): Promise<StoredWorker[]> {
  const slugs = await kvSetMembers(ownerKey(owner));
  const out: StoredWorker[] = [];
  for (const s of slugs) {
    const w = await getWorker(s);
    if (w) out.push(w);
    else await kvSetRemove(ownerKey(owner), s); // stale index entry
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// ------------------------------------------------------------------ auth

export type AuthOk = { ok: true; owner: string };
export type AuthFail = { ok: false; status: number; detail: string };

/**
 * Verifies that whoever sent this request holds the wallet they claim.
 *
 * The signature covers the slug and the upstream URL, not just the account, so
 * a captured signature cannot be replayed to repoint someone else's worker at a
 * different host. `issuedAt` bounds how long a captured one is useful at all.
 */
export async function authorize(body: {
  action?: WorkerAction;
  owner?: string;
  slug?: string;
  upstreamUrl?: string;
  issuedAt?: string;
  signature?: string;
}): Promise<AuthOk | AuthFail> {
  const { action, owner, issuedAt, signature } = body;
  // Normalised, because the signed message contains these literally and an
  // undefined would sign as the string "undefined" on one side only.
  const slug = body.slug ?? '';
  const upstreamUrl = body.upstreamUrl ?? '';

  if (!action) return { ok: false, status: 400, detail: 'No action given.' };
  if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    return { ok: false, status: 400, detail: 'A wallet address is required.' };
  }
  if (slug && !SLUG_RE.test(slug)) {
    return { ok: false, status: 400, detail: 'That is not a valid worker slug.' };
  }
  if (action !== 'list' && !slug) {
    return { ok: false, status: 400, detail: 'A worker slug is required.' };
  }
  if (!issuedAt || !signature) {
    return { ok: false, status: 401, detail: 'This request was not signed.' };
  }

  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) {
    return { ok: false, status: 400, detail: 'The signature carries no valid timestamp.' };
  }
  // A clock a little ahead of ours is normal; a lot ahead is a replay attempt.
  const drift = issued - Date.now();
  if (drift > 60_000 || Date.now() - issued > AUTH_WINDOW_MS) {
    return { ok: false, status: 401, detail: 'This signature has expired. Try again.' };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: owner as `0x${string}`,
      message: workerAuthMessage({ action, slug, owner, upstreamUrl, issuedAt }),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, detail: 'The signature does not match this wallet.' };
  }
  return { ok: true, owner: owner.toLowerCase() };
}

/** Authorises, then checks the caller owns this particular worker. */
export async function authorizeOwnerOf(
  slug: string,
  body: Parameters<typeof authorize>[0],
): Promise<(AuthOk & { worker: StoredWorker }) | AuthFail> {
  const auth = await authorize({ ...body, slug });
  if (!auth.ok) return auth;
  const worker = await getWorker(slug);
  if (!worker) return { ok: false, status: 404, detail: 'No such worker.' };
  if (worker.owner.toLowerCase() !== auth.owner) {
    // Deliberately the same shape as "no such worker" would be if we leaked
    // less: there is no reason for one seller to enumerate another's slugs.
    return { ok: false, status: 403, detail: 'This worker belongs to another wallet.' };
  }
  return { ok: true, owner: auth.owner, worker };
}

export type { StoredWorker };

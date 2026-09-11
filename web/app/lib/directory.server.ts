// app/lib/directory.server.ts
// Storage and authorisation for the public name directory.
//
// Server-only. The authorisation is a wallet signature rather than a session,
// for the same reason the hosted-worker routes use one: the wallet is already
// the identity the product runs on, and a signature binds the exact contents
// being written, where a cookie would only say who is asking.

import { verifyMessage } from 'viem';
import { kvGet, kvSet, kvSetAdd, kvSetMembers } from './kv';
import { AUTH_WINDOW_MS } from './hosted';
import { directoryAuthMessage, MAX_BIO, MAX_NAME, type PublicProfile } from './directory';

const key = (address: string) => `profile:${address.toLowerCase()}`;
/** One set of every named wallet, so the marketplace can resolve a page of
 *  listings without a round trip per seller. */
const INDEX = 'profile-index';

export async function getProfile(address: string): Promise<PublicProfile | null> {
  const raw = await kvGet(key(address));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicProfile;
  } catch {
    return null;
  }
}

/**
 * Resolve many wallets at once.
 *
 * Bounded, and misses are simply absent from the result rather than an error:
 * most wallets on any given marketplace page will have no profile, and that is
 * the ordinary case, not a failure.
 */
export async function getProfiles(addresses: string[]): Promise<Record<string, PublicProfile>> {
  const want = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 200);
  const found = await Promise.all(want.map((a) => getProfile(a).catch(() => null)));
  const out: Record<string, PublicProfile> = {};
  found.forEach((p) => {
    if (p) out[p.address] = p;
  });
  return out;
}

/** Every named wallet. Used when the caller has no address list to hand. */
export async function allProfiles(): Promise<Record<string, PublicProfile>> {
  const members = await kvSetMembers(INDEX);
  return getProfiles(members);
}

export async function putProfile(p: PublicProfile): Promise<void> {
  await kvSet(key(p.address), JSON.stringify(p));
  await kvSetAdd(INDEX, p.address);
}

type AuthOk = { ok: true; owner: string; name: string; bio: string };
type AuthFail = { ok: false; status: number; detail: string };

/**
 * Check that this wallet really asked for this name.
 *
 * The same expiry window as the worker routes, for the same reason: a signature
 * with no deadline is a credential that never expires, and this one authorises
 * writing to something other people read.
 */
export async function authorizeProfile(body: {
  owner?: string;
  name?: string;
  bio?: string;
  issuedAt?: string;
  signature?: string;
}): Promise<AuthOk | AuthFail> {
  const owner = (body.owner || '').trim();
  const name = (body.name ?? '').trim();
  const bio = (body.bio ?? '').trim();
  const { issuedAt, signature } = body;

  if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    return { ok: false, status: 400, detail: 'A wallet address is required.' };
  }
  if (!name) return { ok: false, status: 400, detail: 'A name is required.' };
  if (name.length > MAX_NAME) {
    return { ok: false, status: 400, detail: `A name is at most ${MAX_NAME} characters.` };
  }
  if (bio.length > MAX_BIO) {
    return { ok: false, status: 400, detail: `A bio is at most ${MAX_BIO} characters.` };
  }
  // Newlines would let a name forge extra lines of the signed message, so that
  // a signature over one field could be read as covering another.
  if (/[\r\n]/.test(name)) {
    return { ok: false, status: 400, detail: 'A name cannot contain line breaks.' };
  }
  if (!issuedAt || !signature) {
    return { ok: false, status: 401, detail: 'This request was not signed.' };
  }

  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) {
    return { ok: false, status: 400, detail: 'The signature carries no valid timestamp.' };
  }
  const drift = issued - Date.now();
  if (drift > 60_000 || Date.now() - issued > AUTH_WINDOW_MS) {
    return { ok: false, status: 401, detail: 'This signature has expired. Try again.' };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: owner as `0x${string}`,
      message: directoryAuthMessage({ owner, name, bio, issuedAt }),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, detail: 'That signature does not match this wallet.' };

  return { ok: true, owner: owner.toLowerCase(), name, bio };
}

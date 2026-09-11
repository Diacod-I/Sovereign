// web/app/api/directory/route.ts
// Read and write the public name behind a wallet.
//
// Reading is unauthenticated on purpose. These are display names attached to
// public on-chain listings; requiring a login to see who made something would
// be theatre, and the address they stand in for is already world-readable.
// Writing needs a signature from the wallet being named.

import { allProfiles, authorizeProfile, getProfiles, putProfile } from '../../lib/directory.server';
import { kvConfigured } from '../../lib/kv';
import type { PublicProfile } from '../../lib/directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function POST(request: Request) {
  let body: {
    action?: 'save' | 'lookup';
    addresses?: string[];
    owner?: string;
    name?: string;
    bio?: string;
    issuedAt?: string;
    signature?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  if (body.action === 'lookup') {
    // No store means no names, which is a marketplace that credits addresses
    // rather than one that errors. Say so in the payload so the caller can tell
    // "nobody has set a name" from "this deployment cannot remember one".
    if (!kvConfigured) return json({ ok: true, profiles: {}, storage: { durable: false } });
    const profiles = Array.isArray(body.addresses) && body.addresses.length
      ? await getProfiles(body.addresses)
      : await allProfiles();
    return json({ ok: true, profiles, storage: { durable: true } });
  }

  if (!kvConfigured) {
    return json(
      {
        error:
          'This deployment has no durable store, so a published name would not survive. Set ' +
          'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
      },
      503,
    );
  }

  const auth = await authorizeProfile(body);
  if (!auth.ok) return json({ error: auth.detail }, auth.status);

  const profile: PublicProfile = {
    address: auth.owner,
    name: auth.name,
    bio: auth.bio,
    updatedAt: Date.now(),
  };
  await putProfile(profile);
  return json({ ok: true, profile });
}

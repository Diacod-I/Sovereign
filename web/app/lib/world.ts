// World ID configuration used by the client. Server-only RP signing credentials
// intentionally live only in API route handlers.

export const WORLD_APP_ID = (process.env.NEXT_PUBLIC_WORLD_APP_ID || '') as `app_${string}`;
export const WORLD_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION || 'seller-verify';
export const WORLD_RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID || '';

const configuredEnvironment = process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT;
export const WORLD_ENVIRONMENT =
  configuredEnvironment === 'staging' || configuredEnvironment === 'sandbox'
    ? configuredEnvironment
    : 'production';

// The explicit flag prevents an incomplete Portal configuration from opening a
// broken widget. The server separately requires the signing key.
export const worldConfigured =
  process.env.NEXT_PUBLIC_WORLD_ID_LIVE === 'true' &&
  /^app_/.test(WORLD_APP_ID) &&
  /^rp_/.test(WORLD_RP_ID);

/**
 * The demo shortcut grants a verified badge on one click, which satisfies the
 * seller onboarding gate. That is fine on a laptop with no Portal credentials and
 * catastrophic on a deployed site, where it lets anyone become a "unique human"
 * and makes the guarantee we advertise untrue.
 *
 * So it is opt-in, never a fallback. A missing config now fails visibly instead
 * of quietly handing out badges.
 */
export const worldDemoAllowed = process.env.NEXT_PUBLIC_WORLD_DEMO === 'true';

export type WorldStatus =
  | { mode: 'live' }
  | { mode: 'demo' }
  | { mode: 'unconfigured'; missing: string[] };

/** Which mode we are in, and precisely what is missing if neither. */
export function worldStatus(): WorldStatus {
  if (worldConfigured) return { mode: 'live' };

  const missing: string[] = [];
  if (process.env.NEXT_PUBLIC_WORLD_ID_LIVE !== 'true') missing.push('NEXT_PUBLIC_WORLD_ID_LIVE=true');
  if (!/^app_/.test(WORLD_APP_ID)) missing.push('NEXT_PUBLIC_WORLD_APP_ID (app_…)');
  if (!/^rp_/.test(WORLD_RP_ID)) missing.push('NEXT_PUBLIC_WORLD_RP_ID (rp_…)');

  if (worldDemoAllowed) return { mode: 'demo' };
  return { mode: 'unconfigured', missing };
}

/**
 * The local half of a verification. The authoritative record is on-chain (see
 * lib/verification.ts); this is a cache of your own so the UI does not have to
 * wait on the subgraph to stop calling you a stranger, and so a verification
 * that has not been published yet is not simply lost.
 *
 * Still named SellerVerification in the type for compatibility with the World
 * action id; verification now applies to anyone, buying or selling.
 */
export type SellerVerification = {
  wallet: string;
  nullifierHash: string;
  level: string;
  at: number;
  /** Arc tx that published this on-chain. Absent means local only. */
  tx?: string;
};

const KEY = 'sovereign_seller_world';
type Store = Record<string, SellerVerification>;

function readStore(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Store;
  } catch {
    return {};
  }
}

export function readVerification(wallet?: string | null): SellerVerification | null {
  if (!wallet) return null;
  return readStore()[wallet.toLowerCase()] ?? null;
}

export function writeVerification(verification: SellerVerification) {
  try {
    const store = readStore();
    store[verification.wallet.toLowerCase()] = verification;
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {}
}

export const shortNullifier = (hash: string) =>
  hash && hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;

export const levelLabel = (level: string) =>
  ({ selfie: 'Selfie Check', demo: 'Demo' } as Record<string, string>)[level] || level || 'unique human';

/** Merges the local cache with what the chain says, preferring the chain. */
export function mergeVerification(
  local: SellerVerification | null,
  onChain: { nullifier: string; level: string; at: number } | null,
  wallet?: string | null,
): SellerVerification | null {
  if (onChain) {
    return {
      wallet: (wallet || local?.wallet || '').toLowerCase(),
      nullifierHash: onChain.nullifier,
      level: onChain.level,
      at: onChain.at * 1000,
      tx: local?.tx,
    };
  }
  return local;
}

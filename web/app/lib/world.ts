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
// broken widget during the demo. The server separately requires the signing key.
export const worldConfigured =
  process.env.NEXT_PUBLIC_WORLD_ID_LIVE === 'true' &&
  /^app_/.test(WORLD_APP_ID) &&
  /^rp_/.test(WORLD_RP_ID);

export type SellerVerification = {
  wallet: string;
  nullifierHash: string;
  level: string;
  at: number;
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

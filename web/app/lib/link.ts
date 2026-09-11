// app/lib/link.ts
// Pairing a terminal with an account. Browser-safe: no secrets, no node builtins.
//
// The shape is a device-code flow, the same one a TV uses to sign you in: the
// thing that cannot show a browser prints a short code, you approve that code
// somewhere you are already signed in, and the first thing starts working.
//
// Two properties matter more than the mechanics:
//
//  - The code is shown in BOTH places. A terminal that prints WXYZ-4821 and a
//    browser page that shows WXYZ-4821 let you check you are approving the
//    session in front of you rather than one an attacker started. Without that
//    the flow is phishable: send someone a /link URL, they approve, you get
//    their account.
//  - The terminal proves it started the request. It sends a hash up front and
//    the secret only when collecting, so knowing the code is not enough to
//    collect the token.

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://sovereign-marketplace.vercel.app';

/** Crockford-ish: no I, L, O, U, so a code cannot be misread or spell anything. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function formatCode(raw: string): string {
  const up = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return up.length === 8 ? `${up.slice(0, 4)}-${up.slice(4)}` : up;
}

export function randomCode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** How long an unapproved code stays alive. Long enough to find your phone. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** What the terminal is asking for, in the words the approval page shows. */
export type LinkScope = 'identity' | 'spend';

export type LinkRequest = {
  code: string;
  /** Where the terminal is running, for the approval page. Cosmetic, untrusted. */
  label?: string;
  scope: LinkScope;
  expiresAt: number;
};

export type LinkStatus =
  | { state: 'pending' }
  | { state: 'approved'; account: string }
  | { state: 'expired' }
  | { state: 'denied' };

/**
 * The message the account holder signs to approve a pairing.
 *
 * It names the code and the scope, so a signature captured from an
 * identity-only approval cannot be replayed to grant spending.
 */
export function linkApprovalMessage(fields: {
  code: string;
  account: string;
  scope: LinkScope;
  issuedAt: string;
}): string {
  return [
    'Sovereign: link a terminal',
    `code: ${fields.code}`,
    `account: ${fields.account.toLowerCase()}`,
    `grants: ${fields.scope === 'spend' ? 'discovery and spending under your limits' : 'discovery only'}`,
    `issued: ${fields.issuedAt}`,
  ].join('\n');
}

/** What the terminal stores after a successful pair. */
export type LinkResult = {
  account: string;
  /** Bearer token for /api/agent/*. Revocable from the web app. */
  token: string;
  scope: LinkScope;
};

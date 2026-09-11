// app/lib/directory.ts
// The public name behind a wallet. Safe to import from the browser.
//
// Profiles started life in localStorage, which is the right place for something
// only you look at and the wrong place for something other people are supposed
// to read. A marketplace card showing "who made this" is read by strangers on
// other machines, so the name has to live somewhere shared or every listing is
// permanently anonymous to everyone except its own author.
//
// It is NOT on-chain. A display name is mutable, uninteresting to consensus,
// and costs calldata every time someone corrects a typo. What is on-chain is
// the thing that has to be: the wallet that owns the listing. The name is a
// convenience hung off it, and a buyer who cares can still read the address.

/** What anyone may read about a wallet. */
export type PublicProfile = {
  /** Lowercase wallet address. */
  address: string;
  name: string;
  bio: string;
  updatedAt: number;
};

export const MAX_NAME = 60;
export const MAX_BIO = 400;

/**
 * The message a wallet signs to claim a name.
 *
 * The name and bio are bound into it rather than merely accompanying it, so a
 * captured signature cannot be replayed with different contents to rename
 * somebody. Without that, "publish my profile" would be a blank cheque to write
 * anything under that address.
 */
export function directoryAuthMessage(fields: {
  owner: string;
  name: string;
  bio: string;
  issuedAt: string;
}): string {
  return [
    'Sovereign: publish profile',
    `owner: ${fields.owner.toLowerCase()}`,
    `name: ${fields.name}`,
    `bio: ${fields.bio}`,
    `issued: ${fields.issuedAt}`,
  ].join('\n');
}

/**
 * How a listing credits its seller when the directory has nothing.
 *
 * Deliberately the address rather than "Anonymous" or a blank: an unnamed
 * seller is not a suspicious one, they simply have not filled the field in, and
 * the address is true, checkable, and the thing the name is standing in for
 * anyway.
 */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function displayName(address: string, dir: Record<string, PublicProfile> | null): string {
  const hit = dir?.[address.toLowerCase()];
  return hit?.name?.trim() || shortAddress(address);
}

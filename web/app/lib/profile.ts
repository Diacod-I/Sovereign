// app/lib/profile.ts
// One profile per account.
//
// Buying and selling were two onboardings writing two different keys, so the
// same person had two names: an "org" on /dashboard and a display name on
// /seller. They were never two people — both resolve the same Privy embedded
// wallet — so the split only ever produced a contradiction the user had to
// notice and work around.

'use client';

export type Profile = {
  name: string;
  bio: string;
};

const KEY = 'sovereign_profile';

// What the two old onboardings wrote. Read once, on migration, then left alone.
const LEGACY_SELLER = 'sovereign_seller';
const LEGACY_SELLER_BIO = 'sovereign_seller_bio';
const LEGACY_ORG = 'sovereign_org';

/**
 * Reads the profile, folding in whichever legacy keys exist.
 *
 * The seller name wins a conflict: it is the one with a bio and a World ID
 * verification attached to it, and it is the name other people have already
 * seen on listings. Silently picking the buyer's "org" instead would rename
 * someone in public.
 */
export function readProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile>;
      if (p && typeof p.name === 'string' && p.name.trim()) {
        return { name: p.name, bio: typeof p.bio === 'string' ? p.bio : '' };
      }
    }

    const seller = localStorage.getItem(LEGACY_SELLER);
    const org = localStorage.getItem(LEGACY_ORG);
    const name = (seller || org || '').trim();
    if (!name) return null;

    const migrated: Profile = { name, bio: localStorage.getItem(LEGACY_SELLER_BIO) || '' };
    writeProfile(migrated);
    return migrated;
  } catch {
    return null;
  }
}

export function writeProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    // Keep the old keys in step for one release. Anything still reading them —
    // an open tab on the other route, a bookmarklet, a half-deployed build —
    // sees the same name rather than an older one.
    localStorage.setItem(LEGACY_SELLER, p.name);
    localStorage.setItem(LEGACY_ORG, p.name);
    localStorage.setItem(LEGACY_SELLER_BIO, p.bio);
  } catch {}
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { directoryAuthMessage, type PublicProfile } from './directory';

/**
 * Names for a set of wallets, for crediting listings.
 *
 * Returns null while unknown and an object once resolved, so a card can render
 * the address immediately and upgrade to a name rather than flashing a
 * placeholder. A failed lookup resolves to an empty map for the same reason:
 * not knowing someone's name is not an error state a buyer needs to see.
 */
export function useDirectory(addresses: string[]): Record<string, PublicProfile> | null {
  const [dir, setDir] = useState<Record<string, PublicProfile> | null>(null);
  // Sorted and joined so the effect keys on the SET of addresses rather than on
  // the array identity, which changes on every render of the list above it.
  const key = [...new Set(addresses.map((a) => a.toLowerCase()))].sort().join(',');

  useEffect(() => {
    let live = true;
    // Nothing to look up is an answer, not a pending state, but it is still
    // delivered asynchronously: setting state straight out of an effect body
    // makes React render twice for a result that was already known.
    if (!key) {
      Promise.resolve().then(() => { if (live) setDir({}); });
      return () => { live = false; };
    }
    fetch('/api/directory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'lookup', addresses: key.split(',') }),
    })
      .then((r) => r.json())
      .then((d) => { if (live) setDir(d?.profiles ?? {}); })
      .catch(() => { if (live) setDir({}); });
    return () => { live = false; };
  }, [key]);

  return dir;
}

/**
 * Publish this wallet's name so other people's marketplace sees it.
 *
 * Separate from writeProfile() rather than folded into it: saving locally is
 * free and instant, publishing costs a signature prompt, and quietly asking
 * someone to sign every time they edit a bio field would train them to click
 * through wallet dialogs without reading. The caller decides when it is worth
 * asking.
 */
export function usePublishProfile(
  address: string | null,
  signMessage: (args: { message: string }, opts: { address: string }) => Promise<{ signature: string }>,
) {
  const [publishing, setPublishing] = useState(false);

  const publish = useCallback(
    async (name: string, bio: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!address) return { ok: false, error: 'No wallet.' };
      setPublishing(true);
      try {
        const issuedAt = new Date().toISOString();
        const trimmedName = name.trim();
        const trimmedBio = bio.trim();
        const { signature } = await signMessage(
          { message: directoryAuthMessage({ owner: address, name: trimmedName, bio: trimmedBio, issuedAt }) },
          { address },
        );
        const res = await fetch('/api/directory', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            owner: address,
            name: trimmedName,
            bio: trimmedBio,
            issuedAt,
            signature,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) return { ok: false, error: data?.error || `HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Could not publish.' };
      } finally {
        setPublishing(false);
      }
    },
    [address, signMessage],
  );

  return { publish, publishing };
}

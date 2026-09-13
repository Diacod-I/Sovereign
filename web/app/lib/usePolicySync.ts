'use client';

// app/lib/usePolicySync.ts
// Pushing the limits you can see to the place they are enforced.
//
// The dashboard kept spend limits and the allowlist in local state, and the
// server kept its own copy that nothing ever wrote to. So the UI showed a daily
// budget, a per-action cap and an approval threshold that looked configured,
// while /api/agent/call read nothing and refused every payment with "no spend
// policy is set for this account yet". Two sources of truth, one of them
// invisible, and the visible one was the wrong one.
//
// Saving needs a wallet signature, which is why this is not simply done on
// every keystroke: the account IS the wallet, so a signature proves ownership
// with no session to steal, and that is worth one prompt when limits change.

import { useCallback, useState } from 'react';
import { policySignMessage } from './policyMessage';

export type SyncState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * What the server says has been spent today.
 *
 * Returned by both operations because the browser cannot know it. Spending
 * happens in a terminal, against the server's copy, and the dashboard's own
 * number is only ever a cache of a value it does not own.
 */
export type ServerSpend = { spentToday: number; spentOn?: string } | null;

type Signer = (
  args: { message: string },
  opts: { address: string },
) => Promise<{ signature: string }>;

export function usePolicySync(address: string | null, signMessage: Signer) {
  const [state, setState] = useState<SyncState>('idle');
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (policy: unknown, allowlist: unknown[]): Promise<ServerSpend | false> => {
      if (!address) return false;
      setState('saving');
      setError(null);
      try {
        const issuedAt = new Date().toISOString();
        const { signature } = await signMessage(
          { message: policySignMessage('write', address, issuedAt) },
          { address },
        );
        const res = await fetch('/api/policy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'write', account: address, issuedAt, signature, policy, allowlist }),
          signal: AbortSignal.timeout(20000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
        setState('saved');
        // The response carries the server's own spend, which this save did not
        // and must not touch. Handing it back is what lets the dashboard show a
        // number earned by calls it never saw.
        const p = data?.saved?.policy;
        return p ? { spentToday: Number(p.spentToday) || 0, spentOn: p.spentOn } : null;
      } catch (e) {
        setState('error');
        setError(e instanceof Error ? e.message : 'Could not save your limits.');
        return false;
      }
    },
    [address, signMessage],
  );

  /**
   * Reads the server's spend back, at the cost of one signature.
   *
   * Not automatic on mount: the read is authorised by a wallet signature, and
   * prompting somebody the moment they open a page is worse than letting them
   * ask. Saving limits refreshes it for free, so in practice this is for
   * "I just paid from the terminal and want to watch the bar move".
   */
  const refresh = useCallback(async (): Promise<ServerSpend | false> => {
    if (!address) return false;
    setError(null);
    try {
      const issuedAt = new Date().toISOString();
      const { signature } = await signMessage(
        { message: policySignMessage('read', address, issuedAt) },
        { address },
      );
      const res = await fetch('/api/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'read', account: address, issuedAt, signature }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
      const p = data?.saved?.policy;
      return p ? { spentToday: Number(p.spentToday) || 0, spentOn: p.spentOn } : null;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your spend.');
      return false;
    }
  }, [address, signMessage]);

  return { save, refresh, state, error };
}

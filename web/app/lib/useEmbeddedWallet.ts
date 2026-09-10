// app/lib/useEmbeddedWallet.ts
// One source of truth for "which wallet signs".
//
// Sovereign always signs with the Privy EMBEDDED wallet on Arc — never the
// external wallet. MetaMask (and any other injected wallet) is an identity
// provider only: it proves who you are, then the embedded wallet holds the
// USDC and signs registry writes, withdrawals and buyer→seller settlement.
//
// This matters because `user.wallet` is whichever wallet Privy considers
// "primary", which for a MetaMask login is the MetaMask account. Feeding that
// address to `useSendTransaction` fails — that hook drives embedded wallets.
// `getEmbeddedConnectedWallet` picks the right one regardless of login method.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getEmbeddedConnectedWallet,
  useCreateWallet,
  usePrivy,
  useWallets,
} from '@privy-io/react-auth';

export type EmbeddedWallet = {
  /** Address of the embedded wallet, or null while it is still resolving. */
  address: string | null;
  /** True once Privy has finished loading the wallet list. */
  ready: boolean;
  /** The external wallet the user logged in with, if any (display only). */
  externalAddress: string | null;
  /** Set when the user is authenticated but has no embedded wallet yet. */
  missing: boolean;
  /** Creates the embedded wallet on demand. Used to heal pre-existing accounts. */
  create: () => Promise<void>;
  creating: boolean;
  error: string | null;
};

export function useEmbeddedWallet(): EmbeddedWallet {
  const { ready: privyReady, authenticated } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const embedded = useMemo(
    () => (walletsReady ? getEmbeddedConnectedWallet(wallets) : null),
    [walletsReady, wallets],
  );

  const externalAddress = useMemo(() => {
    const ext = wallets.find((w) => w.walletClientType !== 'privy');
    return ext?.address ?? null;
  }, [wallets]);

  const ready = privyReady && walletsReady;
  const missing = ready && authenticated && !embedded;

  const create = useCallback(async () => {
    setError(null);
    setCreating(true);
    try {
      await createWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a wallet.');
    } finally {
      setCreating(false);
    }
  }, [createWallet]);

  // Heal accounts created before `createOnLogin: 'all-users'` shipped: a user who
  // first signed in with MetaMask has no embedded wallet, so make one once.
  useEffect(() => {
    if (missing && !creating && !error) void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing]);

  return {
    address: embedded?.address ?? null,
    ready,
    externalAddress,
    missing,
    create,
    creating,
    error,
  };
}

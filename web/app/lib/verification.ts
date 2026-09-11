// app/lib/verification.ts
// Client-side: reading who is a verified unique human, and putting your own
// verification on-chain.
//
// Verification used to live in localStorage, which meant it was visible only to
// the person who already knew they were real. The badge a buyer actually needs
// is the one on someone *else's* profile, so the record now goes on Arc and the
// subgraph serves it to everyone.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSendTransaction } from '@privy-io/react-auth';
import { encodeFunctionData, type Abi } from 'viem';
import { ARC_CHAIN_ID } from './arc';
import abiJson from './Verifications.abi.json';

const abi = abiJson as Abi;

export const VERIFICATIONS_ADDRESS = (process.env.NEXT_PUBLIC_VERIFICATIONS_ADDRESS || '') as `0x${string}` | '';

export const verificationsConfigured = /^0x[a-fA-F0-9]{40}$/.test(VERIFICATIONS_ADDRESS);

const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

/** What the server hands back once it has verified a World proof. */
export type Attestation = {
  account: string;
  nullifier: string;
  level: string;
  deadline: string;
  signature: string;
  verifications: string;
  chainId: number;
};

export type OnChainVerification = {
  account: string; // lowercase
  nullifier: string;
  level: string;
  at: number; // unix seconds
};

/** The set of verified accounts, keyed lowercase. */
export type VerifiedSet = Map<string, OnChainVerification>;

export const VERIFICATION_FIELDS = 'id nullifier level at';

export function toVerification(row: Record<string, unknown>): OnChainVerification {
  return {
    account: String(row.id ?? '').toLowerCase(),
    nullifier: String(row.nullifier ?? ''),
    level: String(row.level ?? 'selfie'),
    at: Number(row.at ?? 0) || 0,
  };
}

/**
 * Every verified account, as one map.
 *
 * Fetched whole rather than per-address because the marketplace needs a badge
 * for every listing's owner at once, and a fan-out of one query per card is
 * exactly the round-trip storm the aggregate fields on Agent exist to avoid.
 * If this ever outgrows one page, filter by the owners on screen instead.
 */
export async function fetchVerified(first = 1000): Promise<VerifiedSet> {
  const map: VerifiedSet = new Map();
  if (!verificationsConfigured) return map;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ verifications(first: ${first}, orderBy: at, orderDirection: desc) { ${VERIFICATION_FIELDS} } }`,
      }),
    });
    const json = await res.json();
    // Before the datasource is deployed the field does not exist and the query
    // 400s. An empty map renders everyone as unverified, which is honest.
    if (json.errors) return map;
    for (const row of json.data?.verifications ?? []) {
      const v = toVerification(row);
      if (v.account) map.set(v.account, v);
    }
  } catch {}
  return map;
}

/** The verified set, loaded once. `null` while still loading. */
export function useVerified(nonce = 0): VerifiedSet | null {
  const [set, setSet] = useState<VerifiedSet | null>(null);
  useEffect(() => {
    let alive = true;
    fetchVerified()
      .then((m) => { if (alive) setSet(m); })
      .catch(() => { if (alive) setSet(new Map()); });
    return () => { alive = false; };
  }, [nonce]);
  return set;
}

/** One account's on-chain record, read straight from the subgraph. */
export async function fetchVerification(account: string): Promise<OnChainVerification | null> {
  if (!verificationsConfigured || !account) return null;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: ID!) { verification(id: $id) { ${VERIFICATION_FIELDS} } }`,
        variables: { id: account.toLowerCase() },
      }),
    });
    const json = await res.json();
    if (json.errors || !json.data?.verification) return null;
    return toVerification(json.data.verification);
  } catch {
    return null;
  }
}

/**
 * Submits a server-signed attestation as the logged-in wallet.
 *
 * The account in the signature is the one that must send the transaction, so
 * this deliberately takes no address argument beyond the wallet already bound to
 * the hook: signing as one account and sending as another is precisely what the
 * contract refuses, and it should fail here with a readable message rather than
 * on-chain with BadSignature.
 */
export function useAttest(address: string | null) {
  const { sendTransaction } = useSendTransaction();

  return useCallback(
    async (attestation: Attestation): Promise<string> => {
      if (!address) throw new Error('No wallet');
      if (!verificationsConfigured) throw new Error('NEXT_PUBLIC_VERIFICATIONS_ADDRESS is not set');
      if (attestation.account.toLowerCase() !== address.toLowerCase()) {
        throw new Error('This attestation was issued for a different wallet.');
      }
      const data = encodeFunctionData({
        abi,
        functionName: 'attest',
        args: [
          attestation.nullifier as `0x${string}`,
          attestation.level,
          BigInt(attestation.deadline),
          attestation.signature as `0x${string}`,
        ],
      });
      const { hash } = await sendTransaction(
        { to: VERIFICATIONS_ADDRESS as `0x${string}`, data, chainId: ARC_CHAIN_ID },
        { address }
      );
      return hash;
    },
    [address, sendTransaction]
  );
}

/**
 * Turns a failed attest() into something a person can act on. The contract's
 * custom errors arrive as selectors, which say nothing on their own.
 */
export function explainAttestFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const has = (sig: string) => msg.toLowerCase().includes(sig.toLowerCase());
  if (has('NullifierTaken') || has('0x8a2b7b1e')) {
    return 'This World ID has already verified a different wallet. One human, one account.';
  }
  if (has('AlreadyVerified')) return 'This wallet is already verified on-chain.';
  if (has('Expired')) return 'The attestation expired. Run the World check again.';
  if (has('BadSignature')) {
    return 'The attestation was rejected. The deployed contract may be pointing at a different attestor key.';
  }
  if (has('User rejected') || has('denied')) return 'You dismissed the wallet prompt.';
  if (has('insufficient funds')) return 'Not enough USDC on Arc to cover gas. Add funds and try again.';
  return msg || 'The verification transaction failed.';
}

// app/lib/attestation.ts
// Server-side: turns a World ID proof our RP server has already verified into an
// EIP-712 attestation the user can submit to Verifications.sol themselves.
//
// Arc has no World ID router, so the Semaphore proof cannot be checked on-chain.
// This is the bridge: the server did check it (action bound, wallet bound, and
// accepted by World's Developer Portal), and signs a statement to that effect
// that the contract will accept from exactly one account, once.
//
// The user broadcasts it and pays their own gas. The alternative — the server
// sending the transaction — needs a funded hot wallet on Arc that can quietly
// run dry, and turns our key into something that spends money rather than just
// signs facts.

import { privateKeyToAccount } from 'viem/accounts';

export const ATTESTOR_KEY = process.env.ATTESTOR_PRIVATE_KEY || '';

export const VERIFICATIONS_ADDRESS =
  (process.env.NEXT_PUBLIC_VERIFICATIONS_ADDRESS || '') as `0x${string}` | '';

export const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002);

/** How long a signed attestation stays submittable. Long enough to confirm a
 *  wallet prompt, short enough that a leaked one is not useful later. */
const TTL_SECONDS = 30 * 60;

export const EIP712_DOMAIN_NAME = 'SovereignVerifications';

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'account', type: 'address' },
    { name: 'nullifier', type: 'bytes32' },
    { name: 'level', type: 'string' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type Attestation = {
  account: `0x${string}`;
  nullifier: `0x${string}`;
  level: string;
  deadline: string; // decimal string — JSON has no BigInt
  signature: `0x${string}`;
  verifications: `0x${string}`;
  chainId: number;
};

/**
 * Why this returns null instead of throwing: World verification itself still
 * works without an attestor key, it just stays local to the browser. Before the
 * contract is deployed, or on a fork without the secret, the badge should
 * degrade to what it was rather than failing the whole flow.
 */
export function attestorProblem(): string | null {
  if (!ATTESTOR_KEY) return 'ATTESTOR_PRIVATE_KEY is not set.';
  const hex = ATTESTOR_KEY.startsWith('0x') ? ATTESTOR_KEY.slice(2) : ATTESTOR_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return 'ATTESTOR_PRIVATE_KEY must be a 32-byte hex private key.';
  if (!/^0x[a-fA-F0-9]{40}$/.test(VERIFICATIONS_ADDRESS)) {
    return 'NEXT_PUBLIC_VERIFICATIONS_ADDRESS is not set to a deployed contract.';
  }
  return null;
}

/** The address the deployed contract must have been constructed with. */
export function attestorAddress(): string | null {
  if (attestorProblem()) return null;
  const key = (ATTESTOR_KEY.startsWith('0x') ? ATTESTOR_KEY : `0x${ATTESTOR_KEY}`) as `0x${string}`;
  return privateKeyToAccount(key).address;
}

/**
 * Signs one attestation. `nullifier` must already be a 32-byte hex string —
 * World returns it that way, and a short or non-hex value would otherwise be
 * padded into a *different* nullifier than the one that was verified.
 */
export async function signAttestation(
  account: string,
  nullifier: string,
  level: string,
): Promise<Attestation | null> {
  if (attestorProblem()) return null;
  if (!/^0x[a-fA-F0-9]{64}$/.test(nullifier)) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return null;

  const key = (ATTESTOR_KEY.startsWith('0x') ? ATTESTOR_KEY : `0x${ATTESTOR_KEY}`) as `0x${string}`;
  const signer = privateKeyToAccount(key);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS);

  const message = {
    account: account as `0x${string}`,
    nullifier: nullifier as `0x${string}`,
    level,
    deadline,
  };

  const signature = await signer.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: '1',
      chainId: ARC_CHAIN_ID,
      verifyingContract: VERIFICATIONS_ADDRESS as `0x${string}`,
    },
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message,
  });

  return {
    ...message,
    deadline: deadline.toString(),
    signature,
    verifications: VERIFICATIONS_ADDRESS as `0x${string}`,
    chainId: ARC_CHAIN_ID,
  };
}

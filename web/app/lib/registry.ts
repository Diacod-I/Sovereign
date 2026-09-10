// app/lib/registry.ts
// Real on-chain listing: register / update / (de)activate agents in the Sovereign
// AgentRegistry, signed by the logged-in Privy embedded wallet on Arc. Same signing
// path as `useWithdraw` in components/wallet.tsx — the only difference is we attach
// `data` (encoded calldata) instead of a native `value`.

'use client';

import { useSendTransaction } from '@privy-io/react-auth';
import { encodeFunctionData, parseUnits, type Abi } from 'viem';
import { ARC_CHAIN_ID } from './arc';
import abiJson from './AgentRegistry.abi.json';

const abi = abiJson as Abi;

export const REGISTRY_ADDRESS =
  (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS as `0x${string}` | undefined) ??
  '0x5E20F2ffE4f7C1a27412D53ab5C248bfef921A75';

const ZERO = '0x0000000000000000000000000000000000000000';

export type ListingInput = {
  name: string;
  description: string;
  tags: string; // comma-separated
  price: string; // USDC per call, human units (e.g. "0.05")
  endpoint: string;
  payTo: string;
};

/** A unique, URL-safe slug from a display name + a short random suffix. */
export function slugFor(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

// Contract arg order is EXACT: id, payTo, pricePerCall, name, description, tags, endpoint.
// `pricePerCall` is a plain USDC-6 integer on-chain (parseUnits(price, 6)), even though
// Arc's *native* value fields are 18-dp — those are two different things.
function registerData(id: string, i: ListingInput) {
  return encodeFunctionData({
    abi,
    functionName: 'register',
    args: [
      id,
      (i.payTo?.trim() || ZERO) as `0x${string}`,
      parseUnits(i.price || '0', 6),
      i.name,
      i.description,
      i.tags,
      i.endpoint,
    ],
  });
}

function updateData(id: string, i: ListingInput) {
  return encodeFunctionData({
    abi,
    functionName: 'update',
    args: [
      id,
      (i.payTo?.trim() || ZERO) as `0x${string}`,
      parseUnits(i.price || '0', 6),
      i.name,
      i.description,
      i.tags,
      i.endpoint,
    ],
  });
}

function setActiveData(id: string, active: boolean) {
  return encodeFunctionData({ abi, functionName: 'setActive', args: [id, active] });
}

/**
 * Registry write helpers bound to the current embedded wallet. Each resolves the
 * tx hash once Privy has broadcast it; the subgraph takes ~3–5s to index, so
 * callers should refetch `fetchAgentsByOwner` on a short delay after this resolves.
 */
export function useRegistry(address: string | null) {
  const { sendTransaction } = useSendTransaction();

  const send = async (data: `0x${string}`): Promise<string> => {
    if (!address) throw new Error('No wallet');
    if (!REGISTRY_ADDRESS) throw new Error('NEXT_PUBLIC_REGISTRY_ADDRESS is not set');
    const { hash } = await sendTransaction(
      { to: REGISTRY_ADDRESS, data, chainId: ARC_CHAIN_ID },
      { address }
    );
    return hash;
  };

  return {
    /** register(): mints a fresh slug and lists the agent. Returns { hash, id }. */
    async register(input: ListingInput): Promise<{ hash: string; id: string }> {
      if (!input.payTo?.trim()) {
        // payTo must be non-zero on register — default it to the signer.
        input = { ...input, payTo: address ?? '' };
      }
      const id = slugFor(input.name);
      const hash = await send(registerData(id, input));
      return { hash, id };
    },
    /** update(): same 7 fields, keyed by the existing on-chain slug. */
    update(id: string, input: ListingInput): Promise<string> {
      return send(updateData(id, { ...input, payTo: input.payTo?.trim() || address || '' }));
    },
    /** setActive(): deactivate / reactivate a listing. */
    setActive(id: string, active: boolean): Promise<string> {
      return send(setActiveData(id, active));
    },
  };
}

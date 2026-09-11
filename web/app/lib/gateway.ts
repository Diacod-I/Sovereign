'use client';

// app/lib/gateway.ts
// Funding the balance that agent payments actually draw on.
//
// This exists because of a distinction that is invisible until it bites. There
// are two USDC balances behind one wallet:
//
//   - the plain ERC-20 balance, which is what the treasury card shows and what
//     a transfer or a withdrawal moves
//   - the Circle Gateway balance, held by the GatewayWallet contract on that
//     wallet's behalf, which is the ONLY thing an x402 batched authorisation
//     can spend
//
// An account can be full of USDC and still have every agent payment fail, with
// an error from deep inside a signing library that says nothing about which
// balance it meant. Moving USDC from the first to the second is a deliberate,
// one-time act, and it is worth showing as one.
//
// It is done from the browser with the user's own wallet rather than
// server-side through the delegation, on purpose: this is the step that decides
// how much the agent can ever spend, so it should be the step the human
// performs.

import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';

/**
 * Arc testnet, as Circle configures it. Hard-coded rather than imported from
 * @circle-fin/x402-batching so this module stays browser-safe: that package
 * pulls in node-flavoured transports the client bundle has no use for.
 */
export const GATEWAY = {
  usdc: '0x3600000000000000000000000000000000000000' as const,
  wallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const,
};

const WALLET_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'availableBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * How much to approve when an approval is needed at all.
 *
 * Not unlimited. Infinite approval is the reflex in this corner of the world and
 * it is the wrong tone for a product whose entire argument is bounded spending:
 * telling someone their agent can only ever spend what they moved across, while
 * quietly granting a contract permission to take everything, does not survive
 * being read aloud. A hundred covers twenty top-ups at the usual size, which is
 * enough that nobody meets the second prompt again during a demo.
 */
export const APPROVAL_HEADROOM_USDC = 100;

export const approveData = (amount: string) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [GATEWAY.wallet, parseUnits(amount, 6)],
  });

export const depositData = (amount: string) =>
  encodeFunctionData({
    abi: WALLET_ABI,
    functionName: 'deposit',
    args: [GATEWAY.usdc, parseUnits(amount, 6)],
  });

export const allowanceData = (owner: string) =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner as `0x${string}`, GATEWAY.wallet],
  });

export const availableBalanceData = (owner: string) =>
  encodeFunctionData({
    abi: WALLET_ABI,
    functionName: 'availableBalance',
    args: [GATEWAY.usdc, owner as `0x${string}`],
  });

/**
 * How much the Gateway contract is currently allowed to take, in human USDC.
 *
 * Read before topping up so an approval that already covers the amount is not
 * asked for again. This is the whole difference between the first top-up and
 * every one after it.
 *
 * Returns null when it cannot be read, and the caller must treat that as "ask
 * for the approval" rather than "assume there is one": a skipped approve makes
 * the deposit revert, which costs a wallet prompt AND a gas fee to learn
 * something a failed read already hinted at.
 */
export async function gatewayAllowance(rpcUrl: string, owner: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: GATEWAY.usdc, data: allowanceData(owner) }, 'latest'],
      }),
    });
    const json = await res.json();
    if (!json?.result || json.error) return null;
    return Number(BigInt(json.result)) / 1e6;
  } catch {
    return null;
  }
}

/**
 * What this wallet has available to agent payments, in human USDC.
 *
 * A plain eth_call through the public RPC rather than Circle's API: the number
 * is on-chain, and reading it should not depend on an API key that a deployment
 * may not have configured. Returns null when it cannot be read, which callers
 * must render as "unknown" rather than as zero -- telling someone their balance
 * is empty when the RPC merely timed out would send them to top up something
 * that was already funded.
 */
export async function gatewayAvailable(rpcUrl: string, owner: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: GATEWAY.wallet, data: availableBalanceData(owner) }, 'latest'],
      }),
    });
    const json = await res.json();
    if (!json?.result || json.error) return null;
    return Number(BigInt(json.result)) / 1e6;
  } catch {
    return null;
  }
}

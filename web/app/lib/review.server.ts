// app/lib/review.server.ts
// Filing a receipt on-chain from the server, signed by the buyer's delegated
// wallet.
//
// The browser already has a path for this (useFileReceipt), and it stays: a
// human at the dashboard should be able to grade without a terminal. This is
// the same transaction, sent on behalf of a buyer who is in a terminal instead,
// and who has told their agent what the grade is.
//
// The important boundary: the GRADE is never inferred here. It arrives as a
// number the human said out loud. A marketplace whose reputation scores were
// written by the same agents being scored would be worth nothing, and that
// property has to hold in the code rather than in the prompt.
//
// Privy is asked to SIGN rather than to SEND. Its send path wants a CAIP-2
// chain it recognises, and Arc testnet is not one it is guaranteed to know;
// signing returns a raw transaction that we broadcast to Arc ourselves, which
// keeps the chain's identity our problem rather than a third party's.

import { encodeFunctionData, parseUnits, toFunctionSelector, type Abi } from 'viem';
import abiJson from './Receipts.abi.json';
import { ARC_CHAIN_ID, ARC_RPC_URL } from './arc';
import { delegationProblem, privyWalletAddress } from './delegate.server';

const abi = abiJson as Abi;

const RECEIPTS = (process.env.NEXT_PUBLIC_RECEIPTS_ADDRESS || '') as `0x${string}` | '';

/** Same fallback the browser uses. The two must agree or they file different keys. */
const ZERO32 = ('0x' + '0'.repeat(64)) as `0x${string}`;

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export type ReviewInput = {
  account: string;
  agentId: string;
  settlementRef: string;
  amountUsdc: string;
  latencyMs: number;
  delivered: boolean;
  /** 0 not met, 1 partially met, 2 met. The human's verdict, never the agent's. */
  met: 0 | 1 | 2;
  expectation: string;
  note: string;
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ARC_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new ReviewError(`Arc RPC ${method} answered ${res.status}.`);
  const j = (await res.json()) as { result?: T; error?: { message?: string; data?: string } };
  if (j.error) {
    const e = new ReviewError(j.error.message || `Arc RPC ${method} failed.`);
    (e as ReviewError & { data?: string }).data = j.error.data;
    throw e;
  }
  return j.result as T;
}

const hex = (n: bigint | number) => ('0x' + BigInt(n).toString(16)) as `0x${string}`;

/**
 * Turn a revert from the Receipts contract into something a person can act on.
 *
 * Selectors are derived at runtime rather than pasted in, so this cannot drift
 * away from the contract without the signature itself changing.
 */
function explainRevert(data: string | undefined): string | null {
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === toFunctionSelector('AlreadyFiled()').toLowerCase()) {
    return 'This call has already been graded. A receipt is one per payment per buyer, on purpose: ' +
      'a grade you can redo is a grade nobody can trust.';
  }
  if (sel === toFunctionSelector('BadRating()').toLowerCase()) {
    return 'The rating must be 0 (not met), 1 (partially met) or 2 (met).';
  }
  if (sel === toFunctionSelector('NoAgent()').toLowerCase()) {
    return 'The receipt named no agent.';
  }
  return null;
}

/** Files the receipt and returns its transaction hash on Arc. */
export async function fileReceiptOnChain(input: ReviewInput): Promise<string> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(RECEIPTS)) {
    throw new ReviewError(
      'NEXT_PUBLIC_RECEIPTS_ADDRESS is not set on the Sovereign deployment, so no grade can be ' +
        'recorded. This is the marketplace\'s own configuration, not the worker\'s.',
    );
  }
  const problem = delegationProblem();
  if (problem) throw new ReviewError(problem);
  if (![0, 1, 2].includes(input.met)) {
    throw new ReviewError('The rating must be 0 (not met), 1 (partially met) or 2 (met).');
  }

  const from = (await privyWalletAddress(input.account)) ?? input.account;

  const ref = /^0x[a-fA-F0-9]{64}$/.test(input.settlementRef)
    ? (input.settlementRef as `0x${string}`)
    : ZERO32;

  const data = encodeFunctionData({
    abi,
    functionName: 'file',
    args: [
      input.agentId,
      ref,
      parseUnits(input.amountUsdc || '0', 6),
      Math.max(0, Math.round(input.latencyMs || 0)),
      input.delivered,
      input.met,
      input.expectation.slice(0, 400),
      input.note.slice(0, 400),
    ],
  });

  // Estimate first. A revert here costs nothing and carries the contract's own
  // reason, which is far better than broadcasting, paying gas, and reading a
  // failed receipt afterwards.
  let gas: bigint;
  try {
    const est = await rpc<string>('eth_estimateGas', [{ from, to: RECEIPTS, data }]);
    gas = (BigInt(est) * BigInt(125)) / BigInt(100);
  } catch (e) {
    const why = explainRevert((e as { data?: string }).data);
    if (why) throw new ReviewError(why);
    throw new ReviewError(
      `Arc refused the receipt before it was sent: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc<string>('eth_getTransactionCount', [from, 'pending']),
    rpc<string>('eth_gasPrice', []),
  ]);
  const gasPrice = BigInt(gasPriceHex);

  const { signedTransaction } = await (await privySigner()).walletApi.ethereum.signTransaction({
    address: from,
    transaction: {
      from: from as `0x${string}`,
      to: RECEIPTS as `0x${string}`,
      data: data as `0x${string}`,
      nonce: hex(BigInt(nonceHex)),
      chainId: hex(ARC_CHAIN_ID),
      gasLimit: hex(gas),
      // Doubled, because the grade is worth far more than the gas and a receipt
      // stuck in the mempool during a demo is indistinguishable from broken.
      maxFeePerGas: hex(gasPrice * BigInt(2)),
      maxPriorityFeePerGas: hex(gasPrice),
      type: 2,
    },
  });

  try {
    return await rpc<string>('eth_sendRawTransaction', [signedTransaction]);
  } catch (e) {
    const why = explainRevert((e as { data?: string }).data);
    if (why) throw new ReviewError(why);
    throw new ReviewError(
      `Arc rejected the signed receipt: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Kept separate so the module above reads as the transaction it builds. The
// client is structurally typed for the same reason x402-pay.server.ts does it:
// depending on the package's own types here would make this module fail to
// build exactly when the package is missing, which is when the clear error
// matters most.
type PrivySigningClient = {
  walletApi: {
    ethereum: {
      signTransaction: (args: {
        address: string;
        transaction: Record<string, unknown>;
      }) => Promise<{ signedTransaction: string }>;
    };
  };
};

let clientPromise: Promise<PrivySigningClient> | null = null;

async function privySigner(): Promise<PrivySigningClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const mod = (await import('@privy-io/server-auth')) as unknown as {
      PrivyClient: new (
        appId: string,
        appSecret: string,
        opts: { walletApi: { authorizationPrivateKey: string } },
      ) => PrivySigningClient;
    };
    return new mod.PrivyClient(
      process.env.NEXT_PUBLIC_PRIVY_APP_ID || '',
      process.env.PRIVY_APP_SECRET || '',
      { walletApi: { authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_KEY || '' } },
    );
  })().catch((e) => {
    clientPromise = null;
    throw e;
  });
  return clientPromise;
}

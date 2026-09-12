// app/lib/x402-pay.server.ts
// Paying for an x402 call with the buyer's own wallet, from the server.
//
// This is the piece that makes the marketplace an automation rather than a
// payment flow with extra steps. Everything before it could find a worker and
// tell you what it cost; the actual paying still needed either a human in a
// browser or a raw private key sitting in a config file.
//
// Neither was acceptable. A human in the loop on every call is not autonomy,
// and a private key in .mcp.json is a second wallet to fund and a credential on
// disk that can be committed by accident.
//
// The way out is narrower than it looks. Circle's GatewayClient wants a
// `privateKey`, but the thing that actually signs -- BatchEvmScheme -- asks
// only for `{ address, signTypedData }`. A Privy delegated wallet provides
// exactly that. So we keep the library's signing and re-implement the ten lines
// of HTTP around it, and the money moves from the account the user already has.
//
// WHAT IS BEING SIGNED: an EIP-3009 TransferWithAuthorization against Circle's
// GatewayWallet contract, not the USDC contract. It draws on the account's
// GATEWAY balance, which is why funding that balance is a prerequisite and has
// its own route. A wallet full of USDC with an empty Gateway balance cannot pay
// this way, and the error for that is worth reading rather than guessing at.

import { delegationProblem, privyWalletAddress, SERVER_MAX_PER_CALL } from './delegate.server';
import { gatewayAvailable } from './gateway';
import { ARC_RPC_URL } from './arc';

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';
const APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_KEY || '';

export const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002);
/** Circle's name for the chain, as CHAIN_CONFIGS keys it. */
export const GATEWAY_CHAIN = process.env.CIRCLE_GATEWAY_CHAIN || 'arcTestnet';

/** One entry of a 402's `accepts` list. */
type PaymentOption = {
  scheme?: string;
  network?: string;
  amount?: string;
  payTo?: string;
  extra?: { name?: string; version?: string; verifyingContract?: string };
};

/** The decoded PAYMENT-REQUIRED header. */
type PaymentRequired = {
  x402Version?: number;
  resource?: string;
  accepts?: PaymentOption[];
};

/** What the scheme hands back, ready to base64 into the header. */
type SignedPayload = { x402Version: number; payload: unknown };

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Only the corner of the Privy client this module uses. */
type PrivySigningClient = {
  walletApi: {
    ethereum: {
      signTypedData: (i: { address: string; typedData: TypedData }) => Promise<{ signature: string }>;
    };
  };
};

let clientPromise: Promise<PrivySigningClient> | null = null;

async function privyClient(): Promise<PrivySigningClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const mod = (await import('@privy-io/server-auth')) as unknown as Record<string, unknown>;
    const Ctor = mod.PrivyClient as new (id: string, secret: string, opts?: unknown) => unknown;
    if (!Ctor) throw new Error('@privy-io/server-auth did not export PrivyClient.');
    return new Ctor(APP_ID, APP_SECRET, {
      walletApi: { authorizationPrivateKey: AUTH_KEY },
    }) as PrivySigningClient;
  })().catch((e) => {
    clientPromise = null;
    throw e;
  });
  return clientPromise;
}

/**
 * The EIP712Domain type, reconstructed from whichever domain fields are present.
 *
 * viem adds this for you; a raw `eth_signTypedData_v4` payload must carry it or
 * the signature is over a different struct than the verifier will hash, which
 * fails as an invalid signature rather than as a malformed request -- the most
 * expensive kind of error to debug.
 */
const DOMAIN_FIELDS: Array<[string, string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

/**
 * The same structure with every BigInt rendered as a decimal string.
 *
 * Privy's wallet API is an HTTP call, so the payload goes through
 * JSON.stringify, and JSON.stringify throws on a BigInt rather than coercing
 * it -- "Do not know how to serialize a BigInt". An x402 authorisation is
 * full of them: chainId, value, validAfter, validBefore, nonce. They arrive
 * as BigInt because that is the only correct way to hold a uint256 in JS, and
 * they have to leave as strings because that is the only way to put a uint256
 * in JSON.
 *
 * This does not change what gets signed. EIP-712 hashes a uint256 by value, so
 * "1000" and 1000n encode to identical bytes, and the verifier recovers the
 * same signer either way.
 *
 * Exported for tests: this is the step that decides whether a correctly built
 * authorisation can leave the process at all.
 */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map(jsonSafe) as unknown as T;
  // Only plain objects. A Date or a typed array would be mangled by rebuilding
  // it from its own entries, and neither belongs in typed data anyway.
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out as unknown as T;
  }
  return value;
}

function withDomainType(td: TypedData): TypedData {
  if (td.types.EIP712Domain) return td;
  const present = DOMAIN_FIELDS.filter(([k]) => td.domain[k] !== undefined).map(([name, type]) => ({
    name,
    type,
  }));
  return { ...td, types: { ...td.types, EIP712Domain: present } };
}

/**
 * A BatchEvmSigner backed by a Privy delegated wallet.
 *
 * Structurally typed against the library's interface rather than importing it:
 * the interface is two members wide, and depending on the package's type
 * exports here would make this module fail to build whenever that package is
 * absent, which is exactly when the clear error matters most.
 */
export function delegatedSigner(account: string) {
  return {
    address: account as `0x${string}`,
    async signTypedData(params: TypedData): Promise<`0x${string}`> {
      const privy = await privyClient();
      // Ask Privy how it spells this address before signing with it. The
      // wallet API matches the stored string literally, so a lowercased
      // address -- which is what a link token carries -- fails with "no wallet
      // account found for address" even though the wallet plainly exists and
      // every preflight check on it passed. Falling back to `account` keeps
      // the original error when the wallet is genuinely absent, rather than
      // replacing it with a confusing null.
      const stored = (await privyWalletAddress(account)) ?? account;
      const { signature } = await privy.walletApi.ethereum.signTypedData({
        address: stored,
        typedData: jsonSafe(withDomainType(params)),
      });
      return signature as `0x${string}`;
    },
  };
}

export type PaidCall = {
  /** Whatever the worker returned. */
  data: unknown;
  /** Atomic USDC units actually authorised. */
  amount: bigint;
  /** Human amount, 6dp. */
  formattedAmount: string;
  /** Settlement reference, when the facilitator reported one. */
  transaction: string;
  status: number;
};

/** Thrown before any money is authorised. The caller can release its reservation. */
export class NotPaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotPaidError';
  }
}

/**
 * Run the full x402 exchange against `url`, paying from `account`.
 *
 * The order is the protocol's, and it is the whole reason this is safe: the
 * first request is unpaid and only tells us the price; nothing is signed until
 * the worker has answered with terms we have checked. A worker that is down
 * never reaches the signing step, which is why a broken endpoint costs a buyer
 * nothing here.
 */
export async function payAndCall(args: {
  account: string;
  url: string;
  body: unknown;
  /** Human USDC the caller has already authorised against the spend policy. */
  maxUsdc: number;
  /**
   * Override the signer. Production never passes this -- it exists so the
   * handshake can be exercised against a fake worker with a throwaway key,
   * which is the only way to check this transcription of the protocol without
   * moving real money.
   */
  signer?: { address: `0x${string}`; signTypedData: (t: TypedData) => Promise<`0x${string}`> };
}): Promise<PaidCall> {
  // Only the delegated path needs Privy configured. An injected signer brings
  // its own keys, so demanding the env here would make the seam untestable.
  if (!args.signer) {
    const problem = delegationProblem();
    if (problem) throw new NotPaidError(problem);
  }

  let lib: {
    BatchEvmScheme: new (signer: ReturnType<typeof delegatedSigner>) => {
      createPaymentPayload: (v: number, req: PaymentOption) => Promise<SignedPayload>;
    };
    CHAIN_CONFIGS: Record<string, { chain: { id: number } } | undefined>;
  };
  try {
    lib = (await import('@circle-fin/x402-batching/client')) as unknown as typeof lib;
  } catch {
    throw new NotPaidError('@circle-fin/x402-batching is not installed on the server.');
  }
  const { BatchEvmScheme, CHAIN_CONFIGS } = lib;

  const chainConfig = CHAIN_CONFIGS[GATEWAY_CHAIN];
  if (!chainConfig) {
    throw new NotPaidError(`CIRCLE_GATEWAY_CHAIN "${GATEWAY_CHAIN}" is not a chain Gateway supports.`);
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const serialized = JSON.stringify(body(args.body));

  const first = await fetch(args.url, { method: 'POST', headers, body: serialized });

  // A worker that serves without asking is not an error, but it is also not a
  // purchase: return what came back and let the caller say it was free.
  if (first.status !== 402) {
    if (first.ok) {
      return {
        data: await first.json().catch(() => ({})),
        amount: BigInt(0), // literal 0n needs ES2020; this tsconfig targets lower
        formattedAmount: '0',
        transaction: '',
        status: first.status,
      };
    }
    const text = await first.text().catch(() => '');
    throw new NotPaidError(
      `The worker answered HTTP ${first.status} before any payment. ${text.slice(0, 200)}`.trim(),
    );
  }

  const required = first.headers.get('PAYMENT-REQUIRED');
  if (!required) throw new NotPaidError('The worker returned 402 with no PAYMENT-REQUIRED header.');

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = JSON.parse(Buffer.from(required, 'base64').toString('utf-8')) as PaymentRequired;
  } catch {
    throw new NotPaidError('The worker’s PAYMENT-REQUIRED header was not readable.');
  }

  const accepts: PaymentOption[] = paymentRequired?.accepts ?? [];
  const network = `eip155:${chainConfig.chain.id}`;
  const option = accepts.find(
    (o) =>
      o?.network === network &&
      o?.extra?.name === 'GatewayWalletBatched' &&
      o?.extra?.version === '1' &&
      typeof o?.extra?.verifyingContract === 'string',
  );
  if (!option) {
    throw new NotPaidError(
      `This worker does not offer Circle Gateway payment on ${network}, so this account cannot pay it.`,
    );
  }

  // The price the worker asks for now, not the price its listing advertised.
  // They are usually the same and the gap is exactly what this check exists for:
  // a listing is a claim, a 402 is a demand, and only the second one takes money.
  const amount = BigInt(option.amount ?? '0');
  const asked = Number(amount) / 1e6;
  if (asked > args.maxUsdc) {
    throw new NotPaidError(
      `The worker asked for ${asked} USDC at call time but its listing says ${args.maxUsdc}. Refused.`,
    );
  }
  if (asked > SERVER_MAX_PER_CALL) {
    throw new NotPaidError(
      `Refused: ${SERVER_MAX_PER_CALL} USDC is the hard per-call ceiling on this server.`,
    );
  }

  // Checked BEFORE signing, because signing does not check it.
  //
  // A Gateway authorization is just a signature; nothing verifies the balance
  // until the facilitator tries to settle. So an empty spending balance used to
  // surface as the worker rejecting a paid request, which reads as the worker
  // being broken and leaves the caller unable to say whether money moved. It is
  // the single most likely first-run failure and it deserves its own sentence.
  //
  // A balance that cannot be read is not treated as empty: the RPC being down
  // is not a reason to refuse a payment that would have worked.
  const funded = await gatewayAvailable(ARC_RPC_URL, args.account);
  if (funded !== null && funded < asked) {
    throw new NotPaidError(
      `Not enough in the agent spending balance: this call costs ${asked} USDC and ` +
      `${funded} is available. This is separate from the treasury, so a funded wallet ` +
      `can still be empty here. Top it up under "Agent spending balance" on Overview.`,
    );
  }

  const scheme = new BatchEvmScheme(args.signer ?? delegatedSigner(args.account));
  const x402Version = paymentRequired.x402Version ?? 2;

  let payload: SignedPayload;
  try {
    payload = await scheme.createPaymentPayload(x402Version, option);
  } catch (e) {
    // Signing failed, so nothing was authorised.
    //
    // Attribution matters more than it looks here. This error travels to a
    // model that is deciding what to tell a buyer, and an unlabelled Privy
    // message like "Invalid app ID or app secret" reads as the WORKER being
    // misconfigured -- which sends the buyer to find another seller for a fault
    // that is entirely ours. Say whose problem it is.
    const raw = e instanceof Error ? e.message : 'Could not sign the payment.';
    throw new NotPaidError(
      `Sovereign could not sign this payment (this is the marketplace's own configuration, ` +
        `not the worker's): ${raw}`,
    );
  }

  const header = Buffer.from(
    JSON.stringify({ ...payload, resource: paymentRequired.resource, accepted: option }),
  ).toString('base64');

  const paid = await fetch(args.url, {
    method: 'POST',
    headers: { ...headers, 'Payment-Signature': header },
    body: serialized,
  });

  let settle: { transaction?: string } | undefined;
  const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
  if (settleHeader) {
    try {
      settle = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf-8'));
    } catch {
      settle = undefined;
    }
  }

  if (!paid.ok) {
    // Past this point an authorisation exists, so this is NOT a NotPaidError:
    // whether it settled is the facilitator's business and the caller must not
    // assume the money stayed put.
    const detail = await paid.text().catch(() => '');
    throw new Error(
      `The worker refused the paid call (HTTP ${paid.status}). ${detail.slice(0, 200)}`.trim(),
    );
  }

  return {
    data: await paid.json().catch(() => ({})),
    amount,
    formattedAmount: (Number(amount) / 1e6).toString(),
    transaction: settle?.transaction ?? '',
    status: paid.status,
  };
}

/** Workers are called with `{ input }`, the same envelope the hosted proxy expects. */
const body = (input: unknown) => ({ input });

// Autonomous x402 settlement for `call_agent`.
//
// Two modes, chosen by whether the operator provisioned an agent key:
//
//   KEYLESS (default)  — call_agent returns a payment intent that the human
//                        confirms in the Sovereign web app, where the buyer's
//                        embedded Privy wallet signs the transfer.
//
//   AUTONOMOUS         — this module. The agent pays the worker itself:
//                        Circle Gateway signs an EIP-3009 authorization off the
//                        agent's own key and settles it batched + gasless on Arc.
//
// The previous revision called a `GatewayClient({ network, apiKey, signer })`
// API that does not exist in @circle-fin/x402-batching. This is written against
// the real v3 surface: `new GatewayClient({ chain, privateKey }).pay(url, ...)`.

const CHAIN = process.env.CIRCLE_GATEWAY_CHAIN || 'arcTestnet';
const AGENT_KEY = process.env.SOVEREIGN_AGENT_KEY || '';
const RPC_URL = process.env.ARC_RPC_URL || '';
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || '';

/** Hard ceiling per call, in whole USDC. Refuses anything above it. */
const MAX_PER_CALL = Number(process.env.SOVEREIGN_MAX_PER_CALL || '1');

export function hasAutonomousKeys() {
  return /^0x[0-9a-fA-F]{64}$/.test(AGENT_KEY);
}

/** Explains why autonomous mode is off, for the keyless fallback note. */
export function autonomousDisabledReason() {
  if (!AGENT_KEY) return 'SOVEREIGN_AGENT_KEY is not set';
  if (!/^0x[0-9a-fA-F]{64}$/.test(AGENT_KEY)) {
    return 'SOVEREIGN_AGENT_KEY must be a 32-byte hex private key (0x + 64 hex chars)';
  }
  return null;
}

let clientPromise = null;

/**
 * Lazily builds the Gateway client. Cached: constructing it creates viem
 * public/wallet clients, and `call_agent` may be invoked many times per session.
 */
function getGatewayClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const { GatewayClient } = await import('@circle-fin/x402-batching/client');
    const client = new GatewayClient({
      chain: CHAIN,
      privateKey: AGENT_KEY,
      ...(RPC_URL ? { rpcUrl: RPC_URL } : {}),
      ...(CIRCLE_API_KEY ? { headers: { Authorization: `Bearer ${CIRCLE_API_KEY}` } } : {}),
    });

    // Spend policy, enforced BEFORE the authorization is signed. This is the
    // agent-side mirror of the buyer dashboard's per-action limit: an
    // over-budget worker never gets a signature, not just a failed settlement.
    client.onBeforePaymentCreation(async (ctx) => {
      const atomic = BigInt(ctx?.selectedRequirements?.amount ?? '0');
      const usdc = Number(atomic) / 1e6;
      if (usdc > MAX_PER_CALL) {
        return {
          abort: true,
          reason: `worker asked for ${usdc} USDC, above the agent's per-call cap of ${MAX_PER_CALL} USDC`,
        };
      }
    });

    return client;
  })().catch((e) => {
    clientPromise = null; // let a later call retry
    throw e;
  });
  return clientPromise;
}

/**
 * Autonomously call + pay a worker over x402.
 *
 * Flow (all inside `pay`): request → 402 with requirements → sign a Gateway
 * batched authorization → retry with the payment header → 200 with the output.
 *
 * Returns { output, settlement }. Throws on any misconfiguration or refusal so
 * `call_agent` can fall back to the keyless payment intent.
 */
export async function settleAndCall(agent, input) {
  if (!agent?.endpoint || !/^https?:\/\//i.test(agent.endpoint)) {
    throw new Error('agent has no reachable endpoint');
  }

  const gateway = await getGatewayClient();
  const result = await gateway.pay(agent.endpoint, {
    method: 'POST',
    body: { input },
    headers: { 'content-type': 'application/json' },
  });

  const body = result?.data ?? {};
  return {
    output: body.output ?? body,
    settlement: {
      paid: true,
      amount: result.formattedAmount ?? (Number(agent.pricePerCall) / 1e6).toString(),
      asset: 'USDC',
      payTo: agent.payTo,
      network: CHAIN,
      payer: gateway.address,
      transaction: result.transaction ?? null,
      status: result.status,
    },
  };
}

/** Gateway + wallet balances for the agent key — surfaced by the `wallet` tool. */
export async function agentBalances() {
  const gateway = await getGatewayClient();
  const balances = await gateway.getBalances();
  return { address: gateway.address, chain: CHAIN, balances };
}

/** One-time top-up of the agent's Gateway runway. */
export async function depositToGateway(amount) {
  const gateway = await getGatewayClient();
  return gateway.deposit(String(amount));
}

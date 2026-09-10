// Autonomous settlement for call_agent (PAYMENT-LOOP-PLAYBOOK lock-ins 1 + 3).
//
// Keyless mode (default): call_agent returns a payment intent the human confirms in
// the web app. This module is the OTHER mode — when the operator has provisioned a
// Privy server wallet + Circle Gateway keys, the agent pays autonomously:
//
//   Privy server wallet (signer)  →  Circle Gateway.wrapFetch  →  x402 on the worker
//
// Everything here is guarded: missing keys or missing packages fall back to keyless.
// Fill the vars in .env.example — each `TODO: paste key` is a real credential.

export function hasAutonomousKeys() {
  return Boolean(
    process.env.PRIVY_APP_ID &&
    process.env.PRIVY_APP_SECRET &&
    process.env.PRIVY_AUTHORIZATION_KEY &&
    process.env.CIRCLE_GATEWAY_NETWORK &&
    process.env.CIRCLE_API_KEY
  );
}

// Lazily build { fetchWithPay, walletAddress }. Throws if anything is missing so the
// caller can catch and fall back to the keyless intent.
async function buildGatewayFetch() {
  // --- lock-in 1: Privy server wallet as the signer ---
  const { PrivyClient } = await import('@privy-io/server-auth'); // npm i @privy-io/server-auth
  const privy = new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET, {
    walletApi: { authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_KEY }, // TODO: paste key (P-256 private key)
  });

  const walletId = process.env.PRIVY_WALLET_ID; // TODO: paste key — id of the pre-created agent server wallet
  const walletAddress = process.env.PRIVY_WALLET_ADDRESS || null;
  if (!walletId) throw new Error('PRIVY_WALLET_ID not set (create one once via privy.walletApi.createWallet)');

  // A minimal signer shim over the Privy server wallet — the shape @circle-fin/x402-batching
  // expects. Reconcile method names against the arc-nanopayments sample.
  const signer = {
    address: walletAddress,
    async signTypedData(typedData) {
      const { signature } = await privy.walletApi.ethereum.signTypedData({ walletId, typedData });
      return signature;
    },
    async sendTransaction(tx) {
      const { hash } = await privy.walletApi.ethereum.sendTransaction({
        walletId,
        caip2: `eip155:${process.env.ARC_CHAIN_ID || 5042002}`,
        transaction: tx,
      });
      return hash;
    },
  };

  // --- lock-in 3: Circle Gateway wraps fetch, auto-signs X-PAYMENT on 402 ---
  const { GatewayClient } = await import('@circle-fin/x402-batching'); // npm i @circle-fin/x402-batching
  const gateway = new GatewayClient({
    network: process.env.CIRCLE_GATEWAY_NETWORK, // arc-testnet | arc
    apiKey: process.env.CIRCLE_API_KEY,          // TODO: paste key
    facilitatorUrl: process.env.CIRCLE_FACILITATOR_URL || undefined,
    signer,
  });

  // The buyer's Gateway balance is the runway nanopayments draw from. Top it up once
  // out-of-band: `await gateway.deposit({ amount: '5.00' })` (see playbook lock-in 3.2).
  const fetchWithPay = gateway.wrapFetch(fetch);
  return { fetchWithPay, walletAddress };
}

/**
 * Autonomously call + pay a worker. Returns { output, settlement }.
 * Throws on any misconfiguration so call_agent can fall back to the keyless intent.
 */
export async function settleAndCall(agent, input) {
  const { fetchWithPay } = await buildGatewayFetch();
  const res = await fetchWithPay(agent.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`worker responded ${res.status}`);
  const body = await res.json().catch(() => ({}));
  return {
    output: body.output ?? body,
    settlement: {
      paid: true,
      amount: (Number(agent.pricePerCall) / 1e6).toString(),
      asset: 'USDC',
      payTo: agent.payTo,
      network: process.env.CIRCLE_GATEWAY_NETWORK,
      reference: res.headers.get('x-payment-response') || body.settlement || 'see Gateway dashboard',
    },
  };
}

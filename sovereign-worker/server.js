// sovereign-worker — a seller's x402-gated task endpoint.
//
// The x402 order is verify → serve → settle, and it is enforced by Circle's
// Gateway middleware rather than by hand:
//
//   1) VERIFY  — is the buyer's signed payment authorization valid? (no capture)
//   2) SERVE   — run the seller's work, return the output
//   3) SETTLE  — capture on Arc via Circle Gateway (batched, gasless)
//
// Unlike the previous revision this is the real facilitator, not a stub that
// accepted any non-empty header. With no CIRCLE_API_KEY the server still boots,
// but it refuses to pretend a payment happened — see UNPAID_MODE below.

import express from 'express';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';

const PORT = Number(process.env.PORT || 8787);
const PRICE = process.env.PRICE || '0.05';
const PAYTO = process.env.WORKER_PAYTO || '';
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);
const NETWORK = `eip155:${CHAIN_ID}`;               // CAIP-2, what Gateway expects
const FACILITATOR_URL =
  process.env.CIRCLE_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com';
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || '';

// Escape hatch for local development only: serve /task without payment so the
// worker logic can be exercised offline. It is opt-in and loudly logged, so it
// can never be mistaken for a working payment path in a demo.
const UNPAID_MODE = process.env.ALLOW_UNPAID === 'true';

if (!/^0x[a-fA-F0-9]{40}$/.test(PAYTO)) {
  console.error(
    '[sovereign-worker] WORKER_PAYTO must be the seller\'s Arc address (0x + 40 hex).\n' +
    '                   It has to match the agent\'s on-chain `payTo` in AgentRegistry.',
  );
  if (!UNPAID_MODE) process.exit(1);
}

// --- Circle Gateway middleware (verify / settle) ------------------------------
// `require('$0.05')` answers an unpaid request with 402 + the exact requirements
// the buyer's x402 client must sign, then verifies and settles the retry.
const gateway = createGatewayMiddleware({
  sellerAddress: PAYTO,
  networks: [NETWORK],
  facilitatorUrl: FACILITATOR_URL,
  description: process.env.WORKER_DESCRIPTION || 'Sovereign seller agent task',
  ...(CIRCLE_API_KEY ? { headers: { Authorization: `Bearer ${CIRCLE_API_KEY}` } } : {}),
});

gateway.onAfterVerify(async (ctx) => {
  console.log('[sovereign-worker] verified payment from', ctx?.result?.payer ?? '(unknown payer)');
});
gateway.onAfterSettle(async (ctx) => {
  console.log('[sovereign-worker] settled', ctx?.result?.transaction ?? ctx?.result);
});
gateway.onSettleFailure(async (ctx) => {
  console.error('[sovereign-worker] settle FAILED — payment not captured:', ctx?.error ?? ctx);
});

// --- the seller's actual work -------------------------------------------------
// Swap this for a real call to an LLM / tool / MCP. Deterministic for the demo.
async function runWorker(input) {
  return {
    ok: true,
    echo: input,
    summary: `Processed ${JSON.stringify(input ?? {}).length} bytes of input`,
    at: new Date().toISOString(),
  };
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    price: PRICE,
    payTo: PAYTO,
    network: NETWORK,
    facilitator: FACILITATOR_URL,
    paid: !UNPAID_MODE,
  }),
);

const paywall = UNPAID_MODE
  ? (_req, _res, next) => next()
  : gateway.require(`$${PRICE}`);

app.post('/task', paywall, async (req, res) => {
  try {
    const output = await runWorker(req.body?.input ?? req.body ?? {});
    // req.payment is populated by the middleware after verify+settle.
    res.json({
      output,
      payment: req.payment
        ? {
            verified: req.payment.verified,
            payer: req.payment.payer,
            amount: req.payment.amount,
            network: req.payment.network,
            transaction: req.payment.transaction,
          }
        : { verified: false, note: 'ALLOW_UNPAID=true — no payment was taken' },
    });
  } catch (e) {
    // Throwing before the response means the middleware never settles.
    res.status(500).json({ error: 'worker error: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[sovereign-worker] :${PORT} — POST /task — $${PRICE} USDC → ${PAYTO} on ${NETWORK}`);
  if (UNPAID_MODE) {
    console.warn('[sovereign-worker] ⚠ ALLOW_UNPAID=true — /task is NOT gated. Local dev only.');
  } else if (!CIRCLE_API_KEY) {
    console.warn('[sovereign-worker] ⚠ CIRCLE_API_KEY is not set — verify/settle calls to Gateway will be rejected.');
  }
  console.log('[sovereign-worker] expose a public URL (`npx cloudflared tunnel --url http://localhost:' + PORT + '`) and register it as the agent endpoint.');
});

// sovereign-worker — a seller's x402-gated task endpoint (PAYMENT-LOOP-PLAYBOOK
// lock-in 4). It does the job and captures payment in the x402 order:
//   1) VERIFY  — is the buyer's signed X-PAYMENT authorization valid? (no capture)
//   2) SERVE   — run the work, return the output
//   3) SETTLE  — capture on Arc via Circle Gateway (batched, gasless), AFTER serving
//
// Circle Gateway wiring is stubbed behind `loadFacilitator()`. Fill the CIRCLE_*
// env vars (see .env.example) and swap the stub for the real GatewayClient from the
// `circlefin/arc-nanopayments` sample — every other line stays the same.

import express from 'express';

const PORT = Number(process.env.PORT || 8787);
const PRICE = process.env.PRICE || '0.05';
const PAYTO = process.env.WORKER_PAYTO || '';
const NETWORK = process.env.CIRCLE_GATEWAY_NETWORK || 'arc-testnet';

if (!PAYTO) console.warn('[sovereign-worker] WORKER_PAYTO is not set — 402 requirements will be incomplete.');

// --- Circle Gateway facilitator (verify / settle) -----------------------------
// Real impl: `import { Facilitator } from '@circle-fin/x402-batching'` and construct
// it with CIRCLE_FACILITATOR_URL + CIRCLE_API_KEY. Until those keys exist this stub
// keeps the server runnable: it "verifies" any non-empty X-PAYMENT and no-ops settle.
async function loadFacilitator() {
  const url = process.env.CIRCLE_FACILITATOR_URL;
  const key = process.env.CIRCLE_API_KEY;
  if (url && key) {
    try {
      const { Facilitator } = await import('@circle-fin/x402-batching');
      return new Facilitator({ url, apiKey: key, network: NETWORK }); // TODO: reconcile ctor with the arc-nanopayments sample
    } catch (e) {
      console.warn('[sovereign-worker] @circle-fin/x402-batching not installed; using stub facilitator:', e.message);
    }
  }
  return {
    async verify(payment /*, requirements */) {
      return { isValid: Boolean(payment), _stub: true };
    },
    async settle(/* payment, requirements */) {
      return { settled: true, _stub: true, reference: 'stub-' + Date.now() };
    },
  };
}

// --- the seller's actual work -------------------------------------------------
// Swap this for a real call to an LLM / tool / MCP. Deterministic for the demo.
async function runWorker(input) {
  return {
    ok: true,
    echo: input,
    summary: `Processed ${JSON.stringify(input).length} bytes of input`,
    at: new Date().toISOString(),
  };
}

const facilitatorReady = loadFacilitator();

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, price: PRICE, payTo: PAYTO, network: NETWORK }));

app.post('/task', async (req, res) => {
  const facilitator = await facilitatorReady;
  const requirements = { price: PRICE, payTo: PAYTO, asset: 'USDC', network: NETWORK };

  const payment = req.header('X-PAYMENT');
  if (!payment) {
    // No authorization yet — tell the buyer's x402 client what to sign, then retry.
    return res.status(402).json({ error: 'payment required', accepts: [requirements] });
  }

  // 1) VERIFY (no capture)
  let verified;
  try {
    verified = await facilitator.verify(payment, requirements);
  } catch (e) {
    return res.status(402).json({ error: 'verify failed: ' + e.message, accepts: [requirements] });
  }
  if (!verified?.isValid) {
    return res.status(402).json({ error: 'invalid payment authorization', accepts: [requirements] });
  }

  // 2) SERVE — run the work and return it. If the worker throws, we never settle.
  let output;
  try {
    output = await runWorker(req.body?.input ?? req.body ?? {});
  } catch (e) {
    return res.status(500).json({ error: 'worker error: ' + e.message });
  }
  res.json({ output, payment: { verified: true, network: NETWORK } });

  // 3) SETTLE — capture on Arc via Gateway, after the response is out. Batched.
  try {
    const s = await facilitator.settle(payment, requirements);
    console.log('[sovereign-worker] settled', s?.reference ?? s);
  } catch (e) {
    console.error('[sovereign-worker] settle failed (payment not captured):', e.message);
  }
});

app.listen(PORT, () => {
  console.log(`[sovereign-worker] :${PORT} — POST /task — price ${PRICE} USDC → ${PAYTO || '(WORKER_PAYTO unset)'} on ${NETWORK}`);
  console.log('[sovereign-worker] expose a public URL (e.g. `npx cloudflared tunnel --url http://localhost:' + PORT + '`) and register it as the agent endpoint.');
});

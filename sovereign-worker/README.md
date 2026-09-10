# sovereign-worker

Template x402-gated endpoint for a **Sovereign seller agent**. It runs the seller's
work and captures payment per call, in the x402 order **verify → serve → settle**,
settling on Arc through **Circle Gateway** (batched, gasless).

This is the counterpart to `sovereign-mcp` (the *buyer's* discovery/pay client) —
different role, different package. See `docs/PAYMENT-LOOP-PLAYBOOK.md` lock-in 4.

## Run (testnet)

```bash
cd sovereign-worker
npm install
cp .env.example .env         # fill WORKER_PAYTO, PRICE, and the CIRCLE_* keys
npm start                    # :8787, POST /task

# expose it so a buyer can reach it, then register that URL as the agent's endpoint
npx cloudflared tunnel --url http://localhost:8787     # or: ngrok http 8787
```

## Wiring the real facilitator

`server.js` ships a **stub facilitator** so the server runs with no keys (it accepts
any non-empty `X-PAYMENT` and no-ops `settle`). To make settlement real:

1. `npm i @circle-fin/x402-batching` (the package the `circlefin/arc-nanopayments`
   sample uses — clone that sample and copy its exact versions + facilitator config).
2. Set `CIRCLE_FACILITATOR_URL` and `CIRCLE_API_KEY` in `.env`.
3. In `loadFacilitator()`, replace the stub construction with the sample's real
   `Facilitator` / `GatewayClient` — the `verify()` / `settle()` call sites don't change.

## Contract

- `POST /task` with `{ "input": ... }`.
  - No `X-PAYMENT` header → `402` + `{ accepts: [requirements] }` (price, payTo, asset, network).
  - Valid `X-PAYMENT` → `200` `{ output }`, then settle in the background.
  - `price` / `payTo` **must match** the agent's on-chain `pricePerCall / 1e6` and `payTo`.
- `GET /health` → `{ ok, price, payTo, network }`.

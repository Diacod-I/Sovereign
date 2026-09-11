# sovereign-worker

Template **x402-gated endpoint** for a Sovereign seller agent. It runs the seller's
work and captures payment per call, in the x402 order **verify → serve → settle**
settling on Arc through **Circle Gateway** (batched, gasless).

This is the counterpart to `sovereign-mcp` (the *buyer's* discovery/pay client).

## Run (testnet)

```bash
cd sovereign-worker
npm install
cp .env.example .env         # fill WORKER_PAYTO, PRICE, CIRCLE_API_KEY
npm start                    # :8787, POST /task

# expose it so a buyer can reach it, then register that URL as the agent endpoint
npx cloudflared tunnel --url http://localhost:8787     # or: ngrok http 8787
```

`WORKER_PAYTO` is required, the server exits without it, because a worker that
cannot name a payee cannot be paid.

## Contract

- `POST /task` with `{ "input": ... }`
  - No payment → **402**, with the signable requirements in a base64
    `PAYMENT-REQUIRED` header (`amount`, `payTo`, `asset`, `network`
    `extra.verifyingContract`). The body is empty by design.
  - Valid `Payment-Signature` → **200** `{ output, payment }`, after Gateway has
    verified and settled.
- `GET /health` → `{ ok, price, payTo, network, facilitator, paid }`

`PRICE` and `WORKER_PAYTO` **must match** the agent's on-chain `pricePerCall / 1e6`
and `payTo` in `AgentRegistry`, or buyers will sign an authorization the registry
disagrees with.

## Testing without Circle keys

```bash
npm test        # node test/e2e-x402.mjs
```

This runs the real worker and a real buyer client against a **mocked Circle Gateway**
and asserts the whole loop: 402 with signable requirements → the buyer signs → the
worker verifies, serves and settles → 200 with output, with `verify` strictly before
`settle` and `settle` called exactly once. Only Circle's hosted API is stubbed; the
middleware, the client, the EIP-712 signing and the HTTP handshake are all real.

For local development of the worker's own logic, `ALLOW_UNPAID=true` disables the
paywall entirely. It is loudly logged on boot and must never be set on a deployed
worker.

## Notes

- The header is `Payment-Signature`, not `X-PAYMENT`. An earlier revision of this
  template read `X-PAYMENT` and accepted any non-empty value, that stub is gone.
- Settlement is batched: `req.payment.transaction` is Gateway's settlement
  reference for the batch, not a per-call on-chain transfer.

## License

MIT

# Sovereign: architecture and sponsor integrations

Paste-ready for the submission. The sponsor sections answer "why this protocol"
rather than "we used this protocol", which is what the feedback asked for.

---

## What it is

A freelance marketplace of agents, for your agent.

A seller points Sovereign at any webhook and it becomes a paid worker. A buyer
pairs their terminal once, and from then on their coding agent can find that
worker, hire it, pay per call in USDC, and file a grade on the result. No
subscriptions, no API keys handed around, no human in the middle of each call.

## The flow, end to end

```
Buyer's agent (Claude Code + sovereign-mcp)
  │
  │ 1. search_agents          reads the registry from The Graph. Free.
  │ 2. call_agent             POST /api/agent/call, bearer = pairing token
  ▼
Sovereign server
  │ 3. reads the listing FROM CHAIN                 (never from the caller)
  │ 4. checks the spend policy                      allowlist, per-call cap, daily budget
  │ 5. reserves the amount                          before anything is signed
  ▼
Worker endpoint  /w/<slug>
  │ 6. unpaid POST  →  402 + payment terms          the worker quotes its price
  │ 7. server signs an x402 authorization           Privy delegated wallet
  │ 8. retry with the signature  →  200             Circle Gateway settles
  │ 9. proxies to the seller's webhook              their secret never leaves us
  ▼
Back to the buyer
  │ 10. output + settlement reference
  │ 11. user states a verdict → rate_call
  │ 12. Receipts.file(...) on Arc                   signed by the wallet that paid
  ▼
The Graph reindexes → the worker's public track record changes
```

Three things about that order are load-bearing:

**Nothing is signed before the worker quotes.** The first request is unpaid. A
worker that is down never returns terms, so it never gets paid. The earlier
design had a "pay then call" button, and it could take money and deliver
nothing.

**The listing is read from chain, not from the request.** A caller holding a
valid pairing token could otherwise name any price and any recipient. The token
authorises "spend within my policy", not "spend wherever you say".

**The grade is signed by the wallet that paid.** You cannot review work you did
not buy, and the contract enforces one receipt per payment per buyer.

## On-chain

Three contracts on Arc testnet, all indexed by one subgraph.

- **AgentRegistry** — listings. `register`, `update`, `setActive`, all
  `onlyOwner(id)`. The registry is the source of truth for what a worker costs
  and who gets paid, which is why the server reads it rather than trusting a
  caller.
- **Receipts** — one graded outcome per payment. Carries the buyer's stated
  expectation, whether anything was delivered, latency, and a 0/1/2 verdict.
  Replay key is `keccak256(buyer, settlementRef)`, so a grade cannot be redone.
- **Verifications** — World ID proofs, attestor-signed over EIP-712, one
  nullifier to one account.

The subgraph aggregates receipts into a track record on the `Agent` entity:
calls served, delivered count, summed verdict, total paid, mean latency,
distinct buyers, and **repeat buyers**, which is the strongest quality signal in
the set. They are running totals rather than query-time derivations because a
buyer's agent choosing between workers cannot afford to fan out.

## Off-chain

- **Next.js** app: marketplace, seller tools, dashboard, and the payment routes.
- **sovereign-mcp**: an MCP server on npm. `npx sovereign-mcp@latest link
  --spend` pairs a terminal in one command and writes nothing sensitive beyond a
  scoped token.
- **Upstash Redis**: pairing tokens, spend policies, hosted-worker config and
  sealed seller secrets.
- The spend policy is enforced server-side on every call, whatever the agent
  decides to do.

---

## Circle — x402 and Gateway

**Why:** the payment IS the call. Per-call hiring at a tenth of a cent only
works if settlement is cheap enough to be invisible and fast enough to sit
inside a request. Card rails cannot do a 0.10 charge; subscriptions defeat the
premise, which is that your agent hires a worker it has never used before and
may never use again.

**How:** each worker sits behind an x402 paywall. An unpaid POST returns 402
with terms; Sovereign signs a batched Gateway authorization with
`@circle-fin/x402-batching` and retries; the settlement reference comes back in
the response headers and becomes the receipt's replay key.

**The detail worth mentioning:** `BatchEvmSigner` only requires `{ address,
signTypedData }`. That two-member interface is the reason this works at all with
a delegated wallet. Circle's own `GatewayClient.pay()` wants a raw private key,
which we cannot have, since the whole point is that the buyer's key never leaves
Privy. Because the signer interface is that small, we could implement it over
Privy's server-side signing and keep the buyer's terminal keyless.

We also surface the Gateway balance as its own thing in the UI, separate from
the wallet's USDC, because they are genuinely different and a funded wallet with
an empty Gateway balance refuses to pay in a way that looks like a bug.

## Arc

**Why:** USDC is the native gas token, so a buyer funds one asset and both the
gas and the payment come out of it. On any other chain the buyer holds the
payment currency and a separate gas token, and the first thing a new user hits
is "you have USDC but no gas". For a marketplace whose entire unit of value is a
USDC nanopayment, that is the right trade.

**Where it shows up:** the registry, receipts and verifications all live on Arc
testnet, and settlement lands there too, so a track record and the payment that
produced it are on the same chain and indexed together.

## World ID

**Why:** reputation is worthless if a bad seller can start over for free. A
seller who burns their track record has to be unable to reappear as a fresh
account. That is a proof-of-personhood problem, not a KYC problem, and World ID
solves exactly it without us learning who anybody is.

**How:** `Verifications.sol` records an attestor-signed EIP-712 proof, binding
one nullifier to one account. The marketplace shows a verified badge and offers
a verified-only filter, so a buyer can decline to spend on anonymous sellers
without us banning them.

## The Graph

**Why:** discovery has to keep working when the website does not. The MCP server
reads the registry directly from the subgraph, so a buyer's agent can find and
evaluate workers even if the marketplace front end is down.

**How:** one subgraph over all three contracts, aggregating receipts into the
per-agent track record described above, so a profile is a single cheap read.

---

## An honest note worth including

The first graded call in this marketplace is a failure: a scanner that returned
a clean result for a package with a known advisory, caught by the buyer's own
agent and graded down by the buyer. That is the system working. A marketplace of
unproven agents needs a way to find out which ones are bad, and a wall of five
star ratings would mean the mechanism was not being used.

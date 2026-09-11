# Deploying Verifications

Everything below is already written and tested. What remains is a key, a deploy,
four environment variables and a subgraph redeploy. Until you do this, World ID
verification still works exactly as before: local to the browser, invisible to
buyers. Nothing breaks in the meantime.

## 1. Generate the attestor key

This is a plain Ethereum key. It never holds funds and never sends a
transaction. Its only job is to sign the statement "our server checked this
World proof for this account", which the user then submits themselves.

```
cast wallet new
```

Keep both halves. The private key goes in the web app's environment; the address
goes into the contract at deploy time. They must match, or every `attest()`
reverts with `BadSignature`.

## 2. Deploy the contract

From `contracts/`:

```
ATTESTOR_ADDRESS=0x...            # the address from step 1
PRIVATE_KEY=0x...                 # your usual deployer
forge script script/DeployVerifications.s.sol:DeployVerifications \
  --rpc-url $ARC_RPC_URL --broadcast
```

It prints the contract address and echoes the attestor back so you can check it
against step 1 before going further. Note the block number it deployed in.

Run the tests first if you want them:

```
forge test --match-path test/Verifications.t.sol -vv
```

## 3. Environment variables

Local `.env.local` and Vercel both need:

| Variable | Value | Notes |
| --- | --- | --- |
| `ATTESTOR_PRIVATE_KEY` | private key from step 1 | Server-only. Not `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_VERIFICATIONS_ADDRESS` | contract from step 2 | |
| `NEXT_PUBLIC_ARC_CHAIN_ID` | `5042002` | Optional; this is the default. |

`NEXT_PUBLIC_*` are inlined at build time, so adding them on Vercel requires a
redeploy, not just a save.

Check the wiring without touching the chain:

```
cd web && npm run test:attestation
```

That rebuilds the digest the way `Verifications.sol` does and recovers the
signer from it. If it passes, the contract will accept what the server signs.

## 4. Subgraph

`subgraph.yaml` already has the datasource, with placeholders:

```yaml
  - kind: ethereum
    name: Verifications
    source:
      address: "0x0000000000000000000000000000000000000000"  # <- step 2
      startBlock: 0                                          # <- deploy block
```

Fill both in, then:

```
cd subgraph && npm run codegen && npm run build && npm run deploy
```

Until this is deployed the badge query 400s and `fetchVerified` returns an empty
map, so everyone renders as unverified. That is deliberate — an unanswered
question should not look like a verified answer.

## 5. What to check afterwards

- A fresh account can sign in, name itself, browse the marketplace and set spend
  limits without being asked for anything.
- "List new worker" opens the World check instead of the listing form.
- Completing it produces two things: a World proof, then an Arc transaction. The
  second one is the new part.
- The badge appears on your own profile, and on your listings as seen from
  another account.
- Verifying a second wallet with the same World ID fails with "This World ID has
  already verified a different wallet."

## What this does and does not prove

Arc has no World ID router, so the Semaphore proof is not verified on-chain.
What the contract checks is that our relying-party server signed off — and that
server did verify the proof against World's Developer Portal, bound to our
action and to that exact wallet. A buyer is trusting World for the personhood
and us for the relay.

What it is not is self-asserted. Nobody can write their own badge, which is what
the localStorage version amounted to. And two things the chain now enforces that
the server could not: one nullifier maps to one account permanently (the old
in-memory guard forgot everything on a serverless cold start), and an
attestation names its account, so a signature handed to someone else is useless
to them.

If you want to remove the trusted relay later, the path is a World ID router
deployment on Arc, or verifying the Semaphore proof directly. That is the
rigorous version and it is deliberately not what this is.

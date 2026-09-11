# Hosted workers: listing without writing code

## The problem this solves

Listing a worker used to take four developer tasks: write an HTTP server, add
Circle's Gateway middleware, get a Circle API key, and put it on a public URL.
The README's answer to the last one was `npx cloudflared tunnel`, which stops
existing when the laptop closes. Anyone who could do all four did not need a
marketplace to find buyers.

A hosted worker inverts that. The seller brings the one thing only they have —
a webhook from whatever they already built — and Sovereign supplies the rest.

```
their tool (n8n / Dify / Flowise / Agent Builder / Zapier / anything)
        ▲
        │ POST {"input": …}  + their API key, if any
        │
  https://sovereign-marketplace.vercel.app/w/<slug>     ← goes on-chain
        ▲
        │ x402: 402 → sign → verify → settle → call → return
        │
  buyer's agent (sovereign-mcp, or any x402 client)
```

Our x402 code, our hosting, our Circle account. Their work, their money, their
payout address.

## What the seller does

1. **Workers → List new worker.** Name, description, tags, price.
2. Leave **Sovereign hosts it** selected (the default).
3. Paste the webhook URL from their tool. Add an API key header if it needs one.
4. **Create my endpoint** — one wallet signature, no gas. They get back an https
   URL that already speaks x402.
5. The existing endpoint check runs against that URL and passes: live, 402,
   right payee, right price.
6. **List worker** — the usual on-chain `register()`.

About two minutes, and nothing they have to keep running.

The second option, "I already have an x402 endpoint", is the old path unchanged.

## What it is not

It does not run models and it does not hold anyone's LLM key. A hosted worker is
a payment wall in front of a URL the seller already owns; the intelligence stays
in their tool, and so does that bill. `WorkerMode` in `lib/hosted.ts` has one
value today (`proxy`) and the route dispatches on it, so a mode where the agent
itself lives here is a branch rather than a new endpoint.

## Configuration

| Variable | Needed for | Notes |
| --- | --- | --- |
| `CIRCLE_API_KEY` | every hosted worker | Ours, not the seller's. Without it Gateway quotes no payment terms and `/w/<slug>` answers 503 saying exactly that. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | durable worker configs | Without them configs live in a per-instance Map and vanish on the next cold start. The create form warns before anyone registers such an endpoint on-chain. |
| `WORKER_SECRET_KEY` | upstream API keys | 32 bytes of hex, or any passphrase (hashed to 32). Saving a secret without it is refused rather than stored in the clear. |
| `NEXT_PUBLIC_SITE_URL` | the hosted URL | Must match the deployment, since this string goes on-chain. |
| `ALLOW_PRIVATE_PROBE` | local dev only | Turns off the SSRF guard so a worker on localhost can be reached. Never set on a deployment. |

```
# a WORKER_SECRET_KEY
openssl rand -hex 32
```

## Security notes

**The upstream secret.** Sealed with AES-256-GCM before storage and only ever
sent to the seller's own URL. It is never returned to any browser, including the
seller's — after saving, the field shows nothing rather than showing a value we
could be lying about. Reading the database is not enough to use it; the key
lives elsewhere.

**SSRF.** Two routes now fetch a URL a stranger supplied. The guard in
`lib/ssrf.ts` refuses private space, loopback, CGNAT, multicast, IPv4-mapped
IPv6 (the classic bypass), `.local` / `.internal` / `localhost`, and anything
that is not https. It runs at save time *and again on every paid call*, because
DNS is mutable: a host that resolved publicly on Tuesday can point at
`169.254.169.254` on Wednesday, and we are the one making the request.
Redirects are refused outright, since a redirect walks us off a vetted host.

**Who may create a worker.** Every write is authorised by an EIP-191 signature
from the seller's wallet, and the signed message covers the slug *and the
upstream URL* — not just the account. A captured signature cannot be replayed to
repoint someone else's worker at a different host. Signatures expire in five
minutes.

**Slugs are claimed permanently.** Retiring a worker empties its config but does
not free the name, because a listing on-chain may still point at that URL and
someone else taking it over would inherit paid traffic.

## How a failed call is handled

Circle's `gateway.require(price)` runs **verify → settle → handler**. Payment is
captured before the work is attempted, so a worker that times out or 500s would
leave the buyer charged with nothing to show — the same "I paid and got nothing"
failure the marketplace already had once, arriving this time from the payment
library rather than from our own code.

That is fixed rather than reported. `onBeforeSettle` runs after verify and
before `facilitator.settle`, and returning `{ abort: true }` from it stops
settlement. So the upstream call happens in that hook:

```
verify  →  call the worker  →  settle only if it answered
```

A worker that fails now costs the buyer nothing, and the test suite asserts that
settlement is never even attempted.

Two consequences worth knowing:

**The risk moved to the seller.** Between verify and settle the authorization
can expire, so a worker slower than Gateway's validity window does real work it
cannot be paid for. That is why the per-worker timeout is capped at
`MAX_WORK_SECONDS` (two thirds of the window) rather than trusted, and it is the
right way round: the seller chose that upstream, the buyer did not.

**Failure still has to be legible.** Circle's own `GatewayClient` — which this
marketplace's buyers use, `sovereign-mcp` included — does
`throw new Error('Request failed with status ' + s)` for any non-2xx and never
reads the body. So a 502 would reach a buyer's agent as four digits: no reason,
no way to tell "this worker is broken" from "the network hiccuped", and no way
to know whether money moved. An agent that treats a throw as *payment
unavailable* will then offer the human a manual payment intent — inviting them
to pay twice for a call that may already have settled.

So `/w/<slug>` answers **200** with a namespaced envelope:

```json
{
  "sovereign": {
    "delivered": false,
    "paid": false,
    "reason": "upstream returned HTTP 500",
    "upstreamStatus": 500,
    "latencyMs": 812
  }
}
```

`paid` is the field that matters. `false` is the normal case now: try another
worker, nothing to refund, no receipt owed. `true` should not occur on a hosted
worker and is kept because a seller's own x402 endpoint may still settle first,
and because a guarantee you have stopped checking is not a guarantee — when it
does appear it carries the settlement reference to file a not-delivered receipt
against.

A delivered response is the seller's own payload, passed through untouched, and
never carries a `sovereign` key. `undelivered(data)` in `lib/hosted.ts` tells
them apart; `sovereign-mcp` calls it on every paid response and reports the two
cases differently — "you were not charged, try another worker" versus "you were
charged and got nothing, here is the receipt link, do not pay again".

## Test bench

"Teach and train it" is what people ask for. Fine-tuning weights is the wrong
tool at five cents a call; what makes a worker good is a sharp prompt, the right
documents, a few worked examples — all of which live in the seller's own tool —
and a way to tell whether the last edit helped, which is this.

A seller writes two or three inputs with what a good answer looks like, runs
them, and grades the output on **the same met / partially met / not met scale
buyers use on-chain**. A private rehearsal of the public judgement. Runs skip
the payment wall (it is their own worker, and they signed for it) but not the
upstream, so their tool bills them as usual.

## Tests

```
cd web
npm run test:ssrf      # 34 assertions, no server needed
npm run build
npm run test:hosted    # 24 assertions, end to end
```

`test:hosted` stubs only Circle's hosted API and the seller's tool. The Next
route, the Gateway middleware, the buyer's EIP-712 signing, the signature auth
and the secret sealing are all real. It proves, among other things, that an
unpaid call never reaches the upstream, that verify runs before settle exactly
once, that the seller's secret is attached to the upstream call but never
returned to a client, that a post-settlement failure reaches the buyer as data
rather than an exception, and that a retired worker refuses **before** taking
money.

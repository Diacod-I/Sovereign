// web/app/w/[slug]/route.ts
//
// A Sovereign-hosted worker endpoint.
//
// This is the whole answer to "how does someone who does not write code list a
// worker". Before it, a seller had to build an Express server, add Circle's
// Gateway middleware, get a Circle API key, and expose a public URL — the
// README's suggestion was a cloudflared tunnel, which dies when the laptop
// closes. Four developer tasks standing between a person and a listing.
//
// Here they paste a webhook URL from whatever no-code tool they already use and
// we put the payment wall in front of it. The x402 code is ours, the hosting is
// ours, the Circle account is ours; what stays theirs is the work and the money.

import { NextRequest } from 'next/server';
import { getWorker, unseal } from '../../lib/hosted.server';
import { assertFetchableUrl } from '../../lib/ssrf';
import { gate, withPaymentHeaders, MAX_WORK_SECONDS } from '../../lib/x402-next';
import { DEFAULT_TIMEOUT_SECONDS, type UndeliveredBody } from '../../lib/hosted';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The Arc tx Gateway reported, if settlement happened at all. */
function decodeSettlement(headers: Record<string, string>): string | undefined {
  const raw = headers['payment-response'];
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).transaction || undefined;
  } catch {
    return undefined;
  }
}

const json = (body: unknown, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ? Object.fromEntries(new Headers(headers)) : {}) },
  });

/**
 * Said once, in both places, because the honest version of this is longer than
 * "not found": the listing that sent you here still exists on-chain and always
 * will, and it is the service behind it that has stopped existing.
 */
const MISSING =
  'No such worker. This endpoint was listed on Sovereign but its configuration is gone, ' +
  'so nothing can answer here. Nothing was charged. The owner can restore it by saving the ' +
  'worker again in Sovereign, or retire the listing.';

/**
 * A description of the worker, unpaid.
 *
 * Not part of x402 — it exists because a human who pastes the URL into a browser
 * should see something other than "Method Not Allowed", and because it gives the
 * listing probe a cheap liveness signal that costs nobody a payment.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const worker = await getWorker(slug);
  if (!worker) return json({ error: MISSING }, 404);
  return json({
    ok: true,
    slug: worker.slug,
    price: worker.price,
    payTo: worker.payTo,
    method: 'POST',
    note: 'POST here with {"input": ...}. Unpaid requests are answered with 402 and the payment terms to sign.',
  }, 200);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const worker = await getWorker(slug);
  // Before the payment wall, so a listing whose worker is gone costs a buyer
  // nothing. The registry entry pointing here is on-chain and permanent; this
  // record is not, which is the whole reason this branch has to be free.
  if (!worker) return json({ error: MISSING }, 404);

  // Refused before the payment wall, not after it. A retired worker still has a
  // live on-chain listing pointing here, and the middleware settles before it
  // runs anything — so checking this later would charge a buyer for a worker we
  // already knew could not answer.
  if (!worker.upstreamUrl) {
    return json({ error: 'This worker has been retired by its owner and is not taking work.' }, 410);
  }

  // Read the body once, before the payment wall. The buyer's input has to
  // survive into the upstream call, and the Request body can only be consumed
  // once — reading it after the middleware has run would come back empty.
  let inputBody: string;
  try {
    inputBody = await request.text();
    if (inputBody.length > MAX_REQUEST_BYTES) {
      return json({ error: `Request body over ${MAX_REQUEST_BYTES} bytes.` }, 413);
    }
  } catch {
    return json({ error: 'Could not read the request body.' }, 400);
  }

  let upstreamStatus = 0;
  let upstreamBody = '';
  let upstreamType = 'application/json';
  let startedAt = 0;
  let latencyMs = 0;

  const result = await gate(
    request,
    { payTo: worker.payTo, price: worker.price, description: `Sovereign worker ${worker.slug}` },
    async () => {
      // Re-checked at call time, not just at save time. DNS is mutable: a host
      // that resolved publicly when the worker was created can be repointed at
      // 169.254.169.254 afterwards, and we are the ones making the request.
      const url = await assertFetchableUrl(worker.upstreamUrl);

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Named so an upstream can tell a paid marketplace call from its own
        // testing, and so a seller can log what came from us.
        'user-agent': 'Sovereign-Worker-Proxy/1',
        'x-sovereign-worker': worker.slug,
      };
      if (worker.authHeaderName && worker.authSecretSealed) {
        headers[worker.authHeaderName] = unseal(worker.authSecretSealed);
      }

      // The work now runs between verify and settle, inside the payment
      // authorization's validity window. A worker slower than that window does
      // real work that can never be settled, so the seller's own timeout is
      // capped rather than trusted.
      const timeout = Math.min(worker.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS, MAX_WORK_SECONDS) * 1000;
      startedAt = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: inputBody || '{}',
        signal: AbortSignal.timeout(timeout),
        redirect: 'error', // a redirect could walk us off a vetted host
        cache: 'no-store',
      });
      latencyMs = Date.now() - startedAt;

      upstreamStatus = res.status;
      upstreamType = res.headers.get('content-type') || 'application/json';
      const text = await res.text();
      upstreamBody = text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;

      // A non-2xx upstream is a failed delivery, not a proxy success. Throwing
      // here aborts settlement, so the buyer is never charged for it.
      //
      // The body comes with it, trimmed. A bare status code tells a buyer
      // nothing they can act on and tells the SELLER nothing at all -- they get
      // "HTTP 500" from a workflow that knows exactly what went wrong and said
      // so in its response. This is the seller's own error text, which they
      // control, travelling to the person who just tried to buy from them.
      if (!res.ok) {
        const excerpt = upstreamBody.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error(
          `upstream returned HTTP ${res.status}` + (excerpt ? `: ${excerpt}` : ''),
        );
      }
    },
  );

  if (result.kind === 'refused') return result.response;

  if (result.kind === 'work-unpaid') {
    // The worker answered but settlement did not go through, so nobody was
    // charged and the seller ate the upstream cost. Passed through as the
    // middleware wrote it: there is no payment to report and nothing to grade.
    return result.response;
  }

  if (result.kind === 'not-charged') {
    // The ordinary failure: the worker was called between verify and settle,
    // it did not answer usefully, and settlement was aborted. Nobody paid.
    //
    // Answered 200 with an envelope rather than 502 because Circle's
    // GatewayClient — which this marketplace's buyers use, sovereign-mcp
    // included — does `throw new Error('Request failed with status ' + s)` for
    // any non-2xx and never reads the body. A 502 would reach a buyer's agent as
    // four digits, and an agent that cannot tell "this worker is broken" from
    // "the network hiccuped" retries a broken worker forever. Worse, an agent
    // that treats a throw as "payment unavailable" may prompt the human to pay
    // again for a call that already settled.
    //
    // `delivered: false` is explicit, and `paid` says whether money moved. It is
    // namespaced under `sovereign` so it cannot be confused with a seller's own
    // output, which is passed through untouched on success.
    // Defence in depth rather than a live branch: with settlement aborted there
    // should be no settlement reference at all. If one somehow exists, money
    // moved and saying otherwise would be the exact lie this envelope exists to
    // prevent — so it is reported, with the reference to file a receipt against.
    const settlement = decodeSettlement(result.headers);
    const charged = !!settlement;
    const detail =
      result.error instanceof Error ? result.error.message : 'the worker did not return a usable response';
    const body: UndeliveredBody = {
      delivered: false,
      paid: charged,
      settlement,
      reason: detail,
      upstreamStatus: upstreamStatus || undefined,
      latencyMs: latencyMs || undefined,
    };
    const headers = withPaymentHeaders({ 'content-type': 'application/json' }, result.headers);
    headers.set('x-sovereign-delivered', 'false');
    headers.set('x-sovereign-paid', charged ? 'true' : 'false');
    if (settlement) headers.set('x-sovereign-settlement', settlement);
    return new Response(JSON.stringify({ sovereign: body }), { status: 200, headers });
  }

  // Paid and delivered. The upstream's own payload is passed through untouched
  // so a buyer's agent sees exactly what the seller's tool produced, with the
  // settlement reference alongside for the receipt.
  const headers = withPaymentHeaders({ 'content-type': upstreamType }, result.headers);
  headers.set('x-sovereign-latency-ms', String(latencyMs));
  if (result.settlement) headers.set('x-sovereign-settlement', result.settlement);
  return new Response(upstreamBody || '{}', { status: upstreamStatus || 200, headers });
}

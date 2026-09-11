// POST /api/probe-endpoint — verify a worker endpoint before it is listed on-chain.
//
// The probe asserts four things in one unpaid request, which together catch every
// way a listing is silently broken: the URL is live, it speaks x402, it quotes the
// same payee the seller is registering, and it quotes the same price.
//
// This runs server-side because it must (a) escape browser CORS and (b) refuse to
// fetch private address space. A route that fetches user-supplied URLs from inside
// our own infrastructure is an SSRF primitive unless it is guarded — the classic
// target being cloud metadata at 169.254.169.254.

import { parseUnits } from 'viem';
import type { ProbeCheck, ProbeQuote, ProbeResult } from '../../lib/probe';
// The guard moved to lib/ssrf so the hosted worker proxy uses the same one. Two
// copies of an SSRF check is one copy that quietly falls behind.
import { ALLOW_PRIVATE, assertPublicHost } from '../../lib/ssrf';
import { SITE_URL } from '../../lib/hosted';
import { getWorker } from '../../lib/hosted.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;

// ---------------------------------------------------------------- helpers

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * x402 requirements arrive one of two ways: Circle Gateway base64-encodes
 * `{ accepts: [...] }` into a PAYMENT-REQUIRED header and returns an empty body;
 * other implementations put `accepts` in the JSON body. Accept both.
 */
function extractAccepts(headerValue: string | null, body: unknown): ProbeQuote[] {
  if (headerValue) {
    try {
      const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
      if (Array.isArray(decoded?.accepts) && decoded.accepts.length) return decoded.accepts;
    } catch {}
  }
  const b = body as { accepts?: ProbeQuote[]; paymentRequirements?: ProbeQuote[] } | null;
  if (Array.isArray(b?.accepts) && b.accepts.length) return b.accepts;
  if (Array.isArray(b?.paymentRequirements) && b.paymentRequirements.length) return b.paymentRequirements;
  return [];
}

async function readCapped(res: Response): Promise<{ text: string; json: unknown }> {
  const raw = await res.text();
  const text = raw.length > MAX_BODY ? raw.slice(0, MAX_BODY) : raw;
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  return { text, json };
}

// ---------------------------------------------------------------- route

export async function POST(request: Request) {
  const started = Date.now();
  const checks: ProbeCheck[] = [];
  let quote: ProbeQuote | null = null;

  const add = (id: string, label: string, status: ProbeCheck['status'], detail: string) =>
    checks.push({ id, label, status, detail });

  const finish = (endpoint: string): Response => {
    const ok = !checks.some((c) => c.status === 'fail');
    const result: ProbeResult = { ok, endpoint, checks, quote, elapsedMs: Date.now() - started };
    return Response.json(result);
  };

  let body: { endpoint?: string; payTo?: string; price?: string; owner?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: 'Invalid JSON.' }, { status: 400 });
  }

  const endpoint = (body.endpoint || '').trim();
  if (!endpoint) return Response.json({ detail: 'An endpoint URL is required.' }, { status: 400 });

  // --- 1. URL shape -----------------------------------------------------
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    add('url', 'Valid URL', 'fail', `“${endpoint}” is not a URL.`);
    return finish(endpoint);
  }
  if (url.protocol !== 'https:' && !(ALLOW_PRIVATE && url.protocol === 'http:')) {
    add('url', 'Valid URL', 'fail', `Endpoint must use https:// (got ${url.protocol}//). Buyers will not send payment authorizations over plaintext.`);
    return finish(endpoint);
  }
  add('url', 'Valid URL', 'pass', `${url.protocol}//${url.host}${url.pathname}`);

  // --- 2. public address space -----------------------------------------
  if (ALLOW_PRIVATE) {
    add('reachable', 'Publicly reachable', 'warn', 'Private-address check skipped (ALLOW_PRIVATE_PROBE is on — development only).');
  } else {
    try {
      const ip = await assertPublicHost(url.hostname);
      add('reachable', 'Publicly reachable', 'pass', `${url.hostname} → ${ip}`);
    } catch (e) {
      add('reachable', 'Publicly reachable', 'fail', `${e instanceof Error ? e.message : 'host check failed'}. Buyers on the open internet could not reach this.`);
      return finish(endpoint);
    }
  }

  // --- 3. unpaid call must be refused with 402 --------------------------
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Sovereign-EndpointProbe/1.0' },
      body: JSON.stringify({ input: { __sovereign_probe: true } }),
      redirect: 'manual', // a redirect could hop into private space
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'request failed';
    add('responds', 'Endpoint responds', 'fail',
      /timeout|abort/i.test(msg) ? `No response within ${TIMEOUT_MS / 1000}s.` : `Could not connect: ${msg}`);
    return finish(endpoint);
  }

  if (res.status >= 300 && res.status < 400) {
    add('responds', 'Endpoint responds', 'fail', `Endpoint redirects (HTTP ${res.status}). Register the final URL directly.`);
    return finish(endpoint);
  }
  add('responds', 'Endpoint responds', 'pass', `HTTP ${res.status} in ${Date.now() - started}ms`);

  const { text, json } = await readCapped(res);

  if (res.status !== 402) {
    add('paywalled', 'Requires payment (402)', 'fail',
      res.status === 200
        ? 'Endpoint served a result without payment. It is not x402-gated, so buyers would consume it for free.'
        : `Expected HTTP 402, got ${res.status}. ${text.slice(0, 160)}`);
    return finish(endpoint);
  }
  add('paywalled', 'Requires payment (402)', 'pass', 'Unpaid request was correctly refused.');

  // --- 4. the 402 must be signable --------------------------------------
  const accepts = extractAccepts(res.headers.get('payment-required'), json);
  if (!accepts.length) {
    add('quote', 'Quotes payment terms', 'fail', 'The 402 carried no payment requirements, so a buyer has nothing to sign. Expected a base64 PAYMENT-REQUIRED header or an `accepts` array.');
    return finish(endpoint);
  }
  quote = accepts[0];
  add('quote', 'Quotes payment terms', 'pass',
    `${accepts.length} option(s); using ${quote.scheme ?? '?'} on ${quote.network ?? '?'}`);

  // --- 5. quoted payee must match the listing ---------------------------
  if (body.payTo) {
    if (!quote.payTo) {
      add('payTo', 'Payee matches listing', 'fail', 'The quote names no payTo address.');
    } else if (eq(quote.payTo, body.payTo)) {
      add('payTo', 'Payee matches listing', 'pass', quote.payTo);
    } else {
      add('payTo', 'Payee matches listing', 'fail',
        `Endpoint pays ${quote.payTo}, but this listing registers ${body.payTo}. Buyers would pay the wrong address and your earnings would not appear.`);
    }
  } else {
    add('payTo', 'Payee matches listing', 'skip', 'No payout address supplied.');
  }

  // --- 6. quoted price must match the listing ---------------------------
  if (body.price) {
    let expected: bigint | null = null;
    try { expected = parseUnits(body.price, 6); } catch {}
    if (expected === null) {
      add('price', 'Price matches listing', 'warn', `“${body.price}” is not a valid USDC amount.`);
    } else if (!quote.amount) {
      add('price', 'Price matches listing', 'fail', 'The quote names no amount.');
    } else {
      let actual: bigint | null = null;
      try { actual = BigInt(quote.amount); } catch {}
      if (actual === null) {
        add('price', 'Price matches listing', 'fail', `Quoted amount “${quote.amount}” is not an integer.`);
      } else if (actual === expected) {
        add('price', 'Price matches listing', 'pass', `${body.price} USDC (${actual} atomic)`);
      } else {
        add('price', 'Price matches listing', 'fail',
          `Endpoint charges ${Number(actual) / 1e6} USDC but the listing says ${body.price} USDC. Buyers sign the endpoint's amount, so the marketplace price would be a lie.`);
      }
    }
  } else {
    add('price', 'Price matches listing', 'skip', 'No price supplied.');
  }

  // --- 7. optional ownership proof --------------------------------------
  // Without this, anyone can list somebody else's API under their own payTo and
  // resell it. Advisory for now so existing sellers are not locked out.
  //
  // A Sovereign-hosted endpoint is the exception, and asking it for a
  // .well-known file is incoherent: the origin is OURS, so the seller could
  // never serve one and every hosted worker would warn forever. We already know
  // who owns it, because creating it required a signature from that wallet, and
  // checking our own store is a stronger proof than a file anyone who controls
  // the domain could write.
  const hostedPrefix = `${SITE_URL}/w/`;
  if (body.owner && endpoint.startsWith(hostedPrefix)) {
    const slug = endpoint.slice(hostedPrefix.length).split(/[/?#]/)[0];
    const worker = slug ? await getWorker(slug) : null;
    if (!worker) {
      add('ownership', 'Proves endpoint ownership', 'fail',
        'This looks like a Sovereign-hosted endpoint but no such worker exists.');
    } else if (worker.owner.toLowerCase() === body.owner.toLowerCase()) {
      add('ownership', 'Proves endpoint ownership', 'pass',
        'Sovereign hosts this endpoint and it was created by this wallet.');
    } else {
      // Someone trying to list another seller's hosted endpoint under their own
      // payout address. The well-known check could never have caught this.
      add('ownership', 'Proves endpoint ownership', 'fail',
        'This hosted endpoint belongs to a different wallet.');
    }
  } else if (body.owner) {
    try {
      const wk = new URL('/.well-known/sovereign-challenge', url.origin);
      const r = await fetch(wk, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'user-agent': 'Sovereign-EndpointProbe/1.0' },
      });
      if (!r.ok) {
        add('ownership', 'Proves endpoint ownership', 'warn',
          `No /.well-known/sovereign-challenge (HTTP ${r.status}). Serve your wallet address there to prove this endpoint is yours.`);
      } else {
        const proof = (await r.text()).slice(0, 2048).toLowerCase();
        if (proof.includes(body.owner.toLowerCase())) {
          add('ownership', 'Proves endpoint ownership', 'pass', 'Challenge names this wallet.');
        } else {
          add('ownership', 'Proves endpoint ownership', 'fail',
            'The challenge file exists but names a different wallet — this endpoint belongs to someone else.');
        }
      }
    } catch {
      add('ownership', 'Proves endpoint ownership', 'warn', 'Could not read /.well-known/sovereign-challenge.');
    }
  } else {
    add('ownership', 'Proves endpoint ownership', 'skip', 'No wallet supplied.');
  }

  return finish(endpoint);
}

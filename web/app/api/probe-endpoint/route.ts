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

import dns from 'node:dns/promises';
import net from 'node:net';
import { parseUnits } from 'viem';
import type { ProbeCheck, ProbeQuote, ProbeResult } from '../../lib/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;

// Local development needs to probe a worker on localhost; production must never.
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_PROBE === 'true';

// ---------------------------------------------------------------- SSRF guard

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;              // this-network, private, loopback
  if (a === 169 && b === 254) return true;                        // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;               // private
  if (a === 192 && b === 168) return true;                        // private
  if (a === 192 && b === 0) return true;                          // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking
  if (a >= 224) return true;                                      // multicast + reserved
  return false;
}

function ipIsPrivate(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4IsPrivate(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped (::ffff:10.0.0.1) inherits the v4 rules.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4IsPrivate(mapped[1]);
    if (/^f[cd]/.test(lower)) return true;                        // unique local
    if (/^fe[89ab]/.test(lower)) return true;                     // link local
    return false;
  }
  return true;
}

/** Resolves the host and rejects if ANY answer lands in private space. */
async function assertPublicHost(hostname: string): Promise<string> {
  if (net.isIP(hostname)) {
    if (ipIsPrivate(hostname)) throw new Error(`${hostname} is a private address`);
    return hostname;
  }
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error(`${hostname} resolves to this machine`);
  }
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS lookup failed for ${hostname}`);
  }
  if (!answers.length) throw new Error(`${hostname} does not resolve`);
  // Check every answer — a host with one public and one private record is an attack.
  for (const a of answers) {
    if (ipIsPrivate(a.address)) throw new Error(`${hostname} resolves to private address ${a.address}`);
  }
  return answers[0].address;
}

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
  if (body.owner) {
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

// app/lib/x402-next.ts
// Running Circle's Express-shaped Gateway middleware inside a Next route handler,
// and reordering it so a buyer is not charged for work that never happened.
//
// THE ORDERING PROBLEM
//
// `gateway.require(price)` runs verify → settle → handler. Payment is captured
// before the work is attempted, so a worker that times out or 500s leaves the
// buyer charged with nothing to show. That is the same "I paid and got nothing"
// failure the marketplace already had once, arriving this time from the
// payment library rather than from our own code.
//
// It is fixable without forking the library. `onBeforeSettle` runs after verify
// and before `facilitator.settle`, and returning `{ abort: true }` from it stops
// settlement entirely. So the work goes in that hook:
//
//     verify  →  call the worker  →  settle only if it answered
//
// A worker that fails now costs the buyer nothing. What it costs instead is the
// seller's own upstream bill for a call that will not be paid for — which is the
// right way round, because the seller chose that upstream and the buyer did not.
//
// The residual risk moves with it: between verify and settle the authorization
// could expire, so a slow worker can do real work and not get paid. That window
// is why the per-worker timeout exists and why it is capped below.
//
// The 402 body itself still comes from `require()`. It is the only thing that
// builds the exact `accepts` array Circle's own clients will sign, and guessing
// at a wire format we do not control is how a marketplace ends up unpayable.

import {
  createGatewayMiddleware,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
} from '@circle-fin/x402-batching/server';

export const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002);
export const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}`; // CAIP-2, what Gateway expects
export const FACILITATOR_URL =
  process.env.CIRCLE_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com';
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || '';

export const facilitatorConfigured = !!CIRCLE_API_KEY;

/**
 * The longest a worker may take and still be settleable.
 *
 * The work now happens inside the payment authorization's validity window, so a
 * worker slower than the window does the work and cannot be paid for it. Two
 * thirds leaves room for the verify and settle round trips either side.
 */
export const MAX_WORK_SECONDS = Math.max(
  5,
  Math.floor((Number(GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS) || 120) * 0.66),
);

type Captured = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
};

export type GateResult =
  /** The middleware answered on its own — 402 with the quote, 400, 503. */
  | { kind: 'refused'; response: Response }
  /** Verified, worked, settled. `settlement` is the Arc tx. */
  | { kind: 'paid'; settlement?: string; payer?: string; headers: Record<string, string> }
  /** The work failed, so settlement was aborted. The buyer keeps their money. */
  | { kind: 'not-charged'; error: unknown; headers: Record<string, string> }
  /** The work succeeded but settlement did not. The seller ate the call. */
  | { kind: 'work-unpaid'; response: Response };

function decodePaymentResponse(headers: Record<string, string>): { transaction?: string; payer?: string } {
  const raw = headers['payment-response'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return { transaction: parsed.transaction, payer: parsed.payer };
  } catch {
    return {};
  }
}

export async function gate(
  request: Request,
  opts: { payTo: string; price: string; description?: string },
  work: () => Promise<void>,
): Promise<GateResult> {
  const gateway = createGatewayMiddleware({
    sellerAddress: opts.payTo,
    networks: [ARC_NETWORK],
    facilitatorUrl: FACILITATOR_URL,
    description: opts.description ?? 'Sovereign hosted worker',
    ...(CIRCLE_API_KEY ? { headers: { Authorization: `Bearer ${CIRCLE_API_KEY}` } } : {}),
  });

  let workRan = false;
  let workError: unknown = null;

  // The reorder. A hook that throws is swallowed by the library and settlement
  // proceeds anyway — which would charge for a failed call — so this one catches
  // everything and turns it into an explicit abort.
  gateway.onBeforeSettle(async () => {
    workRan = true;
    try {
      await work();
      return undefined; // settle
    } catch (e) {
      workError = e;
      return {
        abort: true as const,
        reason: 'worker_failed',
        message: e instanceof Error ? e.message : 'the worker did not return a usable response',
      };
    }
  });

  const captured: Captured = { statusCode: 200, headers: {}, body: '', ended: false };

  // Lowercased because Node's IncomingMessage lowercases them and the middleware
  // reads `req.headers['payment-signature']` exactly. A client sending
  // `Payment-Signature` would otherwise look unpaid and be quoted twice.
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  const req = {
    url: new URL(request.url).pathname,
    method: request.method,
    headers,
  } as unknown as Parameters<ReturnType<typeof gateway.require>>[0];

  const res = {
    get statusCode() { return captured.statusCode; },
    set statusCode(v: number) { captured.statusCode = v; },
    setHeader(name: string, value: string) { captured.headers[String(name).toLowerCase()] = String(value); },
    getHeader(name: string) { return captured.headers[String(name).toLowerCase()]; },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) captured.body = String(chunk);
      captured.ended = true;
    },
  } as unknown as Parameters<ReturnType<typeof gateway.require>>[1];

  let settled = false;
  const next = () => { settled = true; };

  const price = opts.price.startsWith('$') ? opts.price : `$${opts.price}`;

  try {
    await gateway.require(price)(req, res, next as unknown as () => void);
  } catch {
    // The middleware funnels its own errors into a 500 branch; this is for
    // anything thrown outside that.
  }

  const { transaction, payer } = decodePaymentResponse(captured.headers);

  if (workError) {
    return { kind: 'not-charged', error: workError, headers: captured.headers };
  }
  if (settled) {
    return { kind: 'paid', settlement: transaction, payer, headers: captured.headers };
  }

  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(captured.headers)) outHeaders.set(k, v);
  if (!outHeaders.has('content-type')) outHeaders.set('content-type', 'application/json');

  if (workRan) {
    // Worked, then settlement failed or was refused. The buyer paid nothing and
    // gets nothing; the seller's upstream bill is real. Worth naming separately
    // because it is the one outcome the seller, not the buyer, is out of pocket on.
    return {
      kind: 'work-unpaid',
      response: new Response(captured.body || '{}', {
        status: captured.statusCode || 402,
        headers: outHeaders,
      }),
    };
  }

  let body = captured.body;
  if (captured.statusCode === 503 && !facilitatorConfigured) {
    // "No payment networks available" is accurate and unactionable.
    body = JSON.stringify({
      error: 'No payment networks available',
      detail: 'CIRCLE_API_KEY is not set on the server, so Gateway will not quote payment terms for this worker.',
    });
  }

  return {
    kind: 'refused',
    response: new Response(body || '{}', { status: captured.statusCode || 500, headers: outHeaders }),
  };
}

/** Merges the middleware's headers (PAYMENT-RESPONSE) onto our own response. */
export function withPaymentHeaders(init: Record<string, string>, captured: Record<string, string>): Headers {
  const h = new Headers(init);
  if (captured['payment-response']) h.set('PAYMENT-RESPONSE', captured['payment-response']);
  return h;
}

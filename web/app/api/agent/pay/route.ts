// web/app/api/agent/pay/route.ts
//
// Retired. Kept as a refusal rather than deleted, because a bearer token minted
// for this endpoint may still be sitting in somebody's .mcp.json.
//
// What it used to do: send USDC from the buyer's delegated wallet to a worker's
// payout address. What it never did: call the worker. That is the same defect
// the browser's "Hire & pay" button had -- money moved on the buyer's behalf
// and the work was left to hope. A worker whose endpoint was returning 404
// could be paid in full and deliver nothing, and both sides would believe the
// other had done its half.
//
// Payment is only safe inside the call, where the worker has to quote a price
// in a 402 before anything is signed and a worker that never answers never gets
// quoted. That is /api/agent/call.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GONE = {
  error:
    'This endpoint is retired. It transferred USDC without calling the worker, so it could ' +
    'pay in full for nothing. Use POST /api/agent/call, which pays inside the x402 exchange ' +
    'and only after the worker has quoted a price. Update with `npx sovereign-mcp@latest link --spend`.',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });

export async function POST() {
  return json(GONE, 410);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });
}

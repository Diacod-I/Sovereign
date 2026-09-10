// GET/POST /api/probe-fixture — a spec-correct 402 emitter, for testing the
// endpoint probe against a real public HTTPS URL.
//
// This is NOT a payable worker. It always answers 402 and never serves work or
// settles anything, so it can never be mistaken for a real listing. Its only job
// is to give you something concrete to verify the probe against — and, by way of
// the query params below, to reproduce each failure mode on demand.
//
//   /api/probe-fixture                        healthy 402 (0.05 USDC)
//   /api/probe-fixture?amount=250000          quotes 0.25 → price-mismatch
//   /api/probe-fixture?payTo=0x1111…          quotes another payee → payee-mismatch
//   /api/probe-fixture?mode=free              200 with no paywall
//   /api/probe-fixture?mode=noquote           402 carrying nothing signable
//   /api/probe-fixture?mode=body              402 with `accepts` in the body
//   /api/probe-fixture?mode=redirect          302
//   /api/probe-fixture?mode=slow              hangs past the probe timeout

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PAYTO = '0x5E20F2ffE4f7C1a27412D53ab5C248bfef921A75';
const DEFAULT_AMOUNT = '50000'; // 0.05 USDC at 6dp
const ARC = 'eip155:5042002';
const USDC = '0x3600000000000000000000000000000000000000';

function requirements(payTo: string, amount: string) {
  return {
    scheme: 'exact',
    network: ARC,
    asset: USDC,
    amount,
    payTo,
    maxTimeoutSeconds: 604800,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    },
  };
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') ?? 'ok';
  const payTo = url.searchParams.get('payTo') ?? DEFAULT_PAYTO;
  const amount = url.searchParams.get('amount') ?? DEFAULT_AMOUNT;

  if (mode === 'free') {
    return Response.json({ output: { ok: true, note: 'served without payment — this is the failure the probe catches' } });
  }
  if (mode === 'redirect') {
    return new Response(null, { status: 302, headers: { Location: 'https://example.com/moved' } });
  }
  if (mode === 'slow') {
    await new Promise((r) => setTimeout(r, 30_000));
    return Response.json({}, { status: 402 });
  }
  if (mode === 'noquote') {
    return Response.json({}, { status: 402 });
  }

  const accepts = [requirements(payTo, amount)];

  // The dialect other x402 servers speak: requirements inline in the body.
  if (mode === 'body') {
    return Response.json({ x402Version: 2, accepts }, { status: 402 });
  }

  // Circle Gateway's dialect: base64 PAYMENT-REQUIRED header, empty body.
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: url.pathname, description: 'Sovereign probe fixture', mimeType: 'application/json' },
      accepts,
    }),
  ).toString('base64');

  return new Response(JSON.stringify({}), {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': header, 'Content-Type': 'application/json' },
  });
}

export const GET = handle;
export const POST = handle;

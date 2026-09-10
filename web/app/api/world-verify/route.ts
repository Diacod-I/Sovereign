import type { IDKitResult, ResponseItemV3, ResponseItemV4 } from '@worldcoin/idkit';
import { hashSignal } from '@worldcoin/idkit/hashing';

export const runtime = 'nodejs';

const RP_ID = process.env.WORLD_RP_ID || process.env.NEXT_PUBLIC_WORLD_RP_ID || '';
const ACTION = process.env.WORLD_ACTION || process.env.NEXT_PUBLIC_WORLD_ACTION || 'seller-verify';

/**
 * Best-effort, per-instance Sybil guard: one human (nullifier) → one seller wallet.
 *
 * NOTE for production: on Vercel this Map lives inside a single serverless
 * instance and is lost on cold start, so it cannot actually stop a determined
 * replay across instances. Back it with a durable unique index on
 * (nullifier, action) — Vercel KV / Postgres — before relying on it.
 */
const seenNullifiers = new Map<string, string>();

type VerificationRequest = {
  idkitResponse?: IDKitResult;
  wallet?: string;
};

type ProofResponse = ResponseItemV3 | ResponseItemV4;

function isProofResponse(item: IDKitResult['responses'][number]): item is ProofResponse {
  return 'nullifier' in item && typeof item.nullifier === 'string';
}

export async function POST(request: Request) {
  if (!/^rp_/.test(RP_ID)) {
    return Response.json({ ok: false, detail: 'WORLD_RP_ID is not configured' }, { status: 503 });
  }

  let body: VerificationRequest;
  try {
    body = (await request.json()) as VerificationRequest;
  } catch {
    return Response.json({ ok: false, detail: 'Invalid JSON.' }, { status: 400 });
  }

  const wallet = body.wallet?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return Response.json({ ok: false, detail: 'A valid seller wallet address is required.' }, { status: 400 });
  }

  const result = body.idkitResponse as (IDKitResult & { action?: string }) | undefined;
  if (!result || !Array.isArray(result.responses)) {
    return Response.json({ ok: false, detail: 'No World ID proof was supplied.' }, { status: 400 });
  }

  // The proof must be bound to OUR action, otherwise a proof minted for some
  // other relying party's action would grant a Sovereign seller badge.
  if (result.action !== ACTION) {
    return Response.json(
      {
        ok: false,
        detail: `This proof is for action "${result.action ?? '(none)'}", but this app requires "${ACTION}".`,
      },
      { status: 400 },
    );
  }

  const proof = result.responses.find(isProofResponse) ?? null;
  if (!proof) {
    return Response.json(
      { ok: false, detail: 'The World response contained no verifiable credential.' },
      { status: 400 },
    );
  }

  // …and bound to THIS wallet, so a proof cannot be lifted onto another seller.
  if (proof.signal_hash !== hashSignal(wallet)) {
    return Response.json(
      { ok: false, detail: 'The World proof is not bound to this seller wallet.' },
      { status: 400 },
    );
  }

  const previousWallet = seenNullifiers.get(proof.nullifier);
  if (previousWallet && previousWallet !== wallet) {
    return Response.json(
      { ok: false, detail: 'This human already verified a different seller wallet.' },
      { status: 409 },
    );
  }

  let portalResponse: Response;
  try {
    portalResponse = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'unknown error';
    console.error('[world-verify] portal unreachable:', detail);
    return Response.json({ ok: false, detail: `Could not reach World verification (${detail}).` }, { status: 502 });
  }

  if (!portalResponse.ok) {
    const raw = await portalResponse.text();
    console.error('[world-verify] portal rejected proof:', portalResponse.status, raw);
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.detail || parsed.message || parsed.code || raw;
    } catch {}
    return Response.json(
      { ok: false, detail: detail || `World rejected this proof (HTTP ${portalResponse.status}).` },
      { status: 400 },
    );
  }

  seenNullifiers.set(proof.nullifier, wallet);
  return Response.json({
    ok: true,
    nullifierHash: proof.nullifier,
    level: proof.identifier || 'selfie',
    wallet,
  });
}

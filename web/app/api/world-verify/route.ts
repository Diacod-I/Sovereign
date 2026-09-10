import type { IDKitResult, ResponseItemV3, ResponseItemV4 } from '@worldcoin/idkit';
import { hashSignal } from '@worldcoin/idkit/hashing';

const RP_ID = process.env.WORLD_RP_ID || process.env.NEXT_PUBLIC_WORLD_RP_ID || '';
const ACTION = process.env.WORLD_ACTION || process.env.NEXT_PUBLIC_WORLD_ACTION || 'seller-verify';

// Demo-process persistence only. Replace this with a durable unique index on
// (nullifier, action) before deploying multiple server instances.
const seenNullifiers = new Map<string, string>();

type VerificationRequest = {
  idkitResponse?: IDKitResult;
  wallet?: string;
};

type ProofResponse = ResponseItemV3 | ResponseItemV4;

function isProofResponse(item: IDKitResult['responses'][number]): item is ProofResponse {
  return 'nullifier' in item && typeof item.nullifier === 'string';
}

function getProof(response: IDKitResult): ProofResponse | null {
  const result = response as IDKitResult & { action?: unknown };
  if (result.action !== ACTION) return null;
  return result.responses.find(isProofResponse) ?? null;
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
  const proof = body.idkitResponse && getProof(body.idkitResponse);
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet) || !proof) {
    return Response.json({ ok: false, detail: 'Invalid World proof or wallet binding.' }, { status: 400 });
  }
  if (proof.signal_hash !== hashSignal(wallet)) {
    return Response.json({ ok: false, detail: 'The World proof is not bound to this seller wallet.' }, { status: 400 });
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
      body: JSON.stringify(body.idkitResponse),
    });
  } catch {
    return Response.json({ ok: false, detail: 'Could not reach World verification.' }, { status: 502 });
  }

  if (!portalResponse.ok) {
    const detail = await portalResponse.text();
    return Response.json({ ok: false, detail: detail || 'World rejected this proof.' }, { status: 400 });
  }

  seenNullifiers.set(proof.nullifier, wallet);
  return Response.json({
    ok: true,
    nullifierHash: proof.nullifier,
    level: proof.identifier === 'selfie' ? 'selfie' : proof.identifier || 'selfie',
    wallet,
  });
}

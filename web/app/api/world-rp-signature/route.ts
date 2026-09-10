import { signRequest } from '@worldcoin/idkit/signing';

export const runtime = 'nodejs';

const RP_ID = process.env.WORLD_RP_ID || '';
const RP_SIGNING_KEY = process.env.WORLD_RP_SIGNING_KEY || '';
const ACTION = process.env.WORLD_ACTION || process.env.NEXT_PUBLIC_WORLD_ACTION || 'seller-verify';

export async function POST() {
  if (!/^rp_/.test(RP_ID) || !RP_SIGNING_KEY) {
    return Response.json(
      { detail: 'World ID is not configured. Add WORLD_RP_ID and WORLD_RP_SIGNING_KEY.' },
      { status: 503 },
    );
  }

  try {
    const signature = signRequest({ signingKeyHex: RP_SIGNING_KEY, action: ACTION });
    return Response.json({
      rp_id: RP_ID,
      nonce: signature.nonce,
      created_at: signature.createdAt,
      expires_at: signature.expiresAt,
      signature: signature.sig,
    });
  } catch {
    return Response.json({ detail: 'Could not sign the World ID request.' }, { status: 500 });
  }
}

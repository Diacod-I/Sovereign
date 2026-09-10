import { signRequest } from '@worldcoin/idkit/signing';

export const runtime = 'nodejs';

const RP_ID = process.env.WORLD_RP_ID || '';
const RP_SIGNING_KEY = process.env.WORLD_RP_SIGNING_KEY || '';
const ACTION = process.env.WORLD_ACTION || process.env.NEXT_PUBLIC_WORLD_ACTION || 'seller-verify';

/**
 * The RP signing key is a 32-byte secp256k1 private key issued by the World
 * Developer Portal — NOT an Ethereum address and not the app id. Pasting a
 * 20-byte address here is the single most common misconfiguration, and it used
 * to surface as an opaque 500, so it is checked explicitly and named in the
 * response the seller sees.
 */
function keyProblem(key: string): string | null {
  if (!key) return 'WORLD_RP_SIGNING_KEY is not set.';
  const hex = key.startsWith('0x') || key.startsWith('0X') ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return 'WORLD_RP_SIGNING_KEY contains non-hex characters.';
  if (hex.length === 40) {
    return 'WORLD_RP_SIGNING_KEY looks like an Ethereum address (20 bytes). It must be the 32-byte RP signing key from the World Developer Portal → your app → Relying Party → signing key.';
  }
  if (hex.length !== 64) {
    return `WORLD_RP_SIGNING_KEY must be 32 bytes (64 hex chars); got ${hex.length / 2} bytes.`;
  }
  return null;
}

export async function POST() {
  if (!/^rp_/.test(RP_ID)) {
    return Response.json(
      { detail: 'WORLD_RP_ID is not set (it starts with "rp_"). Add it to your environment.' },
      { status: 503 },
    );
  }

  const problem = keyProblem(RP_SIGNING_KEY);
  if (problem) {
    console.error('[world-rp-signature]', problem);
    return Response.json({ detail: problem }, { status: 503 });
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
  } catch (e) {
    // Surface the real reason instead of a generic message — this route runs
    // server-side, so the seller otherwise has nothing to act on.
    const detail = e instanceof Error ? e.message : 'Could not sign the World ID request.';
    console.error('[world-rp-signature] signRequest failed:', detail);
    return Response.json({ detail: `World ID signing failed: ${detail}` }, { status: 500 });
  }
}

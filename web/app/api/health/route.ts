// web/app/api/health/route.ts
// What this deployment can actually do, as booleans.
//
// Every failure in this product has a configuration cause and a misleading
// symptom. A missing Upstash pair reads as "No such worker" hours later. A
// missing Privy authorization key reads as a signing error from inside a
// library that mentions neither Privy nor keys. An empty Gateway balance reads
// as the same signing error. Working backwards from the symptom costs far more
// than asking the deployment what it has.
//
// ONLY booleans, never values. Knowing that WORKER_SECRET_KEY is set tells an
// attacker nothing they could not already infer from whether secret storage
// works; knowing its value would hand them every seller's upstream token. The
// same rule applies to anything added here later: if the honest answer is a
// string, it does not belong in this response.

import { kvConfigured, storageUsable } from '../../lib/kv';
import { secretsConfigured } from '../../lib/hosted.server';
import { delegationProblem } from '../../lib/delegate.server';
import { attestorProblem } from '../../lib/attestation';
import { HIDDEN_LISTINGS } from '../../lib/curation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const delegation = delegationProblem();
  const attestor = attestorProblem();

  const checks = {
    // Hosted workers and spend policies both live here. Without it a worker
    // registered on-chain stops existing on the next cold start.
    durableStorage: kvConfigured,
    // The escape hatch counts as usable for pairing, but not for workers.
    storageUsable,
    // Sealing a seller's upstream API key.
    workerSecrets: secretsConfigured,
    // The server signing x402 payments as the buyer's delegated wallet. This is
    // the one that decides whether Claude Code can pay at all.
    agentPayments: delegation === null,
    // World ID records reaching Arc.
    onChainVerification: attestor === null,
    // Gateway settlement through Circle.
    circleApiKey: !!process.env.CIRCLE_API_KEY,
    // The browser half of agent payments. Without it, approving a spend link
    // falls back to Privy's legacy delegated-actions flow, which newer apps do
    // not support and which fails by hanging rather than erroring.
    privySignerId: !!process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID,
    // Must be FALSE in production: it grants a verified badge with no check.
    worldDemoBypass: process.env.NEXT_PUBLIC_WORLD_DEMO === 'true',
    curatedOut: HIDDEN_LISTINGS.length,
    /**
     * Not a secret: NEXT_PUBLIC_ ships to every browser already.
     *
     * Shown because the most confusing failure in this system is a Privy app
     * mismatch. The app id, the app secret, the key quorum and the user's
     * wallet must all belong to ONE app, and when they do not, the symptom is
     * "no wallet account found for address 0x..." at the end of a payment that
     * passed every other check. Eyeballing this against the dashboard settles
     * in seconds what otherwise costs an evening.
     */
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || null,
  };

  // The reasons are already user-facing strings from the modules that own them,
  // written to be read by whoever has to fix it.
  const blocking: string[] = [];
  if (!checks.durableStorage) {
    blocking.push('No durable store: hosted workers and spend policies will not survive a cold start.');
  }
  if (delegation) blocking.push(delegation);
  if (!checks.privySignerId) {
    blocking.push(
      'NEXT_PUBLIC_PRIVY_SIGNER_ID is not set, so `link --spend` cannot attach this server as a ' +
        'signer. Use the key quorum id your PRIVY_AUTHORIZATION_KEY belongs to.',
    );
  }
  if (checks.worldDemoBypass) {
    blocking.push('NEXT_PUBLIC_WORLD_DEMO is on: anyone can mark themselves a verified human.');
  }

  return new Response(JSON.stringify({ ok: blocking.length === 0, checks, blocking }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

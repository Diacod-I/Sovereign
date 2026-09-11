// web/app/api/agent/pay/route.ts
//
// A linked terminal asking us to pay a worker from the account's own wallet.
//
// This is the most dangerous endpoint in the product and it is worth being
// explicit about why. A bearer token here can move someone's money. Four things
// stand between a stolen token and a drained treasury, and they are deliberately
// independent of each other:
//
//   1. the token resolves to exactly one account, and only a `spend` token at all
//   2. the spend policy is checked HERE, on the server, not in a browser
//   3. the payee must already be on that account's allowlist
//   4. Privy's own signer policy caps the amount and expires the grant
//
// Any one of those failing should not be enough. The approval threshold is a
// refusal rather than a prompt: it means "a human looks at this", and there is
// no human in a terminal.

import { parseUnits } from 'viem';
import { resolveToken, touchToken } from '../../../lib/link.server';
import { checkPolicy, readPolicy, release, reserve } from '../../../lib/policy.server';
import { sendAsUser, delegationProblem } from '../../../lib/delegate.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID || 5042002);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  });

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

export async function POST(request: Request) {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = await resolveToken(bearer);
  if (!token) return json({ error: 'This terminal is not linked, or its link was revoked.' }, 401);
  if (token.scope !== 'spend') {
    return json(
      { error: 'This terminal is linked for discovery only. Re-run `npx sovereign-mcp@latest link --spend` to allow paying.' },
      403,
    );
  }

  let body: { payTo?: string; amountUsdc?: string; agentId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const payTo = String(body.payTo ?? '');
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) return json({ error: 'payTo must be an Arc address.' }, 400);

  const amount = Number(body.amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'A positive amount is required.' }, 400);

  const saved = await readPolicy(token.account);
  const verdict = checkPolicy(saved, amount, payTo);
  if (!verdict.ok) return json({ error: verdict.reason, blockedBy: 'policy' }, 403);
  if (verdict.needsApproval) {
    return json(
      {
        error: `This is at or above your approval threshold, so it needs you in a browser rather than an agent deciding alone.`,
        blockedBy: 'approval',
      },
      403,
    );
  }

  // Checked after the policy, deliberately. A misconfigured server should not
  // answer "we are not set up" to a request the policy would have refused
  // anyway: that tells anyone holding a token more about us than about them.
  const problem = delegationProblem();
  if (problem) return json({ error: problem }, 503);

  // Reserved before the transfer, not after. Two calls racing would otherwise
  // both pass a budget check neither had spent against yet, and an agent making
  // parallel calls is the ordinary case.
  await reserve(token.account, amount);

  try {
    // Arc's native value field is 18-decimal wei even though USDC is the native
    // asset and prices are quoted at 6dp. Encoding with parseUnits keeps it an
    // exact BigInt rather than a float that rounds at the wrong place.
    const hash = await sendAsUser({
      account: token.account,
      to: payTo,
      valueWei: parseUnits(String(amount), 18),
      chainId: ARC_CHAIN_ID,
    });
    await touchToken(token.hash, token);
    return json({ ok: true, hash, amountUsdc: String(amount), payTo, account: token.account });
  } catch (e) {
    // Nothing moved, so the budget must not stay spent.
    await release(token.account, amount);
    const detail = e instanceof Error ? e.message : 'The transfer failed.';
    return json({ error: detail, blockedBy: 'chain' }, 502);
  }
}

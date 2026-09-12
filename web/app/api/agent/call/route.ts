// web/app/api/agent/call/route.ts
//
// A linked terminal buying one call, end to end.
//
// This replaces /api/agent/pay, which sent a bare transfer and never touched
// the worker's endpoint. That was the same defect as the browser's old
// "Hire & pay" button: it moved money on the buyer's behalf and then hoped
// somebody would do the work. Here the payment is inside the call, which is
// what x402 is for -- the authorisation is signed against terms the worker
// quoted in a 402, and a worker that never answers never gets quoted, so it
// never gets paid.
//
// The listing is read from the chain rather than taken from the request. A
// caller holding a valid token could otherwise name any payTo and any price and
// have the server sign for it; what the token authorises is "spend within my
// policy", not "spend wherever you say".

import { resolveToken, touchToken } from '../../../lib/link.server';
import { checkPolicy, readPolicy, release, reserve } from '../../../lib/policy.server';
import { NotPaidError, payAndCall } from '../../../lib/x402-pay.server';
import { SUBGRAPH_URL } from '../../../lib/arc';
import { assertFetchableUrl } from '../../../lib/ssrf';
import { undelivered as undeliveredFrom } from '../../../lib/hosted';
import { isHidden } from '../../../lib/curation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
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

type Listing = {
  id: string;
  name: string;
  endpoint: string;
  pricePerCall: string;
  payTo: string;
  owner: string;
  active: boolean;
};

async function fetchListing(agentId: string): Promise<Listing | null> {
  const query = `{ agents(where: { id: ${JSON.stringify(agentId)} }, first: 1) { id name endpoint pricePerCall payTo owner active } }`;
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`registry unreachable (HTTP ${res.status})`);
  const body = (await res.json()) as { data?: { agents?: Listing[] }; errors?: unknown };
  if (body.errors) throw new Error('registry query failed');
  return body.data?.agents?.[0] ?? null;
}

export async function POST(request: Request) {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = await resolveToken(bearer);
  if (!token) return json({ error: 'This terminal is not linked, or its link was revoked.' }, 401);
  if (token.scope !== 'spend') {
    return json(
      {
        error:
          'This terminal is linked for discovery only. Re-run `npx sovereign-mcp@latest link --spend` to let it pay.',
        // Machine-readable so a caller holding its own key can tell "this
        // account will not pay" from "this call was refused", and fall back to
        // paying for itself rather than giving up.
        blockedBy: 'scope',
      },
      403,
    );
  }

  let body: { agentId?: string; input?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const agentId = String(body.agentId ?? '');
  if (!agentId) return json({ error: 'agentId is required.' }, 400);

  let listing: Listing | null;
  try {
    listing = await fetchListing(agentId);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Could not read the registry.' }, 502);
  }
  if (!listing) return json({ error: `No listing with id "${agentId}".` }, 404);
  if (!listing.active) return json({ error: `"${listing.name}" has been retired by its seller.` }, 410);
  // Hiding a listing in the grid is not enough. An agent that learned the id
  // from anywhere else -- an old transcript, the registry directly -- must not
  // be able to spend this account's money on it.
  if (isHidden(listing.id)) {
    return json({ error: `"${listing.name}" is not served by this marketplace.` }, 410);
  }

  // The endpoint comes off the chain, but it is still a URL this server is
  // about to fetch on someone else's instruction, so it goes through the same
  // guard every other outbound URL does. A seller cannot use a listing to point
  // us at our own metadata service.
  try {
    await assertFetchableUrl(listing.endpoint);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'That endpoint cannot be called.' }, 400);
  }

  // pricePerCall is atomic 6dp on-chain.
  const price = Number(listing.pricePerCall) / 1e6;
  if (!Number.isFinite(price) || price <= 0) {
    return json({ error: 'That listing has no usable price.' }, 502);
  }

  const saved = await readPolicy(token.account);
  const verdict = checkPolicy(saved, price, listing.payTo);
  if (!verdict.ok) return json({ error: verdict.reason, blockedBy: 'policy' }, 403);
  if (verdict.needsApproval) {
    return json(
      {
        error:
          'This is at or above your approval threshold, so it needs you in a browser rather than an agent deciding alone.',
        blockedBy: 'approval',
      },
      403,
    );
  }

  // Booked before the call, because two calls racing would otherwise both pass a
  // budget neither had spent against yet, and parallel calls are the ordinary
  // case for an agent.
  await reserve(token.account, price);

  const startedAt = Date.now();
  try {
    const paid = await payAndCall({
      account: token.account,
      url: listing.endpoint,
      body: body.input ?? {},
      maxUsdc: price,
    });
    const latencyMs = Date.now() - startedAt;

    // A hosted worker reports its own failure inside a 200. Money may or may not
    // have moved, and which one it is decides whether there is a receipt to file.
    const undelivered = undeliveredFrom(paid.data);
    if (undelivered) {
      if (!undelivered.paid) await release(token.account, price);
      return json({
        ok: false,
        delivered: false,
        paid: !!undelivered.paid,
        reason: undelivered.reason || 'the worker did not return a usable response',
        upstreamStatus: undelivered.upstreamStatus ?? null,
        agent: { id: listing.id, name: listing.name, payTo: listing.payTo },
        settlement: undelivered.paid
          ? { amountUsdc: paid.formattedAmount, transaction: paid.transaction }
          : null,
        latencyMs,
      });
    }

    // Nothing was charged: the worker served without a paywall.
    if (paid.amount === BigInt(0)) {
      await release(token.account, price);
      return json({
        ok: true,
        delivered: true,
        paid: false,
        free: true,
        agent: { id: listing.id, name: listing.name, payTo: listing.payTo },
        output: (paid.data as { output?: unknown })?.output ?? paid.data,
        latencyMs,
      });
    }

    await touchToken(token.hash, token);
    return json({
      ok: true,
      delivered: true,
      paid: true,
      agent: { id: listing.id, name: listing.name, payTo: listing.payTo },
      output: (paid.data as { output?: unknown })?.output ?? paid.data,
      settlement: {
        amountUsdc: paid.formattedAmount,
        asset: 'USDC',
        payTo: listing.payTo,
        payer: token.account,
        transaction: paid.transaction,
      },
      latencyMs,
    });
  } catch (e) {
    const latencyMs = Date.now() - startedAt;
    // NotPaidError is the library's own guarantee that signing never happened,
    // so the budget must go back. Anything else got past the signature and we
    // cannot claim the money stayed put.
    if (e instanceof NotPaidError) {
      await release(token.account, price);
      return json(
        {
          ok: false,
          delivered: false,
          paid: false,
          reason: e.message,
          agent: { id: listing.id, name: listing.name },
          latencyMs,
        },
        502,
      );
    }
    return json(
      {
        ok: false,
        delivered: false,
        paid: null,
        reason: e instanceof Error ? e.message : 'The call failed after the payment was signed.',
        agent: { id: listing.id, name: listing.name },
        latencyMs,
      },
      502,
    );
  }
}

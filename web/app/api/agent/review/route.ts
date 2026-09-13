// web/app/api/agent/review/route.ts
//
// A linked terminal filing the grade for a call it already paid for.
//
// The browser path (dashboard → review modal → wallet signature) stays and is
// still the one a human at a laptop should use. This exists because the buyer
// is not always at a laptop: they are in a terminal, they have just read the
// output, and the moment they know whether it was any good is the moment the
// grade is worth capturing. Making them change device to say "that was wrong"
// is how a reputation system ends up with only the happy paths recorded.
//
// What this route does NOT do is decide the grade. `met` arrives as a number
// the human stated. The agent that made the call is not a witness to its own
// quality, and a marketplace whose scores were written by the sellers' own
// customers' agents -- unsupervised -- would be measuring nothing. That
// boundary lives here, in the route, not in a prompt that can be argued with.

import { resolveToken, touchToken } from '../../../lib/link.server';
import { fileReceiptOnChain, ReviewError } from '../../../lib/review.server';
import { SUBGRAPH_URL } from '../../../lib/arc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });

/** Confirms the agent exists before we write its name into a permanent record. */
async function agentExists(agentId: string): Promise<boolean> {
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:String!){ agents(where:{id:$id}, first:1){ id } }',
        variables: { id: agentId },
      }),
    });
    const j = (await res.json()) as { data?: { agents?: Array<{ id: string }> } };
    return (j.data?.agents?.length ?? 0) > 0;
  } catch {
    // The registry being unreachable is not a reason to lose a grade the buyer
    // has already given. This check is a courtesy, not a gate.
    return true;
  }
}

export async function POST(request: Request) {
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const token = await resolveToken(bearer);
  if (!token) return json({ error: 'This terminal is not linked, or its link was revoked.' }, 401);

  // Filing burns gas from the buyer's wallet, so it needs the same authority as
  // spending. A discovery-only pairing can read track records but not write one.
  if (token.scope !== 'spend') {
    return json(
      {
        error:
          'This terminal is linked for discovery only. Re-run `npx sovereign-mcp@latest link --spend` ' +
          'to let it file grades.',
        blockedBy: 'scope',
      },
      403,
    );
  }

  let body: {
    agentId?: string;
    settlementRef?: string;
    met?: number;
    note?: string;
    expectation?: string;
    amountUsdc?: string;
    latencyMs?: number;
    delivered?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const agentId = String(body.agentId || '').trim();
  if (!agentId) return json({ error: 'agentId is required.' }, 400);

  // Checked explicitly rather than coerced. `met` is the entire payload of this
  // request, and a silent 0 for a missing field would publish "not met" against
  // a worker on the strength of a typo.
  if (typeof body.met !== 'number' || ![0, 1, 2].includes(body.met)) {
    return json(
      { error: 'met must be 0 (not met), 1 (partially met) or 2 (met), stated by the buyer.' },
      400,
    );
  }

  if (!(await agentExists(agentId))) {
    return json({ error: `No agent "${agentId}" in the registry.` }, 404);
  }

  try {
    const hash = await fileReceiptOnChain({
      account: token.account,
      agentId,
      settlementRef: String(body.settlementRef || ''),
      amountUsdc: String(body.amountUsdc || '0'),
      latencyMs: Number(body.latencyMs || 0),
      delivered: body.delivered !== false,
      met: body.met as 0 | 1 | 2,
      expectation: String(body.expectation || ''),
      note: String(body.note || ''),
    });
    await touchToken(token.hash, token);
    return json({ ok: true, transaction: hash, met: body.met, agentId });
  } catch (e) {
    if (e instanceof ReviewError) return json({ ok: false, error: e.message }, 400);
    return json(
      { ok: false, error: e instanceof Error ? e.message : 'Could not file the receipt.' },
      500,
    );
  }
}

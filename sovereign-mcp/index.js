#!/usr/bin/env node
// Sovereign MCP server — connects an agent (Claude) to the Sovereign marketplace.
// Discovery reads LIVE from the sovereign-registry subgraph on The Graph.
// Run: SUBGRAPH_URL=<studio query url> node index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  agentBalances,
  autonomousDisabledReason,
  depositToGateway,
  hasAutonomousKeys,
  settleAndCall,
} from './x402.js';
import { score, summarise, tier, trackRecord } from './reputation.js';

const SUBGRAPH_URL = process.env.SUBGRAPH_URL;
const usdc = (base) => (Number(base) / 1e6).toString();
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

async function queryGraph(query, variables = {}) {
  if (!SUBGRAPH_URL) {
    throw new Error('SUBGRAPH_URL is not set. Deploy the subgraph, copy its query URL from Subgraph Studio, and pass it as the SUBGRAPH_URL env var.');
  }
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Subgraph error: ' + JSON.stringify(json.errors));
  return json.data;
}

const TRACK_FIELDS =
  'receiptCount deliveredCount metScore totalPaid latencyTotalMs distinctBuyers repeatBuyers lastHiredAt';
const AGENT_FIELDS = `id name description tags endpoint pricePerCall payTo owner ${TRACK_FIELDS}`;
const AGENT_FIELDS_BARE = 'id name description tags endpoint pricePerCall payTo owner';

const SITE_URL = process.env.SOVEREIGN_SITE_URL || 'https://sovereign-marketplace.vercel.app';

/**
 * A link that carries this call's context into the Sovereign web app, so the
 * human does not retype what the agent already knows. `hire` prefills the
 * payment modal with the stated expectation; `review` prefills the grading
 * modal after an autonomous payment has settled.
 */
function handoffLink(kind, payload) {
  const json = JSON.stringify({ v: 1, ...payload });
  const b64 = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${SITE_URL}/dashboard?${kind}=${b64}`;
}

async function fetchActiveAgents() {
  try {
    const data = await queryGraph(`{ agents(where: { active: true }, first: 100) { ${AGENT_FIELDS} } }`);
    return data.agents || [];
  } catch {
    // Receipts datasource not deployed yet — discovery still has to work, every
    // worker just reads as unproven.
    const data = await queryGraph(`{ agents(where: { active: true }, first: 100) { ${AGENT_FIELDS_BARE} } }`);
    return data.agents || [];
  }
}

async function fetchReceipts(agentId, first = 10) {
  try {
    const data = await queryGraph(
      `query($id: String!, $first: Int!) {
         receipts(where: { agentId: $id }, orderBy: at, orderDirection: desc, first: $first) {
           id buyer amount latencyMs delivered met expectation note at
         }
       }`,
      { id: agentId, first },
    );
    return data.receipts || [];
  } catch {
    return [];
  }
}

/**
 * Relevance first, then track record.
 *
 * Keyword overlap alone would rank an unproven worker level with one that has
 * met expectations across forty paid calls. Reputation breaks the tie, and an
 * unproven worker sorts below any proven one of equal relevance — which is the
 * correct default when spending someone's money.
 */
function rank(agents, task) {
  const terms = (task || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = agents.map((a) => {
    const hay = `${a.name} ${a.description} ${a.tags}`.toLowerCase();
    const relevance = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    const rec = trackRecord(a);
    return { a, relevance, trust: score(rec) ?? -1 };
  });
  const hits = scored.filter((s) => s.relevance > 0);
  const pool = hits.length ? hits : scored;
  return pool
    .sort((x, y) => y.relevance - x.relevance || y.trust - x.trust)
    .map((s) => s.a);
}

function describe(a) {
  const rec = trackRecord(a);
  return [
    `• ${a.name} — ${usdc(a.pricePerCall)} USDC/call — id: ${a.id}`,
    `    ${a.description}`,
    `    TRACK RECORD: ${summarise(rec)}`,
    `    tags: ${a.tags}`,
    `    seller: ${short(a.owner)} · pays to: ${a.payTo}`,
    `    endpoint: ${a.endpoint}`,
  ].join('\n');
}

const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002);

// Best-effort call to a worker's HTTP endpoint. Placeholder / unreachable URLs fail
// softly so discovery + the payment intent still come back.
async function invokeWorker(endpoint, input) {
  if (!endpoint || !/^https?:\/\//i.test(endpoint) || /your-host|example\.com/i.test(endpoint)) {
    return { ok: false, note: 'endpoint is a placeholder — not called' };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (res.status === 402) {
      return { ok: false, status: 402, note: 'worker requires payment (x402) before serving', body };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, note: `endpoint unreachable: ${e.message}` };
  }
}

// The structured settlement the human confirms in the web app.
function paymentIntent(a) {
  return {
    type: 'sovereign.payment_intent',
    agentId: a.id,
    amount: usdc(a.pricePerCall),
    asset: 'USDC',
    payTo: a.payTo,
    chainId: ARC_CHAIN_ID,
    seller: a.owner,
    memo: `sovereign:call_agent:${a.id}`,
  };
}

const server = new McpServer({ name: 'sovereign', version: '1.0.0' });

server.tool(
  'search_agents',
  'Search the Sovereign marketplace (live on-chain registry, indexed by The Graph) for agents that can perform a task. Returns a ranked list with each agent’s seller, price per call in USDC, tags, and endpoint.',
  { task: z.string().describe('What the user wants done, e.g. "score the risk of an ETH address"') },
  async ({ task }) => {
    const agents = await fetchActiveAgents();
    const ranked = rank(agents, task).slice(0, 8);
    if (!ranked.length) return { content: [{ type: 'text', text: `No active agents found in the registry.` }] };
    return {
      content: [{ type: 'text', text: `Found ${ranked.length} agent(s) for "${task}":\n\n` + ranked.map(describe).join('\n\n') }],
    };
  }
);

server.tool(
  'list_agents',
  'List every active agent in the Sovereign registry (live from The Graph), unfiltered.',
  {},
  async () => {
    const agents = await fetchActiveAgents();
    if (!agents.length) return { content: [{ type: 'text', text: 'Registry is empty (no active agents).' }] };
    return { content: [{ type: 'text', text: `${agents.length} active agent(s):\n\n` + agents.map(describe).join('\n\n') }] };
  }
);

server.tool(
  'call_agent',
  'Hire an agent from the Sovereign marketplace. Calls the agent\'s endpoint with your input and returns its output plus a payment intent (amount, payTo, chainId). This keyless variant never holds a private key — the human confirms settlement in the Sovereign web app ("Hire & pay" on the marketplace card), where the buyer\'s embedded Privy wallet signs the transfer on Arc.',
  {
    agentId: z.string().describe('The id from search_agents / list_agents'),
    input: z.record(z.any()).describe('Input payload for the agent'),
    expectation: z
      .string()
      .optional()
      .describe(
        'One line stating what a good result looks like, in the user\'s terms. Recorded BEFORE the call and graded against afterwards, so state it honestly rather than describing whatever comes back.',
      ),
  },
  async ({ agentId, input, expectation }) => {
    const agents = await fetchActiveAgents();
    const a = agents.find((x) => x.id === agentId);
    if (!a) return { content: [{ type: 'text', text: `No active agent with id "${agentId}".` }], isError: true };
    const want = (expectation || '').trim();
    const startedAt = Date.now();

    // Autonomous settle+call when the operator provisioned an agent key. The
    // x402 handshake (402 → sign → retry → 200) happens inside settleAndCall.
    // Anything short of a real settlement falls through to the keyless intent.
    let autonomousNote = '';
    if (hasAutonomousKeys()) {
      try {
        const { output, settlement } = await settleAndCall(a, input);
        const latencyMs = Date.now() - startedAt;
        const delivered = output !== undefined && output !== null && output !== '';
        // Everything needed to grade this call, carried into the web app so the
        // human confirms what happened instead of retyping it.
        const reviewUrl = handoffLink('review', {
          agentId: a.id,
          agentName: a.name,
          amountUsdc: settlement.amount,
          expectation: want,
          settlementRef: settlement.transaction || '',
          latencyMs,
          delivered,
        });
        return { content: [{ type: 'text', text: [
          `Agent: ${a.name} (${a.id}) — PAID ${settlement.amount} USDC → ${settlement.payTo} on ${settlement.network}`,
          settlement.transaction ? `Settlement tx: ${settlement.transaction}` : '',
          `Took ${latencyMs}ms · track record: ${summarise(trackRecord(a))}`,
          want ? `Expectation on record: "${want}"` : '',
          ``,
          `WORKER OUTPUT:\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`,
          ``,
          `SETTLEMENT:\n${JSON.stringify(settlement, null, 2)}`,
          ``,
          `RATE THIS CALL — opens the review prefilled:`,
          reviewUrl,
          ``,
          `Tell the user the result, then give them that link. Their rating is what`,
          `the next buyer of this worker will see, so it is part of the job.`,
        ].filter(Boolean).join('\n') }] };
      } catch (e) {
        autonomousNote = `(autonomous payment unavailable — ${e.message}; returning a manual payment intent)\n\n`;
      }
    } else {
      const why = autonomousDisabledReason();
      if (why) autonomousNote = `(keyless mode — ${why})\n\n`;
    }

    const result = await invokeWorker(a.endpoint, input);
    const intent = paymentIntent(a);
    const rendered = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2);

    const latencyMs = Date.now() - startedAt;
    // Keyless: nothing is paid here, so there is no settlement to grade yet.
    // The link carries the agent and the stated expectation into "Hire & pay",
    // and the review is raised automatically once the human's payment lands.
    const hireUrl = handoffLink('hire', {
      agentId: a.id,
      agentName: a.name,
      amountUsdc: usdc(a.pricePerCall),
      expectation: want,
    });

    const text = [
      `Agent: ${a.name} (${a.id}) — ${usdc(a.pricePerCall)} USDC/call — seller ${short(a.owner)}`,
      `Track record: ${summarise(trackRecord(a))}`,
      want ? `Expectation on record: "${want}"` : '',
      `Endpoint answered in ${latencyMs}ms`,
      ``,
      result.ok
        ? `WORKER OUTPUT:\n${rendered}`
        : result.status === 402
          ? `WORKER OUTPUT: (withheld — the worker is x402-gated and this session holds no\nagent key, so nothing was paid and nothing was served. That is the paywall\nworking, not a failure.)`
          : `WORKER OUTPUT: (unavailable — ${result.note || 'call failed'}${result.status ? `, HTTP ${result.status}` : ''})`,
      ``,
      `PAYMENT INTENT — ${a.name} costs ${intent.amount} USDC per call:`,
      JSON.stringify(intent, null, 2),
      ``,
      `HIRE IT — opens the Sovereign app with this expectation prefilled:`,
      hireUrl,
      ``,
      `The buyer's embedded Privy wallet signs the transfer on Arc under their spend`,
      `policy. Afterwards the app asks them to grade the result against the`,
      `expectation above, and that rating becomes this worker's public track record.`,
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: autonomousNote + text }] };
  }
);

server.tool(
  'agent_profile',
  "Open one agent's profile: its price, capabilities, and its track record from on-chain receipts — how many paid calls it has served, how often it met what buyers asked for, how many buyers came back, and the most recent graded work. Use this before hiring anything expensive or unfamiliar; a cheap worker with no track record is not cheap.",
  { agentId: z.string().describe('The id from search_agents / list_agents') },
  async ({ agentId }) => {
    const agents = await fetchActiveAgents();
    const a = agents.find((x) => x.id === agentId);
    if (!a) return { content: [{ type: 'text', text: `No active agent with id "${agentId}".` }], isError: true };

    const rec = trackRecord(a);
    const recent = await fetchReceipts(agentId, 8);
    const MET = { 0: 'NOT MET', 1: 'PARTIAL', 2: 'MET' };

    const history = recent.length
      ? recent.map((r) => {
          const when = new Date(Number(r.at) * 1000).toISOString().slice(0, 10);
          const took = Number(r.latencyMs) > 0 ? ` · ${Number(r.latencyMs)}ms` : '';
          const why = r.note ? `\n      note: ${r.note}` : '';
          return `  [${MET[Number(r.met)] ?? '?'}] ${when} · ${short(r.buyer)} · ${usdc(r.amount)} USDC${took}\n      asked for: ${r.expectation || '(none recorded)'}${why}`;
        }).join('\n')
      : '  (no graded calls yet)';

    return { content: [{ type: 'text', text: [
      `${a.name} (${a.id}) — ${usdc(a.pricePerCall)} USDC/call`,
      `${a.description}`,
      `tags: ${a.tags}`,
      `seller: ${short(a.owner)} · pays to: ${a.payTo}`,
      `endpoint: ${a.endpoint}`,
      ``,
      `TRACK RECORD`,
      `  ${summarise(rec)}`,
      rec.receiptCount > 0 ? `  ${usdc(String(Math.round(rec.totalPaid * 1e6)))} USDC earned across ${rec.distinctBuyers} buyer(s)` : '',
      ``,
      `PREVIOUS WORK (buyer-graded, on-chain)`,
      history,
      ``,
      rec.receiptCount === 0
        ? `This worker is unproven. Nobody has graded it, so its price is the only thing`
          + `\nknown about it. Say so before spending the user's money on it.`
        : `Ratings come from buyers who paid, graded against what they said they wanted`
          + `\nbefore hiring. Each is a receipt on Arc.`,
    ].filter(Boolean).join('\n') }] };
  }
);

server.tool(
  'agent_wallet',
  "Show the buyer agent's own payment wallet: its address, on-chain USDC balance, and Circle Gateway balance (the runway x402 nanopayments draw from). Only available in autonomous mode.",
  {},
  async () => {
    if (!hasAutonomousKeys()) {
      return { content: [{ type: 'text', text:
        `Keyless mode — ${autonomousDisabledReason()}. There is no agent wallet; payments are confirmed by the human in the Sovereign web app.` }] };
    }
    try {
      const { address, chain, balances } = await agentBalances();
      return { content: [{ type: 'text', text: [
        `Agent wallet: ${address} on ${chain}`,
        `Wallet USDC:  ${balances?.wallet?.formatted ?? '?'}`,
        `Gateway USDC: ${balances?.gateway?.formatted ?? balances?.available?.formatted ?? '?'}  ← spendable over x402`,
        ``,
        `Top the Gateway balance up with the fund_agent tool if it is low.`,
      ].join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not read balances: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  'fund_agent',
  "Move USDC from the agent's own wallet into its Circle Gateway balance, which is what x402 payments draw from. Run this once before the agent starts paying workers.",
  { amount: z.string().describe('Whole USDC to deposit, e.g. "5"') },
  async ({ amount }) => {
    if (!hasAutonomousKeys()) {
      return { content: [{ type: 'text', text: `Keyless mode — ${autonomousDisabledReason()}.` }], isError: true };
    }
    try {
      const r = await depositToGateway(amount);
      return { content: [{ type: 'text', text:
        `Deposited ${r.formattedAmount ?? amount} USDC into Gateway for ${r.depositor}.\ndeposit tx: ${r.depositTxHash}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Deposit failed: ${e.message}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(
  'sovereign-mcp running (stdio). SUBGRAPH_URL ' + (SUBGRAPH_URL ? 'set' : 'NOT set') +
  ' — payments: ' + (hasAutonomousKeys() ? 'AUTONOMOUS (x402 via Circle Gateway)' : 'keyless (human confirms in the web app)')
);

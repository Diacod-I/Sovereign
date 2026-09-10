#!/usr/bin/env node
// Sovereign MCP server — connects an agent (Claude) to the Sovereign marketplace.
// Discovery reads LIVE from the sovereign-registry subgraph on The Graph.
// Run: SUBGRAPH_URL=<studio query url> node index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hasAutonomousKeys, settleAndCall } from './x402.js';

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

const AGENT_FIELDS = 'id name description tags endpoint pricePerCall payTo owner';

async function fetchActiveAgents() {
  const data = await queryGraph(`{ agents(where: { active: true }, first: 100) { ${AGENT_FIELDS} } }`);
  return data.agents || [];
}

function rank(agents, task) {
  const terms = (task || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = agents.map((a) => {
    const hay = `${a.name} ${a.description} ${a.tags}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    return { a, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score);
  return (hits.length ? hits : scored).map((s) => s.a);
}

function describe(a) {
  return [
    `• ${a.name} — ${usdc(a.pricePerCall)} USDC/call — id: ${a.id}`,
    `    ${a.description}`,
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
  },
  async ({ agentId, input }) => {
    const agents = await fetchActiveAgents();
    const a = agents.find((x) => x.id === agentId);
    if (!a) return { content: [{ type: 'text', text: `No active agent with id "${agentId}".` }], isError: true };

    // Autonomous settle+call when the operator provisioned server-signing
    // keys (Privy server wallet + Circle Gateway). Otherwise fall through to the
    // keyless payment intent below.
    let autonomousNote = '';
    if (hasAutonomousKeys()) {
      try {
        const { output, settlement } = await settleAndCall(a, input);
        return { content: [{ type: 'text', text: [
          `Agent: ${a.name} (${a.id}) — PAID ${settlement.amount} USDC → ${settlement.payTo} on ${settlement.network}`,
          ``,
          `WORKER OUTPUT:\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`,
          ``,
          `SETTLEMENT:\n${JSON.stringify(settlement, null, 2)}`,
        ].join('\n') }] };
      } catch (e) {
        autonomousNote = `(autonomous payment unavailable — ${e.message}; returning a manual payment intent)\n\n`;
      }
    }

    const result = await invokeWorker(a.endpoint, input);
    const intent = paymentIntent(a);
    const rendered = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2);

    const text = [
      `Agent: ${a.name} (${a.id}) — ${usdc(a.pricePerCall)} USDC/call — seller ${short(a.owner)}`,
      ``,
      result.ok
        ? `WORKER OUTPUT:\n${rendered}`
        : `WORKER OUTPUT: (unavailable — ${result.note || 'call failed'}${result.status ? `, HTTP ${result.status}` : ''})`,
      ``,
      `PAYMENT INTENT — confirm in the Sovereign web app → Marketplace → "${a.name}" → "Hire & pay":`,
      JSON.stringify(intent, null, 2),
      ``,
      `Pay ${intent.amount} USDC to ${intent.payTo} on chain ${intent.chainId}. The buyer's embedded Privy`,
      `wallet signs it; both dashboards reflect the settlement once it lands on Arc.`,
    ].join('\n');

    return { content: [{ type: 'text', text: autonomousNote + text }] };
  }
);

await server.connect(new StdioServerTransport());
console.error('sovereign-mcp running (stdio). SUBGRAPH_URL ' + (SUBGRAPH_URL ? 'set' : 'NOT set'));

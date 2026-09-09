// Sovereign MCP server — connects an agent (Claude) to the Sovereign marketplace.
// Discovery reads LIVE from the sovereign-registry subgraph on The Graph.
// Run: SUBGRAPH_URL=<studio query url> node index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  'Hire an agent from the marketplace and pay it per request in USDC. (Payment settlement via Circle nanopayments is being wired — for now this returns the settlement that WOULD occur so the flow can be reviewed.)',
  {
    agentId: z.string().describe('The id from search_agents / list_agents'),
    input: z.record(z.any()).describe('Input payload for the agent'),
  },
  async ({ agentId, input }) => {
    const agents = await fetchActiveAgents();
    const a = agents.find((x) => x.id === agentId);
    if (!a) return { content: [{ type: 'text', text: `No active agent with id "${agentId}".` }], isError: true };
    return {
      content: [{
        type: 'text',
        text: `PENDING SETTLEMENT (Circle nanopayments not yet wired):\n` +
              `Would pay ${usdc(a.pricePerCall)} USDC to ${a.payTo} (seller ${short(a.owner)})\n` +
              `then call ${a.endpoint} with input ${JSON.stringify(input)}\n` +
              `and return "${a.name}"'s result.`,
      }],
    };
  }
);

await server.connect(new StdioServerTransport());
console.error('sovereign-mcp running (stdio). SUBGRAPH_URL ' + (SUBGRAPH_URL ? 'set' : 'NOT set'));

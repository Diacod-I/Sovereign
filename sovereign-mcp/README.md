# sovereign-mcp

MCP server that lets an agent (Claude Code, or any MCP client) **discover, hire, and
pay** agents on the [Sovereign](https://github.com/Diacod-I/sovereign) marketplace.

Discovery reads **live** from the `sovereign-registry` subgraph on The Graph. Payment
runs over **x402** and settles in USDC on **Arc**. With no payment keys the server
stays keyless, `call_agent` returns a signed-in-the-browser payment intent that a
human confirms in the Sovereign web app.

## Install

```jsonc
// .mcp.json (Claude Code) or any MCP client
{
  "mcpServers": {
    "sovereign": {
      "command": "npx",
      "args": ["-y", "sovereign-mcp"],
      "env": {
        "SUBGRAPH_URL": "https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest"
      }
    }
  }
}
```

Or run it directly:

```bash
SUBGRAPH_URL=<studio query url> npx sovereign-mcp
```

## Tools

| Tool | What it does |
| --- | --- |
| `search_agents` | Ranked search of the live on-chain registry for agents that can do a task. Returns seller, price/call (USDC), tags, endpoint. |
| `list_agents` | Every active agent in the registry, unfiltered. |
| `call_agent` | Calls an agent's endpoint with your input and returns its output. Pays the worker over x402 when an agent key is provisioned; otherwise returns a payment intent for a human to confirm. |
| `agent_wallet` | The agent's own wallet address, USDC balance, and Circle Gateway balance (the runway x402 draws from). Autonomous mode only. |
| `fund_agent` | Moves USDC from the agent's wallet into its Gateway balance. Run once before the agent starts paying. Autonomous mode only. |

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `SUBGRAPH_URL` | yes | The Graph query URL for `sovereign-registry`. |
| `ARC_CHAIN_ID` | no | Defaults to `5042002` (Arc testnet). |
| `SOVEREIGN_AGENT_KEY` | no | 32-byte hex private key for the agent's own wallet. **Setting it is what turns autonomous mode on.** Without it `call_agent` is keyless. |
| `CIRCLE_GATEWAY_CHAIN` | no | `arcTestnet` (default) or `arc`. |
| `CIRCLE_API_KEY` | no | Required for Circle Gateway to accept verify/settle. |
| `SOVEREIGN_MAX_PER_CALL` | no | Hard per-call spend cap in USDC (default `1`). A worker quoting above it never gets a signature. |
| `ARC_RPC_URL` | no | Private Arc RPC. Required for `CIRCLE_GATEWAY_CHAIN=arc`. |

See `.env.example` for the full list.

## How a paid call works

```
call_agent
  └─ POST <worker endpoint>                    → 402 + PAYMENT-REQUIRED (amount, payTo, asset, network)
  └─ spend policy check (SOVEREIGN_MAX_PER_CALL)  ← refuses here, before signing
  └─ sign EIP-3009 authorization against the Gateway wallet
  └─ POST again with Payment-Signature         → 200 + worker output
       worker side: verify → serve → settle (batched, gasless, on Arc)
```

## License

MIT

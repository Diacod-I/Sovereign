# sovereign-mcp

MCP server that lets an agent (Claude Code or any MCP client) **discover, hire and
pay** agents on the [Sovereign](https://github.com/Diacod-I/Sovereign) marketplace.

Discovery reads **live** from the `sovereign-registry` subgraph on The Graph. Payment
runs over **x402** and settles in USDC on **Arc**, inside the same request that calls
the worker: the money is only released if the worker answers. Without a payment key
the server is discovery-only — `call_agent` reports what a worker costs and whether
it is up, and hires nothing. There is deliberately no pay-by-hand path: a transfer
made outside the call never reaches the worker's endpoint, so it can take the money
and return nothing.

## Install

```bash
npx sovereign-mcp@latest link --spend
```

Pairs this terminal with a Sovereign account and sets everything up in one step:
it prints a code, you approve it in the browser with the wallet that will pay, and
it writes the Sovereign skill into `.claude/skills/` plus a `.mcp.json` entry
carrying the pairing. Restart Claude Code afterwards, or none of it loads.

`--spend` is what makes the terminal able to pay. Without it the pairing is
discovery-only: `call_agent` reports what a worker costs and whether it is up, and
hires nothing.

The token it writes into `.mcp.json` is a bearer credential for your account. Keep
it out of git.

```bash
npx sovereign-mcp init     # skill + .mcp.json only, no pairing
```

`init` is the same setup without the account link, for anyone who only wants
discovery. Neither command overwrites a file you have edited: it drops ours beside
yours as `.sovereign-new` and tells you.

Or wire it by hand:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "sovereign": {
      "command": "npx",
      "args": ["-y", "sovereign-mcp@latest"],
      "env": {
        "SUBGRAPH_URL": "https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest"
      }
    }
  }
}
```

### Why `init` is optional

The server ships its own usage guidance in the MCP `instructions` field, which
clients inject into context the moment the server connects. So the marketplace is
discoverable with **no install step at all**, `init` only adds the skill file, for
clients that use skills and for anyone who wants to edit the guidance locally.

This matters because the failure it prevents is silent: with the tools loaded but
nothing saying *when* to reach for them, an agent will happily web-search a task
the marketplace sells and never mention it.

## Tools

| Tool | What it does |
| --- | --- |
| `search_agents` | Ranked search of the live on-chain registry for agents that can do a task. Free. Returns seller, price/call (USDC), tags, endpoint, track record. |
| `list_agents` | Every active agent in the registry, unfiltered. Free. |
| `agent_profile` | One worker's price, capabilities and track record from on-chain receipts: calls served, how often it met what buyers asked, repeat buyers, recent graded work. Free. |
| `call_agent` | Calls an agent's endpoint with your input and returns its output. **Spends money**, inside the account's spend policy. Without a pairing or an agent key it reports the price and whether the worker is answering, and hires nothing. |
| `rate_call` | Files the buyer's verdict on a paid call as an on-chain receipt: 0 not met, 1 partially met, 2 met. The buyer states the grade; the agent never decides it. |
| `agent_wallet` | The agent's own wallet address, USDC balance and Circle Gateway balance (the runway x402 draws from). Autonomous mode only. |
| `fund_agent` | Moves USDC from the agent's wallet into its Gateway balance. Run once before the agent starts paying. Autonomous mode only. |

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `SUBGRAPH_URL` | yes | The Graph query URL for `sovereign-registry`. |
| `SOVEREIGN_LINK_TOKEN` | no | Written by `link --spend`. Lets this terminal pay and grade from the account's own wallet, with no key on the machine. |
| `SOVEREIGN_ACCOUNT` | no | Written by `link`. The paired account's wallet address. |
| `SOVEREIGN_SITE_URL` | no | Marketplace base URL. Defaults to the hosted deployment. |
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

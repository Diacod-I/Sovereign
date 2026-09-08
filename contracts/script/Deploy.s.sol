// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        AgentRegistry reg = new AgentRegistry();

        // Seed a few agents so the subgraph has data to index immediately.
        // pricePerCall is USDC with 6 decimals (0.05 USDC = 50000).
        reg.register("data-agent", me, 50000, "On-chain Data Agent", "Live wallet, token, and protocol intelligence for any EVM address.", "data,onchain,evm", "https://your-host/agents/data");
        reg.register("risk-agent", me, 120000, "Address Risk Agent", "Sanctions, mixer, and exploit exposure scoring before you transact.", "risk,sanctions,aml", "https://your-host/agents/risk");
        reg.register("liquidity-agent", me, 20000, "Liquidity Intel Agent", "Real-time DEX depth, slippage, and LP position snapshots.", "liquidity,dex,defi", "https://your-host/agents/liquidity");

        vm.stopBroadcast();
        console2.log("AgentRegistry:", address(reg));
    }
}

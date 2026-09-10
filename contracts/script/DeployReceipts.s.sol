// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Receipts} from "../src/Receipts.sol";

contract DeployReceipts is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        Receipts r = new Receipts();
        vm.stopBroadcast();
        console2.log("Receipts:", address(r));
        console2.log("Set NEXT_PUBLIC_RECEIPTS_ADDRESS and the subgraph datasource to this.");
    }
}

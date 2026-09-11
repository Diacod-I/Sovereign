// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Verifications} from "../src/Verifications.sol";

contract DeployVerifications is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        // The address matching ATTESTOR_PRIVATE_KEY in the web app's environment.
        // Get it wrong and every attest() reverts with BadSignature, so it is read
        // as an address rather than derived, and echoed below to check against.
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");

        vm.startBroadcast(pk);
        Verifications v = new Verifications(attestor);
        vm.stopBroadcast();

        console2.log("Verifications:", address(v));
        console2.log("attestor:", attestor);
        console2.log("Set NEXT_PUBLIC_VERIFICATIONS_ADDRESS and the subgraph datasource to this.");
    }
}

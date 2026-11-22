// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";

contract DeployReactive is Script {
    function run() external {
        require(block.chainid == 5318007, "Select Lasna");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        WaitlistReactive watcher = new WaitlistReactive();
        vm.stopBroadcast();
        console2.log("VITE_REACTIVE_ADDRESS", address(watcher));
    }
}

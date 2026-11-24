// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";

contract BindSource is Script {
    function run() external {
        require(block.chainid == 5318007, "Select Lasna");
        WaitlistReactive watcher = WaitlistReactive(payable(vm.envAddress("VITE_REACTIVE_ADDRESS")));
        address source = vm.envAddress("VITE_FACTORY_ADDRESS");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        watcher.bindFactory(source);
        vm.stopBroadcast();
        console2.log("Subscribed to Base Sepolia factory", source);
    }
}

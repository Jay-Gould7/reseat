// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";

contract BindSource is Script {
    function run() external {
        require(block.chainid == 5318007, "Select Lasna");
        WaitlistReactive watcher = WaitlistReactive(payable(vm.envAddress("VITE_REACTIVE_ADDRESS")));
        address source = vm.envAddress("VITE_FACTORY_ADDRESS");
        address relay = vm.envAddress("WAITLIST_RELAY_ADDRESS");
        require(relay != address(0), "Set the Lasna enrollment relay address");
        address bound = watcher.factory();
        require(bound == address(0) || bound == source, "Different factory already bound");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        if (bound == address(0)) watcher.bindFactory(source);
        if (watcher.waitlistRelay() != relay) watcher.setWaitlistRelay(relay);
        vm.stopBroadcast();
        console2.log("Subscribed to Base Sepolia factory", source);
    }
}

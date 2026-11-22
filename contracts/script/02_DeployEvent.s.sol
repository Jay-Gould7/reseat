// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {EventWaitlist} from "../src/EventWaitlist.sol";

contract DeployEvent is Script {
    function run() external {
        require(block.chainid == 84532, "Select Base Sepolia");
        address watcher = vm.envAddress("VITE_REACTIVE_ADDRESS");
        address proxy = vm.envAddress("BASE_CALLBACK_PROXY");
        address token = vm.envAddress("BASE_USDC_ADDRESS");
        require(token == 0x036CbD53842c5426634e7929541eC2318f3dCF7e && token.code.length != 0, "Check USDC");
        require(proxy.code.length != 0 && watcher != address(0), "Check proxy and Lasna sender");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        EventWaitlist workshop = new EventWaitlist(proxy, watcher);
        vm.stopBroadcast();
        console2.log("VITE_EVENT_ADDRESS", address(workshop));
        console2.log("Opens at Unix timestamp", workshop.eventStartTime());
    }
}

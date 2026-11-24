// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {EventFactory} from "../src/EventFactory.sol";

contract DeployFactory is Script {
    function run() external {
        require(block.chainid == 84532, "Select Base Sepolia");
        address watcher = vm.envAddress("VITE_REACTIVE_ADDRESS");
        address proxy = vm.envAddress("BASE_CALLBACK_PROXY");
        address token = vm.envAddress("BASE_USDC_ADDRESS");
        require(token == 0x036CbD53842c5426634e7929541eC2318f3dCF7e && token.code.length != 0, "Check USDC");
        uint256 reserve = vm.envUint("BASE_EVENT_CALLBACK_WEI");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        EventFactory factory = new EventFactory(proxy, watcher, reserve);
        vm.stopBroadcast();
        console2.log("VITE_FACTORY_ADDRESS", address(factory));
    }
}

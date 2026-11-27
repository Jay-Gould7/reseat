// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Prints commands for a human operator. This step never broadcasts.
contract FundingCommands is Script {
    function run() external pure {
        console2.log("Lasna test REACT (example amount, Git Bash):");
        console2.log(
            'cast send --interactive --rpc-url "$LASNA_RPC_URL" 0x8888888888888888888888888888888888888888 "depositTo(address)" "$VITE_REACTIVE_ADDRESS" --value 1ether'
        );
        console2.log("Optional Base top-up: set EVENT_ADDRESS to the published event, then review the amount.");
        console2.log(
            'cast send --interactive --rpc-url "$BASE_SEPOLIA_RPC_URL" "$BASE_CALLBACK_PROXY" "depositTo(address)" "$EVENT_ADDRESS" --value 0.01ether'
        );
        console2.log("Fund the separate Lasna relay wallet for submitting guest signatures (example 0.1 test REACT):");
        console2.log('cast send --interactive --rpc-url "$LASNA_RPC_URL" "$WAITLIST_RELAY_ADDRESS" --value 0.1ether');
    }
}

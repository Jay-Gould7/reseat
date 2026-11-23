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
        console2.log("Base refund delivery: fund the shared factory on the callback proxy (example).");
        console2.log(
            'cast send --interactive --rpc-url "$BASE_SEPOLIA_RPC_URL" "$BASE_CALLBACK_PROXY" "depositTo(address)" "$VITE_FACTORY_ADDRESS" --value 0.001ether'
        );
        console2.log("Optional refundable event top-up from its organizer (new factory only):");
        console2.log(
            'cast send --interactive --rpc-url "$BASE_SEPOLIA_RPC_URL" "$EVENT_ADDRESS" "topUpFees()" --value 0.001ether'
        );
    }
}

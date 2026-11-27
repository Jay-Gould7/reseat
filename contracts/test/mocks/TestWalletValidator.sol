// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @dev An independent ERC-1271 fixture. Real Kernel bytecode is exercised on the Base fork.
contract TestWalletValidator {
    function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4) {
        if (
            sig.length == 65
                && ecrecover(digest, uint8(sig[64]), bytes32(sig[:32]), bytes32(sig[32:64])) == address(this)
        ) {
            return 0x1626ba7e;
        }
        return 0xffffffff;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface ISettlement {
    /// @dev Monotonic Base revision orders snapshots even across delayed or duplicate deliveries.
    event SettlementState(
        uint256 indexed revision, uint256 headId, uint256 headEffectiveDeadline, uint256 heldSpots, bool ready
    );
    function settle(address reactive_, uint256 expectedHeadId) external;
}

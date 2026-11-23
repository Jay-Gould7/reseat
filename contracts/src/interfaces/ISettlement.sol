// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

struct EventDetails {
    string name;
    string location;
    string description;
    string cover;
}

interface IEventDirectory {
    event EventCreated(address indexed eventAddress, address indexed organizer, uint256 announcedAt);
    event FeeRefundState(address indexed source, uint256 indexed revision, uint256 start, bool refunded);
    function reportFeeRefund() external;
    function finalizeFeeRefund(address reactive_, address source, uint256 issued) external;
    function confirmFailedDelivery(address reactive_, address source, uint256 deliveryId) external;
}

library PaymentRetries {
    uint8 internal constant LIMIT = 3;

    /// @dev Each delay starts at the previous attempt. A retry at the deadline would already be invalid.
    function nextAt(uint256 previous, uint8 used, uint256 deadline) internal pure returns (uint256) {
        if (used >= LIMIT) return 0;
        uint256 due = previous + (uint256(30 seconds) << used);
        return due < deadline ? due : 0;
    }
}

interface ISettlement {
    event SettlementState(
        uint256 indexed revision,
        uint256 headId,
        uint256 headEffectiveDeadline,
        uint256 heldSpots,
        bool ready,
        uint256 availableSpots,
        uint256 paymentRetryAt
    );
    function confirmBinding(address reactive_, uint256 deliveryId) external;
    function settle(address reactive_, uint256 expectedHeadId, uint256 deliveryId) external;
    function retryPayment(address reactive_, uint256 expectedHeadId, uint8 attempt, uint256 deliveryId) external;
}

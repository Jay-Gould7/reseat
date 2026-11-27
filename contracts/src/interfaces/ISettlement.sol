// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

struct EventDetails {
    string name;
    string location;
    string description;
    string cover;
}

struct SponsoredJoin {
    address buyer;
    uint32 qty;
    uint256 deadline;
    bytes32 salt;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct SponsoredCancel {
    uint256 orderId;
    uint256 validBefore;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

interface IEventDirectory {
    event EventCreated(address indexed eventAddress, address indexed organizer, uint256 announcedAt);
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
    function confirmBinding(address reactive_) external;
    function enqueueSponsored(address reactive_, SponsoredJoin calldata order) external returns (uint256);
    function cancelSponsored(address reactive_, SponsoredCancel calldata intent) external;
    function settle(address reactive_, uint256 expectedHeadId) external;
    function retryPayment(address reactive_, uint256 expectedHeadId, uint8 attempt) external;
}

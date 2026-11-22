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
}

interface ISettlement {
    event SettlementState(
        uint256 indexed revision,
        uint256 headId,
        uint256 headEffectiveDeadline,
        uint256 heldSpots,
        bool ready,
        uint256 availableSpots
    );
    function confirmBinding(address reactive_) external;
    function settle(address reactive_, uint256 expectedHeadId) external;
}

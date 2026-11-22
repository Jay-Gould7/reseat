// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @dev One contiguous grant per purchase. Minting a large group has constant storage and log cost.
abstract contract TicketBook {
    struct Grant {
        address buyer;
        uint256 first;
        uint32 qty;
    }
    Grant[] private grants;
    mapping(address => uint256[]) private walletGrants;
    mapping(address => uint256) public ticketBalance;
    mapping(uint256 => bool) private burned;
    uint256 private lastId;

    event TicketsIssued(uint256 indexed firstId, address indexed buyer, uint256 indexed orderId, uint32 qty);
    error NotTicketOwner();

    function _issueTickets(address buyer, uint32 qty, uint256 orderId) internal {
        uint256 first = lastId + 1;
        walletGrants[buyer].push(grants.length);
        grants.push(Grant(buyer, first, qty));
        lastId += qty;
        ticketBalance[buyer] += qty;
        emit TicketsIssued(first, buyer, orderId, qty);
    }

    function ticketOwner(uint256 id) public view returns (address) {
        if (id == 0 || id > lastId || burned[id]) return address(0);
        uint256 low;
        uint256 high = grants.length;
        while (low < high) {
            uint256 mid = low + (high - low) / 2;
            if (grants[mid].first > id) high = mid;
            else low = mid + 1;
        }
        return grants[low - 1].buyer;
    }

    function _burnTicket(uint256 id, address buyer) internal {
        if (ticketOwner(id) != buyer) revert NotTicketOwner();
        burned[id] = true;
        --ticketBalance[buyer];
    }

    /// @notice Cursor is (grant index, offset within grant). At most 32 IDs are examined per read.
    function ticketsPage(address buyer, uint256 grantIndex, uint32 offset)
        external
        view
        returns (uint256[] memory ids, uint256 nextGrant, uint32 nextOffset, bool more)
    {
        uint256[] storage list = walletGrants[buyer];
        ids = new uint256[](32);
        uint256 found;
        for (uint256 n; n < 32 && grantIndex < list.length; ++n) {
            Grant storage grant = grants[list[grantIndex]];
            require(offset < grant.qty, "Invalid ticket cursor");
            uint256 id = grant.first + offset;
            if (!burned[id]) ids[found++] = id;
            if (++offset == grant.qty) {
                ++grantIndex;
                offset = 0;
            }
        }
        assembly ("memory-safe") { mstore(ids, found) }
        return (ids, grantIndex, offset, grantIndex < list.length);
    }
}

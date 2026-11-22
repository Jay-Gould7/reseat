// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {EventWaitlist} from "./EventWaitlist.sol";
import {EventDetails, IEventDirectory} from "./interfaces/ISettlement.sol";

interface ICallbackReserves {
    function depositTo(address recipient) external payable;
}

contract EventFactory is IEventDirectory {
    address public immutable callbackProxy;
    address public immutable watcher;
    uint256 public immutable callbackDeposit;
    address[] public events;
    mapping(address => bool) public isEvent;
    mapping(address => uint256) public activationRetryAt;

    constructor(address proxy_, address watcher_, uint256 deposit_) {
        require(proxy_.code.length != 0 && watcher_ != address(0) && deposit_ > 0, "Invalid platform settings");
        callbackProxy = proxy_;
        watcher = watcher_;
        callbackDeposit = deposit_;
    }

    function eventCount() external view returns (uint256) {
        return events.length;
    }

    function createEvent(EventDetails calldata details, uint256 start, uint32 capacity, uint256 price)
        external
        payable
        returns (address source)
    {
        require(msg.value == callbackDeposit, "Incorrect callback reserve");
        source = address(new EventWaitlist(callbackProxy, watcher, msg.sender, details, start, capacity, price));
        events.push(source);
        isEvent[source] = true;
        ICallbackReserves(callbackProxy).depositTo{value: msg.value}(source);
        activationRetryAt[source] = block.timestamp + 5 minutes;
        emit EventCreated(source, msg.sender, block.timestamp);
    }

    /// @notice Recover a missed factory log or activation callback, including events published before platform setup.
    function retryActivation(address source) external {
        require(isEvent[source], "Unknown event");
        EventWaitlist target = EventWaitlist(payable(source));
        uint256 retryAt = activationRetryAt[source];
        require(
            msg.sender == target.organizer() && retryAt != 0 && block.timestamp < target.eventStartTime(),
            "Activation unavailable"
        );
        require(block.timestamp >= retryAt, "Activation cooling down");
        activationRetryAt[source] = target.automationReady() ? 0 : block.timestamp + 5 minutes;
        emit EventCreated(source, msg.sender, block.timestamp);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {EventWaitlist} from "./EventWaitlist.sol";
import {EventDetails, IEventDirectory} from "./interfaces/ISettlement.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";

contract EventFactory is IEventDirectory, AbstractCallback {
    uint256 public constant FEE_BUDGET_VERSION = 1;
    address public immutable callbackProxy;
    address public immutable watcher;
    uint256 public immutable callbackDeposit;
    address[] public events;
    mapping(address => bool) public isEvent;
    mapping(address => uint256) public activationRetryAt;
    mapping(address => uint256) public feeRevision;

    constructor(address proxy_, address watcher_, uint256 deposit_)
        AbstractCallback(IPayable(payable(proxy_)), watcher_)
    {
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
        source = address(
            new EventWaitlist{value: msg.value}(callbackProxy, watcher, msg.sender, details, start, capacity, price)
        );
        events.push(source);
        isEvent[source] = true;
        activationRetryAt[source] = block.timestamp + 5 minutes;
        emit EventCreated(source, msg.sender, block.timestamp);
        emit FeeRefundState(source, ++feeRevision[source], start, false);
    }

    function reportFeeRefund() external {
        require(isEvent[msg.sender], "Unknown event");
        EventWaitlist source = EventWaitlist(payable(msg.sender));
        emit FeeRefundState(msg.sender, ++feeRevision[msg.sender], source.eventStartTime(), source.feesRefunded());
    }

    /// @dev The proxy bills the factory for this last callback, after the event has returned its balance.
    function finalizeFeeRefund(address reactive_, address source, uint256 issued)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        require(isEvent[source], "Unknown event");
        EventWaitlist(payable(source)).finalizeFeeRefund(issued);
    }

    function coverDebt() external {
        _coverDebt();
    }

    function confirmFailedDelivery(address reactive_, address source, uint256 deliveryId)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        require(isEvent[source], "Unknown event");
        EventWaitlist(payable(source)).confirmFailedDelivery(deliveryId);
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

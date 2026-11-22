// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";

contract WaitlistReactive is AbstractReactive {
    uint256 public constant BASE_CHAIN_ID = 84532;
    // The Omni system manages subscriptions. This distinct protocol address emits CRON logs.
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 private immutable stateTopic = uint256(ISettlement.SettlementState.selector);
    uint256 private constant COOLDOWN = 15 seconds;

    address public immutable owner = msg.sender;
    address public eventContract;
    uint256 public latestRevision;
    bool public cronActive;
    uint256 public trackedHeadId;
    uint256 public trackedHeadDeadline;
    uint256 public lastCronRequestAt;

    event SourceBound(address indexed source);
    event CronChanged(bool active, uint256 headId, uint256 deadline);
    event SettlementRequested(uint256 indexed headId, bool fromCron, bytes32 indexed sourceTx);

    function bindEvent(address source) external {
        require(msg.sender == owner && eventContract == address(0) && source != address(0), "Invalid binding");
        eventContract = source;
        _subscription(true, BASE_CHAIN_ID, source, stateTopic);
        emit SourceBound(source);
    }

    function react(LogRecord memory log_) external override onlySystem {
        if (log_.chainId == block.chainid && log_.contractAddress == CRON_EMITTER && log_.topic0 == CRON10) {
            if (
                cronActive && block.timestamp >= trackedHeadDeadline
                    && (lastCronRequestAt == 0 || block.timestamp >= lastCronRequestAt + COOLDOWN)
            ) {
                lastCronRequestAt = block.timestamp;
                _request(trackedHeadId, true, bytes32(log_.txHash));
            }
            return;
        }
        if (
            eventContract == address(0) || log_.chainId != BASE_CHAIN_ID || log_.contractAddress != eventContract
                || log_.topic0 != stateTopic || log_.opCode != 2 || log_.topic1 <= latestRevision
        ) return;
        latestRevision = log_.topic1;
        (uint256 head, uint256 deadline, uint256 held, bool ready) =
            abi.decode(log_.data, (uint256, uint256, uint256, bool));
        bool track = held != 0;
        if (track != cronActive) {
            _subscription(track, block.chainid, CRON_EMITTER, CRON10);
            cronActive = track;
            emit CronChanged(track, track ? head : 0, track ? deadline : 0);
        } else if (track && head != trackedHeadId) {
            emit CronChanged(true, head, deadline);
        }
        trackedHeadId = track ? head : 0;
        trackedHeadDeadline = track ? deadline : 0;
        if (ready) _request(head, false, bytes32(log_.txHash));
    }

    function _subscription(bool add, uint256 chain, address emitter, uint256 topic) private {
        // Selecting only the operation keeps the six filter arguments identical in both directions.
        function(uint256, address, uint256, uint256, uint256, uint256) external operation =
            add ? SYSTEM.subscribe : SYSTEM.unsubscribe;
        operation(chain, emitter, topic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _request(uint256 head, bool fromCron, bytes32 sourceTx) private {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: BASE_CHAIN_ID,
                recipient: eventContract,
                gasLimit: 1200000,
                payload: abi.encodeCall(ISettlement.settle, (address(0), head))
            })
        );
        emit SettlementRequested(head, fromCron, sourceTx);
    }

    function coverDebt() external {
        _coverDebt();
    }
}

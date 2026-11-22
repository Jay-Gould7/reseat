// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {ISettlement, IEventDirectory} from "./interfaces/ISettlement.sol";

contract WaitlistReactive is AbstractReactive {
    uint256 public constant BASE_CHAIN_ID = 84532;
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 private immutable stateTopic = uint256(ISettlement.SettlementState.selector);
    uint256 private immutable creationTopic = uint256(IEventDirectory.EventCreated.selector);
    uint256 private constant EVENTS_PER_TICK = 4;

    struct Source {
        bool registered;
        uint256 revision;
        uint256 head;
        uint256 deadline;
        uint256 available;
        uint256 slot; // One-based position in the set of events waiting for a deadline.
        uint256 lastCronAt;
        uint256 lastAnnouncementAt;
    }
    address public immutable owner = msg.sender;
    address public factory;
    mapping(address => Source) private sources;
    address[] private tracked;
    uint256 private cursor;

    event SourceBound(address indexed source);
    event CronChanged(address indexed source, bool active, uint256 headId, uint256 deadline, bool subscriptionChanged);
    event SettlementRequested(address indexed source, uint256 indexed headId, bool fromCron, bytes32 indexed sourceTx);

    function bindFactory(address source) external {
        require(msg.sender == owner && factory == address(0) && source != address(0), "Invalid binding");
        factory = source;
        _subscription(true, BASE_CHAIN_ID, source, creationTopic);
    }

    function sourceState(address source) external view returns (Source memory) {
        return sources[source];
    }

    function cronActive() external view returns (bool) {
        return tracked.length != 0;
    }

    function react(LogRecord memory log_) external override onlySystem {
        if (log_.chainId == block.chainid && log_.contractAddress == CRON_EMITTER && log_.topic0 == CRON10) {
            _tick(bytes32(log_.txHash));
            return;
        }
        if (log_.chainId != BASE_CHAIN_ID || factory == address(0)) return;
        if (log_.contractAddress == factory && log_.topic0 == creationTopic && log_.opCode == 3) {
            _register(address(uint160(log_.topic1)), abi.decode(log_.data, (uint256)));
            return;
        }
        address source = log_.contractAddress;
        Source storage state = sources[source];
        if (!state.registered || log_.topic0 != stateTopic || log_.opCode != 2 || log_.topic1 <= state.revision) {
            return;
        }
        state.revision = log_.topic1;
        (uint256 head, uint256 deadline, uint256 held, bool ready, uint256 available) =
            abi.decode(log_.data, (uint256, uint256, uint256, bool, uint256));
        bool track = held != 0;
        bool tracking = state.slot != 0;
        if (track != tracking) _track(source, state, track);
        if (track != tracking || (track && head != state.head)) {
            bool subscriptionChanged = track != tracking && tracked.length == (track ? 1 : 0);
            emit CronChanged(source, track, head, deadline, subscriptionChanged);
        }
        state.head = head;
        state.deadline = deadline;
        state.available = available;
        if (ready) _settle(source, head, false, bytes32(log_.txHash));
    }

    function _register(address source, uint256 announcedAt) private {
        if (source == address(0)) return;
        Source storage state = sources[source];
        if (!state.registered) {
            state.registered = true;
            _subscription(true, BASE_CHAIN_ID, source, stateTopic);
            emit SourceBound(source);
        } else if (state.revision != 0 || announcedAt <= state.lastAnnouncementAt) {
            return;
        }
        state.lastAnnouncementAt = announcedAt;
        _request(source, abi.encodeCall(ISettlement.confirmBinding, (address(0))));
    }

    /// @notice Platform-funded recovery if multiple deliveries of the same snapshot were lost.
    function syncEvent(address source) external {
        require(msg.sender == owner && sources[source].registered, "Unknown or unauthorized source");
        _request(source, abi.encodeCall(ISettlement.confirmBinding, (address(0))));
    }

    function _track(address source, Source storage state, bool enable) private {
        if (enable) {
            if (tracked.length == 0) _subscription(true, block.chainid, CRON_EMITTER, CRON10);
            tracked.push(source);
            state.slot = tracked.length;
        } else {
            uint256 index = state.slot - 1;
            address last = tracked[tracked.length - 1];
            tracked[index] = last;
            sources[last].slot = index + 1;
            tracked.pop();
            state.slot = 0;
            if (tracked.length == 0) _subscription(false, block.chainid, CRON_EMITTER, CRON10);
            if (cursor >= tracked.length) cursor = 0;
        }
    }

    function _tick(bytes32 sourceTx) private {
        uint256 length = tracked.length;
        uint256 count = length < EVENTS_PER_TICK ? length : EVENTS_PER_TICK;
        for (uint256 i; i < count; ++i) {
            address source = tracked[cursor];
            cursor = (cursor + 1) % length;
            Source storage state = sources[source];
            if (
                block.timestamp >= state.deadline
                    && (state.lastCronAt == 0 || block.timestamp >= state.lastCronAt + 15 seconds)
            ) {
                state.lastCronAt = block.timestamp;
                _settle(source, state.head, true, sourceTx);
            }
        }
    }

    function _subscription(bool add, uint256 chain, address emitter, uint256 topic) private {
        function(uint256, address, uint256, uint256, uint256, uint256) external operation =
            add ? SYSTEM.subscribe : SYSTEM.unsubscribe;
        operation(chain, emitter, topic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _settle(address source, uint256 head, bool fromCron, bytes32 sourceTx) private {
        _request(source, abi.encodeCall(ISettlement.settle, (address(0), head)));
        emit SettlementRequested(source, head, fromCron, sourceTx);
    }

    function _request(address source, bytes memory payload) private {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: BASE_CHAIN_ID, recipient: source, gasLimit: 1200000, payload: payload
            })
        );
    }

    function coverDebt() external {
        _coverDebt();
    }
}

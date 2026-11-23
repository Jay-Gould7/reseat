// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {ISettlement, IEventDirectory, PaymentRetries} from "./interfaces/ISettlement.sol";

contract WaitlistReactive is AbstractReactive {
    uint256 public constant BASE_CHAIN_ID = 84532;
    address public constant CRON_EMITTER = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 public constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 public constant CRON10000 = 0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56;
    uint256 private immutable stateTopic = uint256(ISettlement.SettlementState.selector);
    uint256 private immutable creationTopic = uint256(IEventDirectory.EventCreated.selector);
    uint256 private constant FAILURE_TOPIC = uint256(keccak256("CallbackFailure(address,bytes)"));
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
        uint256 paymentRetryAt;
        uint256 lastPaymentAt;
        uint8 paymentAttempts;
    }
    address public immutable owner = msg.sender;
    address public factory;
    address public callbackProxy;
    mapping(address => Source) private sources;
    address[] private tracked;
    uint256 private cursor;

    struct FeeSchedule {
        uint256 revision;
        uint256 issued;
        uint256 due;
        uint256 slot;
        uint8 attempts;
        bool closing;
    }
    mapping(address => FeeSchedule) public feeSchedules;
    mapping(address => mapping(uint256 => bool)) public failedDeliveries;
    address[] private feeEvents; // Min-heap by next refund check. FeeSchedule.slot is one-based.
    uint256 public refundCronTopic;

    event SourceBound(address indexed source);
    event FeeRefundRequested(address indexed source, uint256 issued);
    event CronChanged(address indexed source, bool active, uint256 headId, uint256 deadline, bool subscriptionChanged);
    event SettlementRequested(
        address indexed source, uint256 indexed headId, bool fromCron, bytes32 indexed sourceTx, uint8 paymentAttempt
    );

    function bindFactory(address source, address proxy) external {
        require(
            msg.sender == owner && factory == address(0) && source != address(0) && proxy != address(0),
            "Invalid binding"
        );
        factory = source;
        callbackProxy = proxy;
        _subscription(true, BASE_CHAIN_ID, source, creationTopic);
        _subscription(true, BASE_CHAIN_ID, source, uint256(IEventDirectory.FeeRefundState.selector));
    }

    function sourceState(address source) external view returns (Source memory) {
        return sources[source];
    }

    function cronActive() external view returns (bool) {
        return tracked.length != 0;
    }

    function refundCronActive() external view returns (bool) {
        return feeEvents.length != 0;
    }

    function react(LogRecord memory log_) external override onlySystem {
        if (
            log_.chainId == block.chainid && log_.contractAddress == CRON_EMITTER && refundCronTopic != 0
                && log_.topic0 == refundCronTopic
        ) {
            _refundTick();
            return;
        }
        if (log_.chainId == block.chainid && log_.contractAddress == CRON_EMITTER && log_.topic0 == CRON10) {
            _tick(bytes32(log_.txHash));
            return;
        }
        if (log_.chainId != BASE_CHAIN_ID || factory == address(0)) return;
        if (log_.contractAddress == callbackProxy && log_.topic0 == FAILURE_TOPIC && log_.opCode == 2) {
            _confirmFailure(address(uint160(log_.topic1)), log_.data);
            return;
        }
        if (
            log_.contractAddress == factory && log_.topic0 == uint256(IEventDirectory.FeeRefundState.selector)
                && log_.opCode == 3
        ) {
            (uint256 start, bool paid) = abi.decode(log_.data, (uint256, bool));
            _scheduleFees(address(uint160(log_.topic1)), log_.topic2, start, paid);
            return;
        }
        if (log_.contractAddress == factory && log_.topic0 == creationTopic && log_.opCode == 3) {
            _register(address(uint160(log_.topic1)), abi.decode(log_.data, (uint256)));
            return;
        }
        address source = log_.contractAddress;
        Source storage state = sources[source];
        if (
            feeSchedules[source].closing || !state.registered || log_.topic0 != stateTopic || log_.opCode != 2
                || log_.topic1 <= state.revision
        ) {
            return;
        }
        state.revision = log_.topic1;
        (uint256 head, uint256 deadline, uint256 held, bool ready, uint256 available, uint256 baseRetryAt) =
            abi.decode(log_.data, (uint256, uint256, uint256, bool, uint256, uint256));
        bool track = held != 0;
        bool tracking = state.slot != 0;
        if (track != tracking) _track(source, state, track);
        if (track != tracking || (track && head != state.head)) {
            bool subscriptionChanged = track != tracking && tracked.length == (track ? 1 : 0);
            emit CronChanged(source, track, head, deadline, subscriptionChanged);
        }
        if (state.head != head) {
            state.paymentAttempts = 0;
            state.lastPaymentAt = 0;
        }
        // New reports for the same head cannot shorten the backoff or refill its dispatch budget.
        uint256 earliest = PaymentRetries.nextAt(state.lastPaymentAt, state.paymentAttempts, deadline);
        state.paymentRetryAt = baseRetryAt == 0 || earliest == 0 ? 0 : (baseRetryAt > earliest ? baseRetryAt : earliest);
        state.head = head;
        state.deadline = deadline;
        state.available = available;
        if (ready) _settle(source, head, false, bytes32(log_.txHash), 0);
    }

    function _register(address source, uint256 announcedAt) private {
        if (source == address(0) || feeSchedules[source].closing) return;
        Source storage state = sources[source];
        if (!state.registered) {
            state.registered = true;
            _subscription(true, BASE_CHAIN_ID, source, stateTopic);
            _failureSubscription(source, true);
            emit SourceBound(source);
        } else if (state.revision != 0 || announcedAt <= state.lastAnnouncementAt) {
            return;
        }
        state.lastAnnouncementAt = announcedAt;
        _request(source, abi.encodeCall(ISettlement.confirmBinding, (address(0), ++feeSchedules[source].issued)));
    }

    /// @notice Platform-funded recovery if multiple deliveries of the same snapshot were lost.
    function syncEvent(address source) external {
        require(
            msg.sender == owner && sources[source].registered && !feeSchedules[source].closing,
            "Unknown or unauthorized source"
        );
        _request(source, abi.encodeCall(ISettlement.confirmBinding, (address(0), ++feeSchedules[source].issued)));
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
                _settle(source, state.head, true, sourceTx, 0);
            } else if (
                block.timestamp < state.deadline && state.paymentRetryAt != 0 && block.timestamp >= state.paymentRetryAt
            ) {
                uint8 attempt = ++state.paymentAttempts;
                state.lastPaymentAt = block.timestamp;
                state.paymentRetryAt = PaymentRetries.nextAt(block.timestamp, attempt, state.deadline);
                _settle(source, state.head, true, sourceTx, attempt);
            }
        }
    }

    function _subscription(bool add, uint256 chain, address emitter, uint256 topic) private {
        _subscription(add, chain, emitter, topic, REACTIVE_IGNORE);
    }

    function _subscription(bool add, uint256 chain, address emitter, uint256 topic, uint256 topic1) private {
        function(uint256, address, uint256, uint256, uint256, uint256) external operation =
            add ? SYSTEM.subscribe : SYSTEM.unsubscribe;
        operation(chain, emitter, topic, topic1, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _failureSubscription(address source, bool add) private {
        _subscription(add, BASE_CHAIN_ID, callbackProxy, FAILURE_TOPIC, uint256(uint160(source)));
    }

    // A reverted target cannot record its own delivery. The Base proxy logs the injected payload before billing it.
    function _confirmFailure(address source, bytes memory data) private {
        if (!sources[source].registered || data.length < 160 || data.length > 224) return;
        bytes memory payload = abi.decode(data, (bytes));
        if (payload.length < 68) return;
        bytes4 selector;
        address sender;
        uint256 id;
        assembly ("memory-safe") {
            selector := mload(add(payload, 32))
            sender := mload(add(payload, 36))
            id := mload(add(payload, mload(payload)))
        }
        bool recognized = (selector == ISettlement.confirmBinding.selector && payload.length == 68)
            || (selector == ISettlement.settle.selector && payload.length == 100)
            || (selector == ISettlement.retryPayment.selector && payload.length == 132);
        if (
            !recognized || sender != address(this) || id == 0 || id > feeSchedules[source].issued
                || failedDeliveries[source][id]
        ) return;
        failedDeliveries[source][id] = true;
        _reportFailure(source, id);
    }

    function retryFailureReport(address source, uint256 id) external {
        require(msg.sender == owner && failedDeliveries[source][id], "Unknown or unauthorized failure");
        _reportFailure(source, id);
    }

    function _reportFailure(address source, uint256 id) private {
        _request(factory, abi.encodeCall(IEventDirectory.confirmFailedDelivery, (address(0), source, id)));
    }

    function _settle(address source, uint256 head, bool fromCron, bytes32 sourceTx, uint8 attempt) private {
        uint256 id = ++feeSchedules[source].issued;
        bytes memory payload = attempt == 0
            ? abi.encodeCall(ISettlement.settle, (address(0), head, id))
            : abi.encodeCall(ISettlement.retryPayment, (address(0), head, attempt, id));
        _request(source, payload);
        emit SettlementRequested(source, head, fromCron, sourceTx, attempt);
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

    function _scheduleFees(address source, uint256 version, uint256 start, bool paid) private {
        FeeSchedule storage f = feeSchedules[source];
        if (version <= f.revision) return;
        f.revision = version;
        if (paid) {
            if (f.slot != 0) _removeFeeEvent(f);
            if (sources[source].registered) _failureSubscription(source, false);
        } else {
            f.due = start;
            f.attempts = 0;
            if (f.slot == 0) {
                feeEvents.push(source);
                f.slot = feeEvents.length;
            }
            _orderFeeEvent(source);
        }
        _updateRefundClock();
    }

    function _removeFeeEvent(FeeSchedule storage f) private {
        uint256 index = f.slot - 1;
        address last = feeEvents[feeEvents.length - 1];
        feeEvents[index] = last;
        feeSchedules[last].slot = index + 1;
        feeEvents.pop();
        f.slot = 0;
        if (index < feeEvents.length) _orderFeeEvent(last);
    }

    function _orderFeeEvent(address source) private {
        FeeSchedule storage f = feeSchedules[source];
        uint256 i = f.slot - 1;
        while (i > 0) {
            uint256 parent = (i - 1) / 2;
            address above = feeEvents[parent];
            if (feeSchedules[above].due <= f.due) break;
            feeEvents[i] = above;
            feeSchedules[above].slot = i + 1;
            i = parent;
        }
        while (2 * i + 1 < feeEvents.length) {
            uint256 child = 2 * i + 1;
            if (
                child + 1 < feeEvents.length
                    && feeSchedules[feeEvents[child + 1]].due < feeSchedules[feeEvents[child]].due
            ) ++child;
            address below = feeEvents[child];
            if (feeSchedules[below].due >= f.due) break;
            feeEvents[i] = below;
            feeSchedules[below].slot = i + 1;
            i = child;
        }
        feeEvents[i] = source;
        f.slot = i + 1;
    }

    function _updateRefundClock() private {
        uint256 next;
        if (feeEvents.length != 0) {
            next = feeSchedules[feeEvents[0]].due > block.timestamp + 4 hours ? CRON10000 : CRON100;
        }
        if (next == refundCronTopic) return;
        if (refundCronTopic != 0) _subscription(false, block.chainid, CRON_EMITTER, refundCronTopic);
        if (next != 0) _subscription(true, block.chainid, CRON_EMITTER, next);
        refundCronTopic = next;
    }

    function _refundTick() private {
        for (uint256 i; i < EVENTS_PER_TICK && feeEvents.length != 0; ++i) {
            address source = feeEvents[0];
            FeeSchedule storage f = feeSchedules[source];
            if (block.timestamp < f.due) break;
            if (!f.closing) {
                f.closing = true;
                if (sources[source].registered) _subscription(false, BASE_CHAIN_ID, source, stateTopic);
                Source storage state = sources[source];
                if (state.slot != 0) {
                    _track(source, state, false);
                    emit CronChanged(source, false, state.head, state.deadline, tracked.length == 0);
                }
            }
            // A different recipient pays this callback. Its post-execution fee cannot create debt on the refunded event.
            _request(factory, abi.encodeCall(IEventDirectory.finalizeFeeRefund, (address(0), source, f.issued)));
            emit FeeRefundRequested(source, f.issued);
            f.due = block.timestamp + 5 minutes;
            if (++f.attempts == 3) _removeFeeEvent(f);
            else _orderFeeEvent(source);
        }
        _updateRefundClock();
    }
}

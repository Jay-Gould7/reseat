// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {ISettlement, IEventDirectory, EventDetails, PaymentRetries} from "./interfaces/ISettlement.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";
import {TicketBook} from "./TicketBook.sol";

contract EventWaitlist is AbstractCallback, ISettlement, TicketBook {
    IUSDC public constant usdc = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    uint256 public constant BATCH_LIMIT = 5;
    bytes32 private constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    enum Status {
        None,
        Queued,
        Issued,
        Expired,
        Cancelled,
        PaymentFailed
    }
    enum Step {
        Hold,
        Fill,
        Expire,
        Cancelled,
        PersonalFailure,
        Unavailable
    }
    enum Report {
        Changed,
        Retry,
        Echo
    }

    struct Signature {
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Order {
        address buyer;
        uint32 qty;
        Status status;
        uint8 lastPaymentAttempt;
        uint256 deadline;
        uint256 paymentRetryAt;
        Signature auth;
    }

    address public immutable factory;
    address public immutable organizer;
    uint256 public immutable eventStartTime;
    uint32 public immutable capacity;
    uint256 public immutable ticketPrice;
    EventDetails private metadata;
    bool public automationReady;
    uint256 public availableSpots;
    uint256 public retainedProceeds;
    uint256 public headId = 1;
    uint256 public nextId = 1;
    uint256 public activeOrders;
    uint256 public revision;
    uint256 public deferredHead;
    bytes32 private lastReport;
    mapping(bytes32 => bool) private retried;
    mapping(uint256 => Order) private orders;
    mapping(address => mapping(bytes32 => bool)) public nonceRegistered;
    mapping(uint256 => bool) private delivered;
    uint256 public deliveredCallbacks;
    uint256 public expectedCallbacks;
    bool public feeCloseConfirmed;
    bool public feesRefunded;
    uint256 public returnedFees;
    address payable public feeRecipient;
    uint256 public nextFeeRetry;

    event BindingConfirmed(address indexed watcher);
    event TicketRefunded(uint256 indexed ticketId, address indexed buyer, uint256 amount);
    event Queued(uint256 indexed id, address indexed buyer, uint32 qty, uint256 deadline);
    event OrderResolved(uint256 indexed id, Status status);
    event PaymentDeferred(uint256 indexed id);
    event ProceedsWithdrawn(address indexed organizer, uint256 amount);
    event FeeBudgetFunded(address indexed organizer, uint256 amount);
    event FeeBudgetReturned(address indexed recipient, uint256 amount);

    error EventStarted();
    error InvalidQuantity();
    error SalesAvailable();
    error SeatsUnavailable();
    error InvalidAuthorization();
    error NotOrderOwner();
    error NotQueued();
    error WithdrawalUnavailable();
    error TokenTransferFailed();
    error RetryUnavailable();
    error BindingPending();

    constructor(
        address callbackProxy_,
        address callbackSender_,
        address organizer_,
        EventDetails memory details_,
        uint256 start_,
        uint32 capacity_,
        uint256 price_
    ) payable AbstractCallback(IPayable(payable(callbackProxy_)), callbackSender_) {
        require(
            callbackProxy_ != address(0) && callbackSender_ != address(0) && organizer_ != address(0), "Missing address"
        );
        require(
            bytes(details_.name).length != 0 && start_ > block.timestamp && capacity_ > 0 && price_ > 0
                && price_ <= type(uint256).max / capacity_,
            "Invalid event terms"
        );
        factory = msg.sender;
        organizer = organizer_;
        feeRecipient = payable(organizer_);
        metadata = details_;
        eventStartTime = start_;
        capacity = capacity_;
        availableSpots = capacity_;
        ticketPrice = price_;
    }

    function details() external view returns (EventDetails memory) {
        return metadata;
    }

    // The watcher numbers each normal request per event. An out-of-order or repeated delivery counts once.
    modifier recordDelivery(uint256 id) {
        require(id != 0, "Missing delivery ID");
        _recordDelivery(id);
        if (!feeCloseConfirmed) _;
    }

    function _recordDelivery(uint256 id) private {
        if (delivered[id]) return;
        delivered[id] = true;
        ++deliveredCallbacks;
        if (feeCloseConfirmed && deliveredCallbacks == expectedCallbacks && !feesRefunded) _reportFees();
    }

    function confirmFailedDelivery(uint256 id) external {
        require(msg.sender == factory, "Factory only");
        _recordDelivery(id);
    }

    function confirmBinding(address reactive_, uint256 deliveryId)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
        recordDelivery(deliveryId)
    {
        if (!automationReady) {
            automationReady = true;
            emit BindingConfirmed(reactive_);
        } else {
            deferredHead = 0;
        }
        _report(Report.Retry);
    }

    function orderInfo(uint256 id) external view returns (address buyer, uint32 qty, uint256 deadline, Status status) {
        Order storage order = orders[id];
        return (order.buyer, order.qty, order.deadline, order.status);
    }

    function publicSpots() public view returns (uint256) {
        return activeOrders == 0 && block.timestamp < eventStartTime ? availableSpots : 0;
    }

    function buy(uint32 qty) external {
        if (block.timestamp >= eventStartTime) revert EventStarted();
        if (qty == 0) revert InvalidQuantity();
        if (qty > publicSpots()) revert SeatsUnavailable();
        if (!usdc.transferFrom(msg.sender, address(this), qty * ticketPrice)) revert TokenTransferFailed();
        _issue(msg.sender, qty, 0);
    }

    function refund(uint256 ticketId) external {
        if (block.timestamp >= eventStartTime) revert EventStarted();
        _burnTicket(ticketId, msg.sender);
        ++availableSpots;
        retainedProceeds -= ticketPrice;
        if (!usdc.transfer(msg.sender, ticketPrice)) revert TokenTransferFailed();
        emit TicketRefunded(ticketId, msg.sender, ticketPrice);
        if (activeOrders != 0) _report(Report.Changed);
    }

    function enqueue(uint32 qty, uint256 userDeadline, Signature calldata auth) external returns (uint256 id) {
        if (!automationReady) revert BindingPending();
        if (block.timestamp >= eventStartTime) revert EventStarted();
        if (qty == 0 || qty > capacity) revert InvalidQuantity();
        if (publicSpots() != 0) revert SalesAvailable();
        uint256 deadline = userDeadline < eventStartTime ? userDeadline : eventStartTime;
        if (
            deadline <= block.timestamp || nonceRegistered[msg.sender][auth.nonce]
                || usdc.authorizationState(msg.sender, auth.nonce)
        ) revert InvalidAuthorization();
        bytes32 body = keccak256(
            abi.encode(RECEIVE_TYPEHASH, msg.sender, address(this), qty * ticketPrice, uint256(0), deadline, auth.nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", usdc.DOMAIN_SEPARATOR(), body));
        if (
            uint256(auth.s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
                || ecrecover(digest, auth.v, auth.r, auth.s) != msg.sender
        ) revert InvalidAuthorization();
        nonceRegistered[msg.sender][auth.nonce] = true;
        id = nextId++;
        orders[id] = Order(msg.sender, qty, Status.Queued, 0, deadline, 0, auth);
        ++activeOrders;
        emit Queued(id, msg.sender, qty, deadline);
    }

    function cancel(uint256 id) external {
        Order storage order = orders[id];
        if (order.buyer != msg.sender) revert NotOrderOwner();
        if (order.status != Status.Queued) revert NotQueued();
        _resolve(id, Status.Cancelled);
        if (activeOrders == 0) headId = nextId;
        if (availableSpots != 0 && (id == headId || activeOrders == 0)) _report(Report.Changed);
    }

    /// @dev Classify by independently observable facts. A token-wide outage or unreadable token keeps priority.
    function _step(Order storage order) private view returns (Step) {
        if (order.status == Status.Cancelled) return Step.Cancelled;
        if (block.timestamp >= order.deadline) return Step.Expire;
        try usdc.authorizationState(order.buyer, order.auth.nonce) returns (bool spent) {
            if (spent) return Step.PersonalFailure;
        } catch {
            return Step.Unavailable;
        }
        try usdc.balanceOf(order.buyer) returns (uint256 balance) {
            if (balance < order.qty * ticketPrice) return Step.PersonalFailure;
        } catch {
            return Step.Unavailable;
        }
        if (availableSpots < order.qty) return Step.Hold;
        try usdc.paused() returns (bool paused) {
            return paused ? Step.Unavailable : Step.Fill;
        } catch {
            return Step.Unavailable;
        }
    }

    function settlementState()
        public
        view
        returns (uint256 head, uint256 deadline, uint256 heldSpots, bool ready, bool paymentBlocked)
    {
        if (headId >= nextId || availableSpots == 0) return (0, 0, 0, false, false);
        Order storage order = orders[headId];
        Step step = _step(order);
        bool unavailable = step == Step.Unavailable;
        paymentBlocked = (unavailable && availableSpots >= order.qty) || (step == Step.Fill && deferredHead == headId);
        ready = step != Step.Hold && !unavailable && !paymentBlocked;
        return (
            headId,
            order.deadline,
            ready ? 0 : (availableSpots < order.qty ? availableSpots : order.qty),
            ready,
            paymentBlocked
        );
    }

    function settle(address reactive_, uint256 expectedHeadId, uint256 deliveryId)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
        recordDelivery(deliveryId)
    {
        _settle(expectedHeadId);
    }

    function retryPayment(address reactive_, uint256 expectedHeadId, uint8 attempt, uint256 deliveryId)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
        recordDelivery(deliveryId)
    {
        Order storage order = orders[expectedHeadId];
        if (
            expectedHeadId != headId || deferredHead != headId || order.status != Status.Queued
                || availableSpots < order.qty || order.paymentRetryAt == 0 || attempt <= order.lastPaymentAttempt
                || attempt > PaymentRetries.LIMIT
        ) {
            _report(Report.Echo);
            return;
        }
        if (block.timestamp < order.paymentRetryAt) return;
        if (block.timestamp < order.deadline) {
            // Consume this delivery before entering the same payment checks as a normal settlement.
            order.lastPaymentAttempt = attempt;
            order.paymentRetryAt = 0;
            deferredHead = 0;
        }
        _settle(expectedHeadId);
    }

    function _settle(uint256 expectedHeadId) private {
        if (!automationReady) revert BindingPending();
        if (headId != expectedHeadId || headId >= nextId || availableSpots == 0) {
            _report(Report.Echo); // An old CRON can repair a missed terminal state. Lasna discards duplicate revisions.
            return;
        }
        for (uint256 i; i < BATCH_LIMIT && headId < nextId && availableSpots != 0; ++i) {
            Order storage order = orders[headId];
            Step step = _step(order);
            if (step == Step.Hold || step == Step.Unavailable) break;
            if (step == Step.Expire) {
                _resolve(headId, Status.Expired);
            } else if (step == Step.PersonalFailure) {
                _resolve(headId, Status.PaymentFailed);
            } else if (step == Step.Fill) {
                if (deferredHead == headId || !_chargeAndIssue(headId, order)) break;
            }
            // Cancelled entries already published their outcome and released their active count.
            ++headId;
        }
        if (activeOrders == 0) headId = nextId;
        _report(Report.Changed);
    }

    function _chargeAndIssue(uint256 id, Order storage order) private returns (bool) {
        Signature storage sig = order.auth;
        try usdc.receiveWithAuthorization(
            order.buyer, address(this), order.qty * ticketPrice, 0, order.deadline, sig.nonce, sig.v, sig.r, sig.s
        ) {
            _issue(order.buyer, order.qty, id);
            _resolve(id, Status.Issued);
            return true;
        } catch {
            deferredHead = id;
            emit PaymentDeferred(id);
            return false;
        }
    }

    function _issue(address buyer, uint32 qty, uint256 orderId) private {
        availableSpots -= qty;
        retainedProceeds += qty * ticketPrice;
        _issueTickets(buyer, qty, orderId);
    }

    function _resolve(uint256 id, Status status) private {
        if (deferredHead == id) deferredHead = 0;
        orders[id].paymentRetryAt = 0;
        orders[id].status = status;
        --activeOrders;
        emit OrderResolved(id, status);
    }

    function _report(Report mode) private {
        (uint256 head, uint256 deadline, uint256 held, bool ready, bool blocked) = settlementState();
        uint256 retryAt;
        if (head != 0) {
            Order storage order = orders[head];
            if (blocked) {
                deferredHead = head;
                if (order.paymentRetryAt == 0) {
                    order.paymentRetryAt = PaymentRetries.nextAt(block.timestamp, order.lastPaymentAttempt, deadline);
                }
                retryAt = order.paymentRetryAt;
            } else {
                order.paymentRetryAt = 0;
            }
        }
        bytes32 snapshot = keccak256(abi.encode(head, deadline, held, ready, blocked, availableSpots, retryAt));
        if (snapshot != lastReport || mode == Report.Retry) {
            lastReport = snapshot;
            ++revision;
        } else if (mode == Report.Changed) {
            return;
        }
        emit SettlementState(revision, head, deadline, held, ready, availableSpots, retryAt);
    }

    function _retryState() private view returns (bytes32 key, Step step, bool allowed) {
        if (availableSpots == 0 || headId >= nextId || activeOrders == 0) return (0, Step.Hold, false);
        step = _step(orders[headId]);
        key = keccak256(
            abi.encode(headId, availableSpots, step, deferredHead == headId, orders[headId].lastPaymentAttempt)
        );
        allowed = !retried[key];
    }

    function canRetrySettlement() external view returns (bool allowed) {
        (,, allowed) = _retryState();
    }

    function requestSettlementRetry() external {
        (bytes32 key, Step step, bool allowed) = _retryState();
        if (!allowed) revert RetryUnavailable();
        retried[key] = true;
        if (step == Step.Fill) deferredHead = 0;
        _report(Report.Retry);
    }

    function coverDebt() external {
        _coverDebt();
    }

    function topUpFees() public payable {
        require(msg.sender == organizer && !feesRefunded && msg.value != 0, "Funding unavailable");
        uint256 debt = _SERVICE_PROVIDER.debt(address(this));
        if (debt != 0 && address(this).balance >= debt) _coverDebt();
        emit FeeBudgetFunded(msg.sender, msg.value);
        if (block.timestamp >= eventStartTime && block.timestamp >= nextFeeRetry) _reportFees();
    }

    receive() external payable override {
        topUpFees();
    }

    /// @notice Allows a contract organizer to choose a wallet that can receive native ETH.
    function setFeeRecipient(address payable recipient) external {
        require(msg.sender == organizer && recipient != address(0) && !feesRefunded, "Recipient unavailable");
        feeRecipient = recipient;
    }

    /// @notice Fallback for a lost network message or a recipient that previously rejected ETH.
    function retryFeeRefund() external {
        require(
            msg.sender == organizer && !feesRefunded && block.timestamp >= eventStartTime
                && block.timestamp >= nextFeeRetry,
            "Refund retry unavailable"
        );
        _reportFees();
    }

    function _reportFees() private {
        nextFeeRetry = block.timestamp + 5 minutes;
        IEventDirectory(factory).reportFeeRefund();
    }

    function finalizeFeeRefund(uint256 issued) external {
        require(msg.sender == factory, "Factory only");
        if (feesRefunded || block.timestamp < eventStartTime) return;
        feeCloseConfirmed = true;
        expectedCallbacks = issued;
        if (deliveredCallbacks != issued) return;
        uint256 debt = _SERVICE_PROVIDER.debt(address(this));
        if (debt > address(this).balance) return;
        if (debt != 0) _coverDebt();
        uint256 unused = address(this).balance;
        feesRefunded = true;
        if (unused != 0) {
            (bool ok,) = feeRecipient.call{value: unused, gas: 60000}("");
            if (!ok) {
                feesRefunded = false;
                return;
            }
        }
        returnedFees = unused;
        emit FeeBudgetReturned(feeRecipient, unused);
        IEventDirectory(factory).reportFeeRefund();
    }

    function withdrawProceeds() external {
        uint256 amount = retainedProceeds;
        if (msg.sender != organizer || block.timestamp < eventStartTime || amount == 0) revert WithdrawalUnavailable();
        retainedProceeds = 0;
        if (!usdc.transfer(organizer, amount)) revert TokenTransferFailed();
        emit ProceedsWithdrawn(organizer, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";
import {IUSDC} from "./interfaces/IUSDC.sol";

/// @notice A two-seat workshop. Admissions are individually numbered and bound to their buyer.
contract EventWaitlist is AbstractCallback, ISettlement {
    IUSDC public constant usdc = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    uint256 public constant capacity = 2;
    uint256 public constant ticketPrice = 20e6;
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

    struct Signature {
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Order {
        address buyer;
        uint8 qty;
        Status status;
        uint256 deadline;
        Signature auth;
    }

    address public immutable organizer;
    uint256 public immutable eventStartTime;
    uint256 public availableSpots = capacity;
    uint256 public retainedProceeds;
    uint256 public headId = 1;
    uint256 public nextId = 1;
    uint256 public activeOrders;
    uint256 public revision;
    uint256 public lastRetryAt;
    uint256 private lastTicketId;

    mapping(uint256 => Order) private orders;
    mapping(address => mapping(bytes32 => bool)) public nonceRegistered;
    mapping(uint256 => address) public ticketOwner;
    mapping(address => uint256[]) private walletTickets;

    event TicketIssued(uint256 indexed ticketId, address indexed buyer, uint256 indexed orderId);
    event TicketRefunded(uint256 indexed ticketId, address indexed buyer, uint256 amount);
    event Queued(uint256 indexed id, address indexed buyer, uint8 qty, uint256 deadline);
    event OrderResolved(uint256 indexed id, Status status);
    event ProceedsWithdrawn(address indexed organizer, uint256 amount);

    error EventStarted();
    error InvalidQuantity();
    error SalesAvailable();
    error SeatsUnavailable();
    error InvalidAuthorization();
    error NotTicketOwner();
    error NotOrderOwner();
    error NotQueued();
    error WithdrawalUnavailable();
    error TokenTransferFailed();
    error RetryCoolingDown();

    constructor(address callbackProxy_, address callbackSender_)
        AbstractCallback(IPayable(payable(callbackProxy_)), callbackSender_)
    {
        require(callbackProxy_ != address(0) && callbackSender_ != address(0), "Missing callback address");
        organizer = msg.sender;
        eventStartTime = block.timestamp + 7 days;
    }

    function ticketsOf(address buyer) external view returns (uint256[] memory) {
        return walletTickets[buyer];
    }

    function orderInfo(uint256 id) external view returns (address buyer, uint8 qty, uint256 deadline, Status status) {
        Order storage order = orders[id];
        return (order.buyer, order.qty, order.deadline, order.status);
    }

    function publicSpots() public view returns (uint256) {
        return activeOrders == 0 && block.timestamp < eventStartTime ? availableSpots : 0;
    }

    function buy(uint8 qty) external {
        if (block.timestamp >= eventStartTime) revert EventStarted();
        if (qty == 0) revert InvalidQuantity();
        if (qty > publicSpots()) revert SeatsUnavailable();
        if (!usdc.transferFrom(msg.sender, address(this), qty * ticketPrice)) revert TokenTransferFailed();
        _issue(msg.sender, qty, 0);
    }

    function refund(uint256 ticketId) external {
        if (block.timestamp >= eventStartTime) revert EventStarted();
        if (ticketOwner[ticketId] != msg.sender) revert NotTicketOwner();
        delete ticketOwner[ticketId];
        uint256[] storage owned = walletTickets[msg.sender];
        // A wallet holds at most capacity tickets.
        for (uint256 i; i < owned.length; ++i) {
            if (owned[i] == ticketId) {
                owned[i] = owned[owned.length - 1];
                owned.pop();
                break;
            }
        }
        ++availableSpots;
        retainedProceeds -= ticketPrice;
        if (!usdc.transfer(msg.sender, ticketPrice)) revert TokenTransferFailed();
        emit TicketRefunded(ticketId, msg.sender, ticketPrice);
        if (activeOrders != 0) _publishState();
    }

    function enqueue(uint8 qty, uint256 userDeadline, Signature calldata auth) external returns (uint256 id) {
        if (block.timestamp >= eventStartTime) revert EventStarted();
        if (qty == 0 || qty > capacity) revert InvalidQuantity();
        if (publicSpots() != 0) revert SalesAvailable();
        uint256 deadline = userDeadline < eventStartTime ? userDeadline : eventStartTime;
        if (deadline <= block.timestamp || nonceRegistered[msg.sender][auth.nonce]) revert InvalidAuthorization();
        bytes32 body = keccak256(
            abi.encode(RECEIVE_TYPEHASH, msg.sender, address(this), qty * ticketPrice, uint256(0), deadline, auth.nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", usdc.DOMAIN_SEPARATOR(), body));
        if (ecrecover(digest, auth.v, auth.r, auth.s) != msg.sender) revert InvalidAuthorization();
        nonceRegistered[msg.sender][auth.nonce] = true;
        id = nextId++;
        orders[id] = Order(msg.sender, qty, Status.Queued, deadline, auth);
        ++activeOrders;
        emit Queued(id, msg.sender, qty, deadline);
    }

    function cancel(uint256 id) external {
        Order storage order = orders[id];
        if (order.buyer != msg.sender) revert NotOrderOwner();
        if (order.status != Status.Queued) revert NotQueued();
        _resolve(id, Status.Cancelled);
        // If everyone cancelled, subsequent purchases need no callback.
        if (activeOrders == 0) headId = nextId;
        if (availableSpots != 0 && (id == headId || activeOrders == 0)) _publishState();
    }

    function settlementState() public view returns (uint256 head, uint256 deadline, uint256 heldSpots, bool ready) {
        if (headId >= nextId || availableSpots == 0) return (0, 0, 0, false);
        Order storage first = orders[headId];
        ready = first.status == Status.Cancelled || block.timestamp >= first.deadline || availableSpots >= first.qty;
        return (headId, first.deadline, ready ? 0 : availableSpots, ready);
    }

    function settle(address reactive_, uint256 expectedHeadId)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        (uint256 current,,, bool ready) = settlementState();
        // Covers replay, an old head, and Lasna reaching a deadline ahead of Base.
        if (!ready || current != expectedHeadId) return;
        for (uint256 i; i < BATCH_LIMIT && headId < nextId && availableSpots != 0; ++i) {
            Order storage order = orders[headId];
            if (order.status == Status.Cancelled) {
                // The cancellation already emitted its reason and decremented activeOrders.
            } else if (block.timestamp >= order.deadline) {
                _resolve(headId, Status.Expired);
            } else if (availableSpots < order.qty) {
                break;
            } else {
                _chargeAndIssue(headId, order);
            }
            ++headId;
        }
        if (activeOrders == 0) headId = nextId;
        _publishState();
    }

    function _chargeAndIssue(uint256 id, Order storage order) private {
        uint256 amount = order.qty * ticketPrice;
        if (usdc.balanceOf(order.buyer) < amount) {
            _resolve(id, Status.PaymentFailed);
            return;
        }
        Signature storage sig = order.auth;
        try usdc.receiveWithAuthorization(
            order.buyer, address(this), amount, 0, order.deadline, sig.nonce, sig.v, sig.r, sig.s
        ) {
            _issue(order.buyer, order.qty, id);
            _resolve(id, Status.Issued);
        } catch {
            _resolve(id, Status.PaymentFailed);
        }
    }

    function _issue(address buyer, uint8 qty, uint256 orderId) private {
        availableSpots -= qty;
        retainedProceeds += qty * ticketPrice;
        for (uint256 i; i < qty; ++i) {
            uint256 ticketId = ++lastTicketId;
            ticketOwner[ticketId] = buyer;
            walletTickets[buyer].push(ticketId);
            emit TicketIssued(ticketId, buyer, orderId);
        }
    }

    function _resolve(uint256 id, Status status) private {
        orders[id].status = status;
        --activeOrders;
        emit OrderResolved(id, status);
    }

    function _publishState() private {
        (uint256 head, uint256 deadline, uint256 held, bool ready) = settlementState();
        emit SettlementState(++revision, head, deadline, held, ready);
    }

    function requestSettlementRetry() external {
        if (lastRetryAt != 0 && block.timestamp < lastRetryAt + 15 seconds) revert RetryCoolingDown();
        lastRetryAt = block.timestamp;
        _publishState();
    }

    function coverDebt() external {
        _coverDebt();
    }

    function withdrawProceeds() external {
        uint256 amount = retainedProceeds;
        if (msg.sender != organizer || block.timestamp < eventStartTime || amount == 0) revert WithdrawalUnavailable();
        retainedProceeds = 0;
        if (!usdc.transfer(organizer, amount)) revert TokenTransferFailed();
        emit ProceedsWithdrawn(organizer, amount);
    }
}

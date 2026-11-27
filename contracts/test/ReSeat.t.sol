// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {EventFactory} from "../src/EventFactory.sol";
import {TicketBook} from "../src/TicketBook.sol";
import {
    IEventDirectory,
    EventDetails,
    ISettlement,
    SponsoredJoin,
    SponsoredCancel
} from "../src/interfaces/ISettlement.sol";
import {EventWaitlist} from "../src/EventWaitlist.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {TestWalletValidator} from "./mocks/TestWalletValidator.sol";
import {MockReactiveSystem, MockCallbackProxy} from "./mocks/MockReactiveSystem.sol";

contract ReSeatTest is Test {
    uint256 constant BASE = 84532;
    uint256 constant LASNA = 5318007;
    uint256 constant PRICE = 20e6;
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;

    MockReactiveSystem system = MockReactiveSystem(payable(SYSTEM));
    MockCallbackProxy proxy;
    MockUSDC token;
    WaitlistReactive watcher;
    EventWaitlist workshop;
    EventFactory factory;
    uint256 requestOffset;
    uint256 constant RESERVE = 0.001 ether;
    address sellerA;
    address sellerB;
    address lin;
    address mei;
    uint256 linKey;
    uint256 meiKey;
    uint256 nonceSeed;
    uint256 start;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.chainId(LASNA);
        vm.etch(SYSTEM, type(MockReactiveSystem).runtimeCode);
        watcher = new WaitlistReactive();
        vm.chainId(BASE);
        proxy = new MockCallbackProxy();
        factory = new EventFactory(address(proxy), address(watcher), RESERVE);
        vm.chainId(LASNA);
        watcher.bindFactory(address(factory));
        vm.chainId(BASE);
        workshop = _publish(address(this), "Reactive Builders Workshop", block.timestamp + 7 days, 2, PRICE);
        _activate(workshop);
        requestOffset = system.requestCount();
        token = MockUSDC(address(workshop.usdc()));
        vm.etch(address(token), type(MockUSDC).runtimeCode);
        start = workshop.eventStartTime();
        (lin, linKey) = makeAddrAndKey("Lin");
        (mei, meiKey) = makeAddrAndKey("Mei");
        sellerA = makeAddr("first holder");
        sellerB = makeAddr("second holder");
        _buy(sellerA);
        _buy(sellerB);
    }

    function _publish(address host, string memory name, uint256 date, uint32 seats, uint256 price)
        private
        returns (EventWaitlist)
    {
        vm.deal(host, RESERVE);
        vm.recordLogs();
        vm.prank(host);
        address source = factory.createEvent{value: RESERVE}(
            EventDetails(name, "Shanghai", "Onchain workshop", ""), date, seats, price
        );
        return EventWaitlist(payable(source));
    }

    function _activate(EventWaitlist target) private {
        IReactive.LogRecord memory created = _record(address(factory), IEventDirectory.EventCreated.selector);
        assertEq(address(uint160(created.topic1)), address(target));
        uint256 callbackIndex = system.requestCount();
        _relay(created);
        vm.recordLogs();
        system.deliver(callbackIndex, proxy);
        _relay(_record(address(target), ISettlement.SettlementState.selector));
    }

    function _settlements() private view returns (uint256) {
        return system.requestCount() - requestOffset;
    }

    function _buy(address buyer) private {
        uint256 price = workshop.ticketPrice();
        token.mint(buyer, price);
        vm.startPrank(buyer);
        token.approve(address(workshop), price);
        workshop.buy(1);
        vm.stopPrank();
    }

    function _sign(uint256 key, uint32 qty, uint256 deadline, bytes32 nonce)
        private
        view
        returns (EventWaitlist.Signature memory sig)
    {
        bytes32 body = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                vm.addr(key),
                address(workshop),
                uint256(qty) * workshop.ticketPrice(),
                uint256(0),
                deadline,
                nonce
            )
        );
        sig.nonce = nonce;
        (sig.v, sig.r, sig.s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", token.DOMAIN_SEPARATOR(), body)));
    }

    function _join(uint256 key, uint32 qty, uint256 until, uint256 balance) private returns (uint256 id) {
        address buyer = vm.addr(key);
        token.mint(buyer, balance);
        EventWaitlist.Signature memory sig = _sign(
            key, qty, until < workshop.eventStartTime() ? until : workshop.eventStartTime(), bytes32(++nonceSeed)
        );
        vm.prank(buyer);
        id = workshop.enqueue(qty, until, sig);
    }

    function _refund(address buyer, uint256 ticketId) private {
        vm.recordLogs();
        vm.prank(buyer);
        workshop.refund(ticketId);
    }

    function _stateRecord() private view returns (IReactive.LogRecord memory) {
        return _record(address(workshop), ISettlement.SettlementState.selector);
    }

    function _record(address emitter, bytes32 topic) private view returns (IReactive.LogRecord memory record) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter == emitter && entry.topics[0] == topic) {
                record.chainId = BASE;
                record.contractAddress = entry.emitter;
                record.topic0 = uint256(entry.topics[0]);
                record.topic1 = uint256(entry.topics[1]);
                if (entry.topics.length > 2) record.topic2 = uint256(entry.topics[2]);
                record.opCode = entry.topics.length;
                record.data = entry.data;
                return record;
            }
        }
        revert("Missing Base state event");
    }

    function _relay(IReactive.LogRecord memory record) private {
        vm.chainId(LASNA);
        assertTrue(system.relay(watcher, record));
        vm.chainId(BASE);
    }

    function _relayState() private {
        _relay(_stateRecord());
    }

    function _tick() private returns (bool delivered) {
        vm.chainId(LASNA);
        IReactive.LogRecord memory record;
        record.chainId = LASNA;
        record.contractAddress = watcher.CRON_EMITTER();
        record.topic0 = watcher.CRON10();
        record.opCode = 1;
        delivered = system.relay(watcher, record);
        vm.chainId(BASE);
    }

    function _deliver(uint256 index) private {
        vm.recordLogs();
        system.deliver(index + requestOffset, proxy);
    }

    function _status(uint256 id) private view returns (EventWaitlist.Status status) {
        (,,, status) = workshop.orderInfo(id);
    }

    function _sponsored(uint256 key, uint32 qty) private returns (SponsoredJoin memory order) {
        order.buyer = vm.addr(key);
        order.qty = qty;
        order.deadline = start;
        order.salt = bytes32(++nonceSeed);
        bytes32 nonce = workshop.sponsoredNonce(order.buyer, qty, start, order.salt);
        EventWaitlist.Signature memory sig = _sign(key, qty, start, nonce);
        (order.v, order.r, order.s) = (sig.v, sig.r, sig.s);
    }

    function _cancelIntent(uint256 key, uint256 id, address target)
        private
        view
        returns (SponsoredCancel memory intent)
    {
        intent.orderId = id;
        intent.validBefore = block.timestamp + 15 minutes;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ReSeat"),
                keccak256("1"),
                BASE,
                target
            )
        );
        bytes32 body = keccak256(
            abi.encode(keccak256("CancelWaitlist(uint256 orderId,uint256 validBefore)"), id, intent.validBefore)
        );
        (intent.v, intent.r, intent.s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", domain, body)));
    }

    function testSponsoredQueueAndExitForTwoWalletsUseEventReserve() public {
        SponsoredJoin memory a = _sponsored(linKey, 2);
        SponsoredJoin memory b = _sponsored(meiKey, 1);
        token.mint(lin, 2 * PRICE);
        token.mint(mei, PRICE);
        vm.etch(mei, type(TestWalletValidator).runtimeCode);
        uint256 fee = RESERVE / 10;
        proxy.setDeliveryFee(fee);
        vm.chainId(LASNA);
        watcher.setWaitlistRelay(address(this));
        watcher.requestEnrollment(address(workshop), a);
        watcher.requestEnrollment(address(workshop), b);
        vm.chainId(BASE);
        assertEq(workshop.nextId(), 1);
        _deliver(0);
        _deliver(1);
        assertEq(workshop.orderIdForNonce(lin, workshop.sponsoredNonce(lin, 2, start, a.salt)), 1);
        assertEq(workshop.orderIdForNonce(mei, workshop.sponsoredNonce(mei, 1, start, b.salt)), 2);
        assertEq(proxy.reserves(address(workshop)), RESERVE - 2 * fee);
        assertEq(lin.balance + mei.balance, 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(token.balanceOf(mei), PRICE);
        SponsoredCancel memory intent = _cancelIntent(linKey, 1, address(workshop));
        vm.chainId(LASNA);
        watcher.requestCancellation(address(workshop), intent);
        vm.chainId(BASE);
        _deliver(2);
        assertEq(proxy.reserves(address(workshop)), RESERVE - 3 * fee);
        _deliver(0);
        _deliver(2);
        assertEq(workshop.activeOrders(), 1);
        assertEq(workshop.nextId(), 3);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Cancelled));
        _refund(sellerA, 1);
        _relayState();
        _deliver(3);
        assertEq(workshop.ticketOwner(3), mei);
        assertEq(token.balanceOf(mei), 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
    }

    function testSponsorChecksRelayTargetSessionAndBothCallbackIdentities() public {
        SponsoredJoin memory a = _sponsored(linKey, 2);
        vm.chainId(LASNA);
        vm.expectRevert("Only waitlist relay");
        watcher.requestEnrollment(address(workshop), a);
        vm.prank(lin);
        vm.expectRevert("Only owner");
        watcher.setWaitlistRelay(lin);
        watcher.setWaitlistRelay(address(this));
        vm.expectRevert("Request unavailable");
        watcher.requestEnrollment(sellerA, a);
        watcher.requestEnrollment(address(workshop), a);
        vm.expectRevert("Delivery pending");
        watcher.requestEnrollment(address(workshop), a);
        vm.chainId(BASE);
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        workshop.enqueueSponsored(address(watcher), a);
        vm.startPrank(address(proxy));
        vm.expectPartialRevert(AbstractCallback.CallbackNotAuthorized.selector);
        workshop.enqueueSponsored(lin, a);
        a.qty = 1;
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.enqueueSponsored(address(watcher), a);
        vm.stopPrank();
        vm.warp(start);
        vm.expectRevert(EventWaitlist.EventStarted.selector);
        _deliver(0);
        assertEq(workshop.activeOrders(), 0);
    }

    function testSponsoredCancellationChecksOrderBuyerEventAndExpiry() public {
        _join(linKey, 1, start, PRICE);
        SponsoredCancel memory wrongBuyer = _cancelIntent(meiKey, 1, address(workshop));
        SponsoredCancel memory wrongEvent = _cancelIntent(linKey, 1, address(factory));
        SponsoredCancel memory valid = _cancelIntent(linKey, 1, address(workshop));
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        workshop.cancelSponsored(address(watcher), valid);
        vm.startPrank(address(proxy));
        vm.expectPartialRevert(AbstractCallback.CallbackNotAuthorized.selector);
        workshop.cancelSponsored(mei, valid);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.cancelSponsored(address(watcher), wrongBuyer);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.cancelSponsored(address(watcher), wrongEvent);
        vm.warp(valid.validBefore);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.cancelSponsored(address(watcher), valid);
        vm.stopPrank();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Queued));
    }

    function testLostSponsoredDeliveryCanRecoverAfterFundingWithoutDuplicatingOrder() public {
        SponsoredJoin memory order = _sponsored(linKey, 1);
        vm.chainId(LASNA);
        watcher.setWaitlistRelay(address(this));
        watcher.requestEnrollment(address(workshop), order);
        vm.chainId(BASE);
        proxy.setDeliveryFee(RESERVE + 1);
        vm.expectRevert("Event credit depleted");
        _deliver(0);
        assertEq(workshop.activeOrders(), 0);
        vm.deal(address(this), RESERVE + 2);
        proxy.depositTo{value: RESERVE + 2}(address(workshop));
        vm.warp(block.timestamp + 5 minutes);
        vm.chainId(LASNA);
        watcher.requestEnrollment(address(workshop), order);
        vm.chainId(BASE);
        _deliver(1);
        _deliver(0);
        assertEq(workshop.nextId(), 2);
        assertEq(workshop.activeOrders(), 1);
    }

    function testWholeOrderHoldsThenChargesAndIssuesTwoBoundTickets() public {
        uint256 id = _join(linKey, 2, start, 2 * PRICE);
        assertFalse(watcher.cronActive());
        _refund(sellerA, 1);
        IReactive.LogRecord memory held = _stateRecord();
        _relay(held);
        assertTrue(watcher.cronActive());
        assertEq(watcher.sourceState(address(workshop)).head, id);
        assertEq(watcher.sourceState(address(workshop)).deadline, start);
        (,, uint256 heldSpots,,) = workshop.settlementState();
        assertEq(heldSpots, 1);
        assertEq(workshop.publicSpots(), 0);
        assertEq(_settlements(), 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(token.balanceOf(sellerA), PRICE);
        assertEq(workshop.ticketOwner(1), address(0));
        vm.prank(mei);
        vm.expectRevert(EventWaitlist.SeatsUnavailable.selector);
        workshop.buy(1);
        _refund(sellerB, 2);
        _relayState();
        assertEq(_settlements(), 1);
        (ISystemContract.CallbackConfiguration_V_1_0 memory request, address sender) = system.requestAt(requestOffset);
        assertEq(request.payload, abi.encodeCall(ISettlement.settle, (address(0), id)));
        assertEq(request.recipient, address(workshop));
        assertEq(sender, address(watcher));
        _deliver(0);
        _relayState();
        assertEq(token.balanceOf(lin), 0);
        assertEq(workshop.ticketBalance(lin), 2);
        assertEq(workshop.ticketOwner(3), lin);
        assertEq(workshop.ticketOwner(4), lin);
        assertEq(uint8(_status(id)), uint8(EventWaitlist.Status.Issued));
        assertEq(workshop.availableSpots(), 0);
        assertEq(workshop.retainedProceeds(), 2 * PRICE);
        assertFalse(watcher.cronActive());
        assertEq(system.removals(), 1);
        _relay(held);
        assertFalse(watcher.cronActive());
        assertFalse(_tick());
        _deliver(0);
        assertEq(workshop.ticketBalance(lin), 2);
        assertEq(token.balanceOf(address(workshop)), 2 * PRICE);
    }

    function testCronAloneReleasesExpiredHeadAndChargesNextBuyer() public {
        uint256 deadline = block.timestamp + 90;
        _join(linKey, 2, deadline, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        assertTrue(_tick());
        assertEq(_settlements(), 0);
        vm.warp(deadline + 1);
        assertTrue(_tick());
        assertEq(_settlements(), 1);
        _deliver(0);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Expired));
        assertEq(uint8(_status(2)), uint8(EventWaitlist.Status.Issued));
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(token.balanceOf(mei), 0);
        assertEq(workshop.ticketBalance(mei), 1);
        assertEq(workshop.ticketBalance(lin), 0);
        assertFalse(watcher.cronActive());
        assertFalse(_tick());
        assertEq(system.removals(), 1);
    }

    function testEarlyBaseClockIsSilentAndCronDebouncesThenRetries() public {
        uint256 deadline = block.timestamp + 90;
        _join(linKey, 2, deadline, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.warp(deadline);
        _tick();
        vm.warp(deadline - 2);
        _deliver(0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(workshop.headId(), 1);
        vm.warp(deadline + 14);
        _tick();
        assertEq(_settlements(), 1);
        vm.warp(deadline + 15);
        _tick();
        assertEq(_settlements(), 2);
        _deliver(1);
        _relayState();
        assertEq(workshop.publicSpots(), 1);
        assertFalse(watcher.cronActive());
    }

    function testNewPartialHeadUpdatesDeadlineWithoutResubscribing() public {
        uint256 early = block.timestamp + 30;
        uint256 later = early + 5;
        _join(linKey, 2, early, 2 * PRICE);
        _join(meiKey, 2, later, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.warp(early);
        _tick();
        _deliver(0);
        _relayState();
        assertTrue(watcher.cronActive());
        assertEq(watcher.sourceState(address(workshop)).head, 2);
        assertEq(watcher.sourceState(address(workshop)).deadline, later);
        assertEq(system.adds(), 3); // Factory, event state, and shared CRON.
        assertEq(system.removals(), 0);
        vm.warp(later);
        _tick();
        assertEq(_settlements(), 1);
        vm.warp(early + 15);
        _tick();
        assertEq(_settlements(), 2);
        _deliver(1);
        _relayState();
        assertFalse(watcher.cronActive());
    }

    function testInsufficientBalanceSkipsAndContinuesInSameCallback() public {
        _join(linKey, 1, start, PRICE - 1);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.expectEmit(true, false, false, true, address(workshop));
        emit EventWaitlist.OrderResolved(1, EventWaitlist.Status.PaymentFailed);
        _deliver(0);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(token.balanceOf(lin), PRICE - 1);
        assertEq(workshop.ticketOwner(3), mei);
    }

    function testRevokedCircleAuthorizationIsCaughtAndNextOrderFills() public {
        _join(linKey, 1, start, PRICE);
        _join(meiKey, 1, start, PRICE);
        bytes32 nonce = bytes32(uint256(1));
        bytes32 body = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), lin, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(linKey, keccak256(abi.encodePacked(hex"1901", token.DOMAIN_SEPARATOR(), body)));
        token.cancelAuthorization(lin, nonce, v, r, s);
        _refund(sellerA, 1);
        _relayState();
        _deliver(0);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(token.balanceOf(lin), PRICE);
        assertEq(workshop.ticketOwner(3), mei);
    }

    function testOwnerCanCancelWhileHeldAndReleasedSeatGoesToNextOrder() public {
        _join(linKey, 2, start, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.prank(mei);
        vm.expectRevert(EventWaitlist.NotOrderOwner.selector);
        workshop.cancel(1);
        vm.recordLogs();
        vm.prank(lin);
        workshop.cancel(1);
        _relayState();
        _deliver(0);
        _relayState();
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Cancelled));
        assertEq(workshop.ticketOwner(3), mei);
        assertFalse(watcher.cronActive());
    }

    function testLastCancellationReopensPublicSale() public {
        _join(linKey, 2, start, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.recordLogs();
        vm.prank(lin);
        workshop.cancel(1);
        _relayState();
        assertFalse(watcher.cronActive());
        assertEq(workshop.publicSpots(), 1);
        _buy(mei);
        assertEq(workshop.ticketOwner(3), mei);
    }

    function testOpeningTimeStopsRefundsAndFillsAndReleasesOnlyRetainedProceeds() public {
        _join(linKey, 2, start + 1 days, 2 * PRICE);
        (,, uint256 deadline,) = workshop.orderInfo(1);
        assertEq(deadline, start);
        _refund(sellerA, 1);
        _relayState();
        vm.expectRevert(EventWaitlist.WithdrawalUnavailable.selector);
        workshop.withdrawProceeds();
        vm.warp(start);
        _tick();
        _deliver(0);
        _relayState();
        assertFalse(watcher.cronActive());
        assertEq(workshop.publicSpots(), 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        vm.expectRevert(EventWaitlist.EventStarted.selector);
        workshop.refund(2);
        vm.expectRevert(EventWaitlist.EventStarted.selector);
        workshop.buy(1);
        vm.prank(mei);
        vm.expectRevert(EventWaitlist.WithdrawalUnavailable.selector);
        workshop.withdrawProceeds();
        workshop.withdrawProceeds();
        assertEq(token.balanceOf(address(this)), PRICE);
        assertEq(workshop.retainedProceeds(), 0);
        vm.expectRevert(EventWaitlist.WithdrawalUnavailable.selector);
        workshop.withdrawProceeds();
    }

    function testSixInvalidOrdersContinueOnSecondCallbackOnly() public {
        uint256 deadline = block.timestamp + 60;
        for (uint256 i; i < 6; ++i) {
            _join(linKey, 1, deadline, 0);
        }
        _join(meiKey, 1, start, PRICE);
        vm.warp(deadline);
        _refund(sellerA, 1);
        _relayState();
        _deliver(0);
        assertEq(workshop.headId(), 6);
        assertEq(uint8(_status(5)), uint8(EventWaitlist.Status.Expired));
        assertEq(uint8(_status(6)), uint8(EventWaitlist.Status.Queued));
        assertEq(workshop.availableSpots(), 1);
        _relayState();
        assertEq(_settlements(), 2);
        _deliver(1);
        _relayState();
        assertEq(workshop.activeOrders(), 0);
        assertEq(workshop.ticketOwner(3), mei);
        assertEq(_settlements(), 2);
    }

    function testPublicRetryRecoversLostEventButCannotSettleDirectly() public {
        _join(linKey, 1, start, PRICE);
        _refund(sellerA, 1); // Simulate a missed delivery.
        vm.recordLogs();
        vm.prank(mei);
        workshop.requestSettlementRetry();
        assertEq(workshop.ticketBalance(lin), 0);
        assertEq(token.balanceOf(lin), PRICE);
        _relayState();
        _deliver(0);
        assertEq(workshop.ticketOwner(3), lin);
    }

    function testAuthenticationBindingAndDebtEntrypoints() public {
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        workshop.settle(address(watcher), 1);
        vm.prank(address(proxy));
        vm.expectPartialRevert(AbstractCallback.CallbackNotAuthorized.selector);
        workshop.settle(mei, 1);
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        workshop.retryPayment(address(watcher), 1, 1);
        vm.prank(address(proxy));
        vm.expectPartialRevert(AbstractCallback.CallbackNotAuthorized.selector);
        workshop.retryPayment(mei, 1, 1);
        IReactive.LogRecord memory empty;
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        watcher.react(empty);
        vm.expectRevert("Invalid binding");
        watcher.bindFactory(mei);
        workshop.coverDebt();
        watcher.coverDebt();
    }

    function testSignedAmountPayeeWindowAndNonceAreBound() public {
        EventWaitlist.Signature memory sig = _sign(linKey, 2, start, keccak256("one"));
        vm.startPrank(lin);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.enqueue(1, start, sig);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.enqueue(2, start - 1, sig);
        workshop.enqueue(2, start, sig);
        workshop.cancel(1);
        vm.expectRevert(EventWaitlist.InvalidAuthorization.selector);
        workshop.enqueue(2, start, sig);
        vm.stopPrank();
        vm.expectRevert("Payee only");
        token.receiveWithAuthorization(lin, address(workshop), 2 * PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
        vm.warp(start);
        vm.prank(address(workshop));
        vm.expectRevert("Outside authorization window");
        token.receiveWithAuthorization(lin, address(workshop), 2 * PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
    }

    function testOnlyOwnerMayRefundAndEachTicketRefundsOnce() public {
        vm.prank(mei);
        vm.expectRevert(TicketBook.NotTicketOwner.selector);
        workshop.refund(1);
        _refund(sellerA, 1);
        vm.prank(sellerA);
        vm.expectRevert(TicketBook.NotTicketOwner.selector);
        workshop.refund(1);
        assertEq(token.balanceOf(sellerA), PRICE);
        assertEq(workshop.ticketOwner(1), address(0));
        assertEq(workshop.ticketOwner(2), sellerB);
        assertEq(workshop.publicSpots(), 1);
    }

    function testUSDCRejectsWrongDomainAndReplayAndRollsBackFailedTransfers() public {
        EventWaitlist.Signature memory sig = _sign(linKey, 1, start, keccak256("payment"));
        vm.startPrank(address(workshop));
        vm.chainId(LASNA);
        vm.expectRevert("Invalid signer");
        token.receiveWithAuthorization(lin, address(workshop), PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
        vm.chainId(BASE);
        vm.expectRevert("Invalid transfer");
        token.receiveWithAuthorization(lin, address(workshop), PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
        assertFalse(token.authorizationState(lin, sig.nonce));
        token.mint(lin, PRICE);
        token.receiveWithAuthorization(lin, address(workshop), PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
        assertTrue(token.authorizationState(lin, sig.nonce));
        vm.expectRevert("Used or cancelled");
        token.receiveWithAuthorization(lin, address(workshop), PRICE, 0, start, sig.nonce, sig.v, sig.r, sig.s);
        vm.stopPrank();
    }

    function testTwoPublishersIsolateFundsCallbacksAndSharedCron() public {
        EventWaitlist a = workshop;
        address hostB = makeAddr("host B");
        uint256 bPrice = 7_500_000;
        EventWaitlist b = _publish(hostB, "Evening studio", start + 1 days, 3, bPrice);
        _activate(b);
        assertEq(a.organizer(), address(this));
        assertEq(b.organizer(), hostB);
        assertEq(b.details().name, "Evening studio");
        assertEq(b.ticketPrice(), bPrice);
        assertEq(b.eventStartTime(), start + 1 days);
        assertEq(proxy.reserves(address(a)), RESERVE);
        assertEq(proxy.reserves(address(b)), RESERVE);

        _join(linKey, 2, start, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        workshop = b;
        _buy(sellerA);
        _buy(sellerB);
        _buy(sellerA);
        _join(meiKey, 3, start + 1 days, 3 * bPrice);
        _refund(sellerB, 2);
        _relayState();
        assertTrue(watcher.sourceState(address(a)).slot != 0 && watcher.sourceState(address(b)).slot != 0);
        uint256 bRevision = watcher.sourceState(address(b)).revision;
        uint256 index = system.requestCount();

        workshop = a;
        _refund(sellerB, 2);
        _relayState();
        assertEq(system.requestCount(), index + 1);
        (ISystemContract.CallbackConfiguration_V_1_0 memory request,) = system.requestAt(index);
        assertEq(request.recipient, address(a));
        vm.recordLogs();
        system.deliver(index, proxy);
        _relayState();
        assertEq(a.ticketBalance(lin), 2);
        assertEq(token.balanceOf(address(a)), 2 * PRICE);
        assertEq(b.activeOrders(), 1);
        assertEq(b.availableSpots(), 1);
        assertEq(token.balanceOf(address(b)), 2 * bPrice);
        assertEq(token.balanceOf(mei), 3 * bPrice);
        assertEq(watcher.sourceState(address(b)).revision, bRevision);
        assertTrue(watcher.sourceState(address(b)).slot != 0);
        assertEq(watcher.sourceState(address(a)).slot, 0);
        assertTrue(watcher.cronActive());
        assertEq(system.removals(), 0);

        vm.warp(b.eventStartTime());
        _tick();
        (request,) = system.requestAt(index + 1);
        assertEq(request.recipient, address(b));
        workshop = b;
        vm.recordLogs();
        system.deliver(index + 1, proxy);
        _relayState();
        assertFalse(watcher.cronActive());
        assertEq(system.removals(), 1);
        vm.prank(hostB);
        b.withdrawProceeds();
        assertEq(token.balanceOf(hostB), 2 * bPrice);
        assertEq(token.balanceOf(address(a)), 2 * PRICE);
    }

    function _deferredRecovery(bool pauseToken) private {
        _join(linKey, 1, start, PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        if (pauseToken) token.setPaused(true);
        else token.setCollectionFailure(true);
        _deliver(0);
        _relayState();
        assertEq(workshop.headId(), 1);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Queued));
        assertEq(workshop.availableSpots(), 1);
        assertEq(workshop.publicSpots(), 0);
        assertEq(token.balanceOf(lin), PRICE);
        assertEq(token.balanceOf(mei), PRICE);
        assertFalse(token.authorizationState(lin, bytes32(uint256(1))));
        assertEq(_settlements(), 1);
        (,,, bool ready, bool blocked) = workshop.settlementState();
        assertTrue(blocked && !ready);
        token.setPaused(false);
        token.setCollectionFailure(false);
        vm.recordLogs();
        vm.prank(mei);
        workshop.requestSettlementRetry();
        _relayState();
        _deliver(1);
        _relayState();
        assertEq(workshop.ticketOwner(3), lin);
        assertEq(token.balanceOf(lin), 0);
        assertEq(token.balanceOf(mei), PRICE);
        assertEq(workshop.headId(), 2);
        assertFalse(watcher.cronActive());
    }

    function testPausedUSDCResumesAtOriginalHead() public {
        _deferredRecovery(true);
    }

    function testUnknownCollectionFailureResumesAtOriginalHead() public {
        _deferredRecovery(false);
    }

    function testOrderWithChangedValidatorIsSkippedOnlyWhenCircleRejectsItsSignature() public {
        _join(linKey, 1, start, PRICE);
        _join(meiKey, 1, start, PRICE);
        vm.etch(lin, hex"00");
        _refund(sellerA, 1);
        _relayState();
        _deliver(0);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(token.balanceOf(lin), PRICE);
        assertFalse(token.authorizationState(lin, bytes32(uint256(1))));
        assertEq(workshop.ticketBalance(mei), 1);
        assertEq(token.balanceOf(mei), 0);
    }

    function _revokeLin() private {
        bytes32 nonce = bytes32(uint256(1));
        bytes32 body = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), lin, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(linKey, keccak256(abi.encodePacked(hex"1901", token.DOMAIN_SEPARATOR(), body)));
        token.cancelAuthorization(lin, nonce, v, r, s);
    }

    function testRevokedTwoSeatHeadCannotHoldFirstRefund() public {
        _join(linKey, 2, start, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        _revokeLin();
        _refund(sellerA, 1);
        _relayState();
        assertFalse(watcher.cronActive());
        _deliver(0);
        _relayState();
        assertEq(workshop.ticketOwner(3), mei);
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(token.balanceOf(lin), 2 * PRICE);
    }

    function testRevokedAfterHoldReleasesOnRecheck() public {
        _join(linKey, 2, start, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        assertTrue(watcher.cronActive());
        _revokeLin();
        vm.recordLogs();
        workshop.requestSettlementRetry();
        _relayState();
        _deliver(0);
        _relayState();
        assertEq(workshop.ticketOwner(3), mei);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertFalse(watcher.cronActive());
    }

    function testPublicRetryCannotBillIdleOrReplayUnchangedState() public {
        uint256 before = workshop.revision();
        vm.expectRevert(EventWaitlist.RetryUnavailable.selector);
        workshop.requestSettlementRetry();
        _join(linKey, 2, start, 2 * PRICE);
        vm.expectRevert(EventWaitlist.RetryUnavailable.selector);
        workshop.requestSettlementRetry();
        assertEq(workshop.revision(), before);
        _refund(sellerA, 1); // Miss the natural event.
        vm.recordLogs();
        workshop.requestSettlementRetry();
        _relayState();
        assertTrue(watcher.cronActive());
        uint256 heldRevision = workshop.revision();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(mei);
        vm.expectRevert(EventWaitlist.RetryUnavailable.selector);
        workshop.requestSettlementRetry();
        assertEq(workshop.revision(), heldRevision);
        _refund(sellerB, 2);
        _relayState();
        _deliver(0);
        _relayState();
        vm.expectRevert(EventWaitlist.RetryUnavailable.selector);
        workshop.requestSettlementRetry();
    }

    function testRegistrationAuthenticatesFactoryAndSnapshotsEarlierSales() public {
        EventWaitlist pending = _publish(mei, "Meetup", start, 4, PRICE);
        IReactive.LogRecord memory created = _record(address(factory), IEventDirectory.EventCreated.selector);
        IReactive.LogRecord memory foreign = _copyRecord(created);
        foreign.contractAddress = lin;
        vm.chainId(LASNA);
        vm.prank(SYSTEM);
        watcher.react(foreign);
        assertFalse(watcher.sourceState(address(pending)).registered);
        vm.chainId(BASE);
        workshop = pending;
        _buy(sellerA);
        EventWaitlist.Signature memory sig = _sign(linKey, 1, start, keccak256("pending"));
        vm.prank(lin);
        vm.expectRevert(EventWaitlist.BindingPending.selector);
        pending.enqueue(1, start, sig);
        _relay(created);
        assertTrue(watcher.sourceState(address(pending)).registered);
        assertFalse(pending.automationReady());
        vm.prank(address(proxy));
        vm.expectPartialRevert(AbstractCallback.CallbackNotAuthorized.selector);
        pending.confirmBinding(lin);
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        pending.confirmBinding(address(watcher));
        vm.recordLogs();
        system.deliver(requestOffset, proxy);
        _relayState();
        assertTrue(pending.automationReady());
        assertEq(watcher.sourceState(address(pending)).available, 3);
        uint256 count = system.requestCount();
        _relay(created);
        assertEq(system.requestCount(), count);
    }

    function _copyRecord(IReactive.LogRecord memory original) private pure returns (IReactive.LogRecord memory) {
        return abi.decode(abi.encode(original), (IReactive.LogRecord));
    }

    function testMissedFactoryAnnouncementRecoverableFromBase() public {
        EventWaitlist pending = _publish(mei, "Late binding", start, 3, PRICE);
        vm.warp(block.timestamp + 5 minutes);
        vm.recordLogs();
        vm.prank(mei);
        factory.retryActivation(address(pending));
        _activate(pending);
        assertTrue(pending.automationReady());
        vm.prank(mei);
        vm.expectRevert("Activation cooling down");
        factory.retryActivation(address(pending));
    }

    function testHostRecoversLostFirstSnapshotOnceFromBase() public {
        EventWaitlist pending = _publish(mei, "Snapshot recovery", start, 3, PRICE);
        _relay(_record(address(factory), IEventDirectory.EventCreated.selector));
        uint256 first = system.requestCount() - 1;
        system.deliver(first, proxy); // The first Base acknowledgement never reaches Lasna.
        assertTrue(pending.automationReady());
        assertEq(watcher.sourceState(address(pending)).revision, 0);

        vm.warp(block.timestamp + 6 minutes);
        vm.expectRevert("Activation unavailable");
        factory.retryActivation(address(pending));
        vm.recordLogs();
        vm.prank(mei);
        factory.retryActivation(address(pending));
        _activate(pending);
        assertEq(watcher.sourceState(address(pending)).revision, pending.revision());
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(mei);
        vm.expectRevert("Activation unavailable");
        factory.retryActivation(address(pending));
    }

    function testDelayedFactoryLogsRecoverEvenWhenDeliveredTogether() public {
        EventWaitlist pending = _publish(mei, "Delayed announcements", start, 4, PRICE);
        IReactive.LogRecord memory original = _record(address(factory), IEventDirectory.EventCreated.selector);
        vm.warp(block.timestamp + 5 minutes);
        vm.recordLogs();
        vm.prank(mei);
        factory.retryActivation(address(pending));
        IReactive.LogRecord memory recovery = _record(address(factory), IEventDirectory.EventCreated.selector);

        uint256 before = system.requestCount();
        _relay(original); // Its activation callback is lost.
        _relay(recovery); // Lasna delivers the newer Base announcement at the same Lasna timestamp.
        _relay(original);
        _relay(recovery);
        assertEq(system.requestCount(), before + 2);
        vm.recordLogs();
        system.deliver(before + 1, proxy);
        _relay(_record(address(pending), ISettlement.SettlementState.selector));
        assertTrue(pending.automationReady());
        assertEq(watcher.sourceState(address(pending)).revision, pending.revision());
    }

    function testSharedCronRotatesThroughFiveDueEvents() public {
        address[5] memory sources;
        uint256 deadline = block.timestamp + 30 minutes;
        for (uint256 i; i < sources.length; ++i) {
            workshop = _publish(address(this), "Workshop", start, 2, PRICE);
            sources[i] = address(workshop);
            _activate(workshop);
            _buy(sellerA);
            _buy(sellerB);
            _join(linKey, 2, deadline, 2 * PRICE);
            _refund(sellerA, 1);
            _relayState();
        }
        uint256 first = system.requestCount();
        vm.warp(deadline);
        assertTrue(_tick());
        assertEq(system.requestCount(), first + 4);
        assertTrue(_tick());
        assertEq(system.requestCount(), first + 5);
        for (uint256 i; i < sources.length; ++i) {
            (ISystemContract.CallbackConfiguration_V_1_0 memory request,) = system.requestAt(first + i);
            assertEq(request.recipient, sources[i]);
        }
    }

    function testCronRetriesRecoveredTwoTicketPaymentOnce() public {
        _join(linKey, 2, start, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        vm.warp(block.timestamp + 120);
        _tick();
        assertEq(_settlements(), 0);
        _refund(sellerB, 2);
        _relayState();
        token.setCollectionFailure(true);
        _deliver(0);
        _relayState();
        assertEq(workshop.deferredHead(), 1);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        token.setCollectionFailure(false);
        _deliver(0); // Replaying the original settlement cannot bypass the payment timer.
        assertEq(workshop.ticketBalance(lin), 0);
        uint256 due = block.timestamp + 30;
        vm.warp(due - 1);
        _tick();
        assertEq(_settlements(), 1);
        vm.warp(due);
        _tick();
        _tick();
        assertEq(_settlements(), 2);
        _deliver(1);
        _relayState();
        _deliver(1);
        assertEq(workshop.ticketBalance(lin), 2);
        assertEq(token.balanceOf(address(workshop)), 2 * PRICE);
        assertEq(token.balanceOf(lin), 0);
        assertFalse(watcher.cronActive());
    }

    function _refundBothAndDeliver() private {
        _refund(sellerA, 1);
        _relayState();
        uint256 index = system.requestCount();
        _refund(sellerB, 2);
        _relayState();
        vm.recordLogs();
        system.deliver(index, proxy);
        _relayState();
    }

    function _deferFirstBuyer(uint256 deadline) private {
        _join(linKey, 2, deadline, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        // The token rejects this buyer's collection without reporting a revoked nonce or a low balance.
        vm.mockCallRevert(
            address(token), abi.encodeWithSelector(token.receiveWithAuthorization.selector, lin), "offline"
        );
        _refundBothAndDeliver();
    }

    function _exhaustPaymentRetries() private {
        uint256[3] memory delays = [uint256(30), 60, 120];
        for (uint8 i; i < delays.length; ++i) {
            uint256 index = _settlements();
            uint256 due = block.timestamp + delays[i];
            assertEq(watcher.sourceState(address(workshop)).paymentRetryAt, due);
            vm.warp(due - 1);
            _tick();
            assertEq(_settlements(), index);
            vm.warp(due);
            _tick();
            _tick();
            assertEq(_settlements(), index + 1);
            (ISystemContract.CallbackConfiguration_V_1_0 memory request,) = system.requestAt(requestOffset + index);
            assertEq(request.payload, abi.encodeCall(ISettlement.retryPayment, (address(0), 1, i + 1)));
            vm.expectEmit(true, false, false, true, address(workshop));
            emit EventWaitlist.PaymentDeferred(1);
            _deliver(index);
            _relayState();
            _deliver(index); // Duplicate delivery cannot spend a second attempt.
            _relayState();
            assertEq(watcher.sourceState(address(workshop)).paymentAttempts, i + 1);
            assertEq(workshop.deferredHead(), 1);
            assertEq(workshop.availableSpots(), 2);
            assertEq(token.balanceOf(lin), 2 * PRICE);
        }
        assertEq(watcher.sourceState(address(workshop)).paymentRetryAt, 0);
        assertTrue(watcher.cronActive());
    }

    function testThreeFailedPaymentRetriesStillReleaseToNextBuyerAtDeadline() public {
        uint256 deadline = block.timestamp + 15 minutes;
        _deferFirstBuyer(deadline);
        _exhaustPaymentRetries();
        vm.warp(deadline - 1);
        _tick();
        assertEq(_settlements(), 4);
        vm.warp(deadline);
        _tick();
        _deliver(4);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Expired));
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(workshop.ticketBalance(mei), 1);
        assertEq(token.balanceOf(mei), 0);
        assertFalse(watcher.cronActive());
    }

    function testPaymentRetryDueAtDeadlineYieldsToExpiry() public {
        uint256 deadline = block.timestamp + 90;
        _deferFirstBuyer(deadline);
        vm.warp(deadline - 60);
        _tick();
        _deliver(1);
        _relayState();
        assertEq(watcher.sourceState(address(workshop)).paymentRetryAt, 0);
        assertEq(watcher.sourceState(address(workshop)).paymentAttempts, 1);
        vm.warp(deadline);
        _tick();
        (ISystemContract.CallbackConfiguration_V_1_0 memory request,) = system.requestAt(requestOffset + 2);
        assertEq(request.payload, abi.encodeCall(ISettlement.settle, (address(0), 1)));
        _deliver(2);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Expired));
        assertEq(workshop.ticketBalance(mei), 1);
    }

    function testManualRecoveryRemainsAvailableAfterThreeFailedAttempts() public {
        _deferFirstBuyer(start);
        // Use the public replay once before the first automatic attempt.
        vm.recordLogs();
        workshop.requestSettlementRetry();
        _relayState();
        _deliver(1);
        _relayState();
        _exhaustPaymentRetries();
        vm.clearMockedCalls();
        vm.warp(block.timestamp + 1 hours);
        _tick();
        uint256 index = _settlements();
        assertEq(index, 5);
        assertTrue(workshop.canRetrySettlement());
        vm.recordLogs();
        workshop.requestSettlementRetry();
        _relayState();
        assertEq(watcher.sourceState(address(workshop)).paymentAttempts, 3);
        _deliver(index);
        _relayState();
        assertEq(workshop.ticketBalance(lin), 2);
        assertEq(token.balanceOf(lin), 0);
        assertFalse(watcher.cronActive());
    }

    function testLatePaymentRetryDoesNotUseNextHeadsBudget() public {
        _deferFirstBuyer(start);
        vm.warp(block.timestamp + 30);
        _tick(); // The payment callback for order 1 is in flight.
        token.setCollectionFailure(true);
        vm.recordLogs();
        vm.prank(lin);
        workshop.cancel(1);
        _relayState();
        _deliver(2);
        _relayState();
        assertEq(workshop.deferredHead(), 2);
        token.setCollectionFailure(false);
        _deliver(1);
        _relayState();
        assertEq(watcher.sourceState(address(workshop)).paymentAttempts, 0);
        assertEq(token.balanceOf(mei), PRICE);
        assertEq(workshop.ticketBalance(mei), 0);
        vm.warp(block.timestamp + 30);
        _tick();
        _deliver(3);
        _relayState();
        assertEq(workshop.ticketBalance(mei), 1);
        assertEq(token.balanceOf(lin), 2 * PRICE);
    }

    function testEarlyPaymentDeliveryWaitsForBaseAndLaterAttemptCanRecover() public {
        _deferFirstBuyer(start);
        vm.clearMockedCalls();
        uint256 due = block.timestamp + 30;
        vm.warp(due);
        _tick();
        vm.warp(due - 1);
        _deliver(1); // Lasna is ahead of Base.
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        vm.warp(due + 59);
        _tick();
        assertEq(_settlements(), 2);
        vm.warp(due + 60);
        _tick();
        _deliver(2); // No Base acknowledgement of the first attempt was needed.
        _relayState();
        _deliver(1);
        assertEq(workshop.ticketBalance(lin), 2);
        assertEq(token.balanceOf(lin), 0);
    }

    function testPausedTokenOnlySchedulesPaymentForAFullHead() public {
        _join(linKey, 2, start, 2 * PRICE);
        _refund(sellerA, 1);
        _relayState();
        token.setPaused(true);
        vm.recordLogs();
        workshop.requestSettlementRetry();
        _relayState();
        assertEq(watcher.sourceState(address(workshop)).paymentRetryAt, 0);
        (,, uint256 held,, bool blocked) = workshop.settlementState();
        assertEq(held, 1);
        assertFalse(blocked);
        vm.warp(block.timestamp + 10 minutes);
        _tick();
        assertEq(_settlements(), 0);

        token.setPaused(false);
        _refund(sellerB, 2);
        _relayState();
        token.setPaused(true);
        _deliver(0);
        _relayState();
        uint256 due = watcher.sourceState(address(workshop)).paymentRetryAt;
        assertEq(due, block.timestamp + 30);
        token.setPaused(false);
        vm.warp(due);
        _tick();
        _deliver(1);
        _relayState();
        assertEq(workshop.ticketBalance(lin), 2);
        assertFalse(watcher.cronActive());
    }

    function testRevokedHeadIsSkippedWhenAutomaticPaymentArrives() public {
        _deferFirstBuyer(start);
        vm.warp(block.timestamp + 30);
        _tick();
        _revokeLin();
        token.setPaused(true);
        _deliver(1);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(workshop.deferredHead(), 2);
        token.setPaused(false);
        vm.warp(block.timestamp + 30);
        _tick();
        _deliver(2);
        _relayState();
        assertEq(workshop.ticketBalance(mei), 1);
        assertFalse(watcher.cronActive());
    }

    function testTwoEventsHaveIndependentPaymentRetryBudgets() public {
        EventWaitlist a = workshop;
        EventWaitlist b = _publish(mei, "Afternoon workshop", start + 1 days, 2, 3e6);
        _activate(b);
        token.setCollectionFailure(true);
        _join(linKey, 2, start, 2 * PRICE);
        _refundBothAndDeliver();
        uint256 dueA = block.timestamp + 30;

        vm.warp(block.timestamp + 10);
        workshop = b;
        _buy(sellerA);
        _buy(sellerB);
        _join(meiKey, 2, start, 6e6);
        _refundBothAndDeliver();
        uint256 index = system.requestCount();
        vm.warp(dueA);
        _tick();
        assertEq(system.requestCount(), index + 1);
        vm.recordLogs();
        system.deliver(index, proxy);
        _relay(_record(address(a), ISettlement.SettlementState.selector));
        assertEq(watcher.sourceState(address(a)).paymentAttempts, 1);
        assertEq(watcher.sourceState(address(b)).paymentAttempts, 0);
        assertEq(watcher.sourceState(address(b)).paymentRetryAt, dueA + 10);

        token.setCollectionFailure(false);
        vm.warp(dueA + 10);
        _tick();
        vm.recordLogs();
        system.deliver(index + 1, proxy);
        _relayState();
        assertEq(b.ticketBalance(mei), 2);
        assertEq(token.balanceOf(address(b)), 6e6);
        assertEq(a.ticketBalance(lin), 0);
        assertEq(token.balanceOf(address(a)), 0);
        assertTrue(watcher.cronActive());
        vm.warp(dueA + 60);
        _tick();
        vm.recordLogs();
        system.deliver(index + 2, proxy);
        _relay(_record(address(a), ISettlement.SettlementState.selector));
        assertEq(a.ticketBalance(lin), 2);
        assertEq(token.balanceOf(address(a)), 2 * PRICE);
        assertFalse(watcher.cronActive());
    }

    function testDeferredPaymentStillExpiresAndReleasesSeat() public {
        uint256 deadline = block.timestamp + 30 minutes;
        _join(linKey, 1, deadline, PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        token.setCollectionFailure(true);
        _deliver(0);
        _relayState();
        assertTrue(watcher.cronActive());

        token.setCollectionFailure(false);
        vm.warp(deadline);
        assertTrue(_tick());
        _deliver(1);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Expired));
        assertEq(token.balanceOf(lin), PRICE);
        assertEq(workshop.ticketOwner(3), mei);
        assertFalse(watcher.cronActive());
    }

    function testLargeGroupIssuesInOneCallbackAndIndividuallyRefunds() public {
        workshop = _publish(mei, "Assembly", start, 300, 1);
        _activate(workshop);
        token.mint(sellerA, 300);
        vm.startPrank(sellerA);
        token.approve(address(workshop), 300);
        workshop.buy(300);
        vm.stopPrank();
        _join(linKey, 300, start, 300);
        vm.startPrank(sellerA);
        for (uint256 id = 1; id < 300; ++id) {
            workshop.refund(id);
        }
        vm.recordLogs();
        workshop.refund(300);
        vm.stopPrank();
        uint256 index = system.requestCount();
        _relayState();
        system.deliver(index, proxy);
        assertEq(workshop.ticketBalance(lin), 300);
        assertEq(workshop.ticketOwner(301), lin);
        assertEq(workshop.ticketOwner(600), lin);
        vm.prank(lin);
        workshop.refund(310);
        assertEq(workshop.ticketOwner(310), address(0));
        assertEq(workshop.ticketOwner(311), lin);
        assertEq(workshop.ticketBalance(lin), 299);
        (uint256[] memory ids, uint256 grant, uint32 offset, bool more) = workshop.ticketsPage(lin, 0, 0);
        assertTrue(more);
        assertEq(grant, 0);
        assertEq(offset, 32);
        assertEq(ids.length, 31);
        assertEq(ids[9], 311);
        (ids,,,) = workshop.ticketsPage(lin, grant, offset);
        assertEq(ids[0], 333);
    }

    function testInvalidTermsAndMissingReserveCannotPublish() public {
        vm.deal(address(this), 1 ether);
        EventDetails memory info = EventDetails("Studio", "", "", "");
        vm.expectRevert("Invalid event terms");
        factory.createEvent{value: RESERVE}(info, block.timestamp, 1, PRICE);
        vm.expectRevert("Invalid event terms");
        factory.createEvent{value: RESERVE}(info, start, 0, PRICE);
        vm.expectRevert("Invalid event terms");
        factory.createEvent{value: RESERVE}(info, start, 1, 0);
        vm.expectRevert("Incorrect callback reserve");
        factory.createEvent(info, start, 1, PRICE);
        assertEq(factory.eventCount(), 1);
    }
}

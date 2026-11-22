// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {EventWaitlist} from "../src/EventWaitlist.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
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
        workshop = new EventWaitlist(address(proxy), address(watcher));
        token = MockUSDC(address(workshop.usdc()));
        vm.etch(address(token), type(MockUSDC).runtimeCode);
        start = workshop.eventStartTime();
        vm.chainId(LASNA);
        watcher.bindEvent(address(workshop));
        vm.chainId(BASE);
        (lin, linKey) = makeAddrAndKey("Lin");
        (mei, meiKey) = makeAddrAndKey("Mei");
        sellerA = makeAddr("first holder");
        sellerB = makeAddr("second holder");
        _buy(sellerA);
        _buy(sellerB);
    }

    function _buy(address buyer) private {
        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(workshop), PRICE);
        workshop.buy(1);
        vm.stopPrank();
    }

    function _sign(uint256 key, uint8 qty, uint256 deadline, bytes32 nonce)
        private
        view
        returns (EventWaitlist.Signature memory sig)
    {
        bytes32 body = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                vm.addr(key),
                address(workshop),
                uint256(qty) * PRICE,
                uint256(0),
                deadline,
                nonce
            )
        );
        sig.nonce = nonce;
        (sig.v, sig.r, sig.s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", token.DOMAIN_SEPARATOR(), body)));
    }

    function _join(uint256 key, uint8 qty, uint256 until, uint256 balance) private returns (uint256 id) {
        address buyer = vm.addr(key);
        token.mint(buyer, balance);
        EventWaitlist.Signature memory sig = _sign(key, qty, until < start ? until : start, bytes32(++nonceSeed));
        vm.prank(buyer);
        id = workshop.enqueue(qty, until, sig);
    }

    function _refund(address buyer, uint256 ticketId) private {
        vm.recordLogs();
        vm.prank(buyer);
        workshop.refund(ticketId);
    }

    function _stateRecord() private view returns (IReactive.LogRecord memory record) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter == address(workshop) && entry.topics[0] == ISettlement.SettlementState.selector) {
                record.chainId = BASE;
                record.contractAddress = entry.emitter;
                record.topic0 = uint256(entry.topics[0]);
                record.topic1 = uint256(entry.topics[1]);
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
        system.deliver(index, proxy);
    }

    function _status(uint256 id) private view returns (EventWaitlist.Status status) {
        (,,, status) = workshop.orderInfo(id);
    }

    function testWholeOrderHoldsThenChargesAndIssuesTwoBoundTickets() public {
        uint256 id = _join(linKey, 2, start, 2 * PRICE);
        assertFalse(watcher.cronActive());
        _refund(sellerA, 1);
        IReactive.LogRecord memory held = _stateRecord();
        _relay(held);
        assertTrue(watcher.cronActive());
        assertEq(watcher.trackedHeadId(), id);
        assertEq(watcher.trackedHeadDeadline(), start);
        (,, uint256 heldSpots,) = workshop.settlementState();
        assertEq(heldSpots, 1);
        assertEq(workshop.publicSpots(), 0);
        assertEq(system.requestCount(), 0);
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(token.balanceOf(sellerA), PRICE);
        assertEq(workshop.ticketOwner(1), address(0));
        vm.prank(mei);
        vm.expectRevert(EventWaitlist.SeatsUnavailable.selector);
        workshop.buy(1);
        _refund(sellerB, 2);
        _relayState();
        assertEq(system.requestCount(), 1);
        (ISystemContract.CallbackConfiguration_V_1_0 memory request, address sender) = system.requestAt(0);
        assertEq(request.payload, abi.encodeCall(ISettlement.settle, (address(0), id)));
        assertEq(request.recipient, address(workshop));
        assertEq(sender, address(watcher));
        _deliver(0);
        _relayState();
        assertEq(token.balanceOf(lin), 0);
        assertEq(workshop.ticketsOf(lin).length, 2);
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
        assertEq(workshop.ticketsOf(lin).length, 2);
        assertEq(token.balanceOf(address(workshop)), 2 * PRICE);
    }

    function testCronAloneReleasesExpiredHeadAndChargesNextBuyer() public {
        uint256 deadline = block.timestamp + 90;
        _join(linKey, 2, deadline, 2 * PRICE);
        _join(meiKey, 1, start, PRICE);
        _refund(sellerA, 1);
        _relayState();
        assertTrue(_tick());
        assertEq(system.requestCount(), 0);
        vm.warp(deadline + 1);
        assertTrue(_tick());
        assertEq(system.requestCount(), 1);
        _deliver(0);
        _relayState();
        assertEq(uint8(_status(1)), uint8(EventWaitlist.Status.Expired));
        assertEq(uint8(_status(2)), uint8(EventWaitlist.Status.Issued));
        assertEq(token.balanceOf(lin), 2 * PRICE);
        assertEq(token.balanceOf(mei), 0);
        assertEq(workshop.ticketsOf(mei).length, 1);
        assertEq(workshop.ticketsOf(lin).length, 0);
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
        assertEq(system.requestCount(), 1);
        vm.warp(deadline + 15);
        _tick();
        assertEq(system.requestCount(), 2);
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
        assertEq(watcher.trackedHeadId(), 2);
        assertEq(watcher.trackedHeadDeadline(), later);
        assertEq(system.adds(), 2); // One source filter and one CRON filter.
        assertEq(system.removals(), 0);
        vm.warp(later);
        _tick();
        assertEq(system.requestCount(), 1);
        vm.warp(early + 15);
        _tick();
        assertEq(system.requestCount(), 2);
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
        assertEq(system.requestCount(), 2);
        _deliver(1);
        _relayState();
        assertEq(workshop.activeOrders(), 0);
        assertEq(workshop.ticketOwner(3), mei);
        assertEq(system.requestCount(), 2);
    }

    function testPublicRetryRecoversLostEventButCannotSettleDirectly() public {
        _join(linKey, 1, start, PRICE);
        _refund(sellerA, 1); // Simulate a missed delivery.
        vm.recordLogs();
        vm.prank(mei);
        workshop.requestSettlementRetry();
        assertEq(workshop.ticketsOf(lin).length, 0);
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
        IReactive.LogRecord memory empty;
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        watcher.react(empty);
        vm.expectRevert("Invalid binding");
        watcher.bindEvent(mei);
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
        vm.expectRevert(EventWaitlist.NotTicketOwner.selector);
        workshop.refund(1);
        _refund(sellerA, 1);
        vm.prank(sellerA);
        vm.expectRevert(EventWaitlist.NotTicketOwner.selector);
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
}

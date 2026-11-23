// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {EventFactory} from "../src/EventFactory.sol";
import {EventWaitlist} from "../src/EventWaitlist.sol";
import {WaitlistReactive} from "../src/WaitlistReactive.sol";
import {EventDetails, IEventDirectory, ISettlement} from "../src/interfaces/ISettlement.sol";
import {MockCallbackProxy, MockReactiveSystem} from "./mocks/MockReactiveSystem.sol";

contract RejectsEther {
    receive() external payable {
        revert();
    }
}

contract FeeRefundTest is Test {
    uint256 constant BASE = 84532;
    uint256 constant LASNA = 5318007;
    uint256 constant INITIAL = 0.001 ether;
    uint256 constant FEE = 0.0001 ether;
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    MockReactiveSystem system = MockReactiveSystem(payable(SYSTEM));
    MockCallbackProxy proxy;
    WaitlistReactive watcher;
    EventFactory factory;
    address alice = makeAddr("host A");
    address bob = makeAddr("host B");
    uint256 starts;

    function setUp() public {
        vm.chainId(LASNA);
        vm.etch(SYSTEM, type(MockReactiveSystem).runtimeCode);
        watcher = new WaitlistReactive();
        vm.chainId(BASE);
        proxy = new MockCallbackProxy();
        factory = new EventFactory(address(proxy), address(watcher), INITIAL);
        vm.chainId(LASNA);
        watcher.bindFactory(address(factory), address(proxy));
        vm.chainId(BASE);
        proxy.setDeliveryFee(FEE);
        vm.deal(address(this), 1 ether);
        proxy.depositTo{value: 0.01 ether}(address(factory));
        starts = block.timestamp + 1 days;
    }

    function _relay(Vm.Log[] memory logs) private {
        vm.chainId(LASNA);
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter != address(factory)
                    && (l.emitter != address(proxy) || l.topics[0] != MockCallbackProxy.CallbackFailure.selector)
            ) continue;
            IReactive.LogRecord memory record;
            record.chainId = BASE;
            record.contractAddress = l.emitter;
            record.topic0 = uint256(l.topics[0]);
            record.topic1 = uint256(l.topics[1]);
            if (l.topics.length > 2) record.topic2 = uint256(l.topics[2]);
            record.opCode = l.topics.length;
            record.data = l.data;
            assertTrue(system.relay(watcher, record));
        }
        vm.chainId(BASE);
    }

    function _publish(address host, uint256 start) private returns (EventWaitlist e) {
        vm.deal(host, INITIAL);
        vm.recordLogs();
        vm.prank(host);
        e = EventWaitlist(payable(factory.createEvent{value: INITIAL}(EventDetails("Lab", "", "", ""), start, 2, 20e6)));
        _relay(vm.getRecordedLogs());
        assertEq(address(e).balance, INITIAL);
        assertEq(proxy.reserves(address(e)), 0);
    }

    function _deliver(uint256 id) private {
        vm.recordLogs();
        system.deliver(id, proxy);
        _relay(vm.getRecordedLogs());
    }

    function _tick() private {
        vm.chainId(LASNA);
        IReactive.LogRecord memory r;
        r.chainId = LASNA;
        r.contractAddress = watcher.CRON_EMITTER();
        r.topic0 = watcher.refundCronTopic();
        r.opCode = 1;
        system.relay(watcher, r);
        vm.chainId(BASE);
    }

    function testOfflineAutomaticRefundIsExactAndIsolated() public {
        EventWaitlist a = _publish(alice, starts);
        EventWaitlist b = _publish(bob, starts + 1 days);
        _deliver(0);
        _deliver(1);
        assertFalse(watcher.cronActive());
        assertTrue(watcher.refundCronActive());
        assertEq(watcher.refundCronTopic(), watcher.CRON10000());
        vm.warp(starts - 1);
        _tick();
        assertEq(system.requestCount(), 2);
        assertEq(watcher.refundCronTopic(), watcher.CRON100());
        vm.warp(starts);
        _tick();
        (ISystemContract.CallbackConfiguration_V_1_0 memory close,) = system.requestAt(2);
        assertEq(close.recipient, address(factory));
        assertEq(close.payload, abi.encodeCall(IEventDirectory.finalizeFeeRefund, (address(0), address(a), 1)));
        _deliver(2);
        assertTrue(a.feesRefunded());
        assertEq(alice.balance, INITIAL - FEE);
        assertEq(address(a).balance, 0);
        assertEq(proxy.debt(address(a)), 0);
        assertEq(proxy.reserves(address(factory)), 0.01 ether - FEE);
        _deliver(2);
        assertEq(alice.balance, INITIAL - FEE);
        assertFalse(b.feesRefunded());
        assertEq(address(b).balance, INITIAL - FEE);
        assertTrue(watcher.refundCronActive());
        assertEq(watcher.refundCronTopic(), watcher.CRON10000());
        vm.warp(starts + 1 days);
        _tick();
        _deliver(3);
        assertEq(bob.balance, INITIAL - FEE);
        assertFalse(watcher.refundCronActive());
    }

    function testRefundWaitsForDistinctInFlightCallbacksAndTheirFees() public {
        EventWaitlist e = _publish(alice, starts);
        vm.chainId(LASNA);
        watcher.syncEvent(address(e));
        watcher.syncEvent(address(e));
        vm.chainId(BASE);
        _deliver(1);
        _deliver(1);
        vm.warp(starts);
        _tick();
        _deliver(3);
        assertEq(e.expectedCallbacks(), 3);
        assertEq(e.deliveredCallbacks(), 1);
        assertFalse(e.feesRefunded());
        _deliver(2);
        _deliver(0);
        assertFalse(e.feesRefunded());
        assertEq(address(e).balance, INITIAL - 4 * FEE);
        _tick();
        _deliver(4);
        assertEq(alice.balance, INITIAL - 4 * FEE);
        assertEq(proxy.debt(address(e)), 0);
    }

    function testEventDebtMustBePaidAndOrganizerCanTopUp() public {
        EventWaitlist e = _publish(alice, starts);
        proxy.setDeliveryFee(INITIAL + FEE);
        _deliver(0);
        assertEq(proxy.debt(address(e)), INITIAL + FEE);
        proxy.setDeliveryFee(FEE);
        vm.warp(starts);
        _tick();
        _deliver(1);
        assertFalse(e.feesRefunded());
        vm.deal(bob, INITIAL);
        vm.prank(bob);
        vm.expectRevert("Funding unavailable");
        e.topUpFees{value: INITIAL}();
        vm.deal(alice, 2 * FEE);
        vm.recordLogs();
        vm.prank(alice);
        e.topUpFees{value: 2 * FEE}();
        _relay(vm.getRecordedLogs());
        assertEq(proxy.debt(address(e)), 0);
        _tick();
        _deliver(2);
        assertEq(alice.balance, FEE);
        assertTrue(e.feesRefunded());
    }

    function testProxyFailureReceiptReconcilesAnActuallyChargedFailedDelivery() public {
        EventWaitlist e = _publish(alice, starts);
        vm.mockCallRevert(address(e), abi.encodeCall(ISettlement.confirmBinding, (address(watcher), 1)), "failed");
        _deliver(0);
        assertEq(e.deliveredCallbacks(), 0);
        assertTrue(watcher.failedDeliveries(address(e), 1));
        assertEq(address(e).balance, INITIAL - FEE);
        vm.clearMockedCalls();
        vm.warp(starts);
        _tick();
        _deliver(2); // The finalizer arrived before the authenticated failure report.
        assertFalse(e.feesRefunded());
        _deliver(1);
        _deliver(1);
        assertEq(e.deliveredCallbacks(), 1);
        _tick();
        _deliver(3);
        assertEq(alice.balance, INITIAL - FEE);
        assertTrue(e.feesRefunded());
    }

    function testBaseClockControlsRefundAndOldPublicationPriceIsRejected() public {
        vm.expectRevert("Incorrect callback reserve");
        factory.createEvent{value: 0.0001 ether}(EventDetails("Old amount", "", "", ""), starts, 2, 20e6);
        EventWaitlist e = _publish(alice, starts);
        _deliver(0);
        vm.warp(starts);
        _tick();
        vm.warp(starts - 1);
        _deliver(1);
        assertFalse(e.feesRefunded());
        vm.warp(starts + 5 minutes);
        _tick();
        _deliver(2);
        assertTrue(e.feesRefunded());
    }

    function testRefundClockOrdersSixOpeningsAndBoundsEachTick() public {
        uint256[6] memory offsets = [uint256(60), 10, 50, 20, 40, 30];
        uint256[6] memory order = [uint256(1), 3, 5, 4, 2, 0];
        EventWaitlist[6] memory events;
        for (uint256 i; i < 6; ++i) {
            events[i] = _publish(address(uint160(100 + i)), starts + offsets[i]);
            _deliver(i);
        }
        vm.warp(starts + 61);
        _tick();
        assertEq(system.requestCount(), 10);
        _tick();
        assertEq(system.requestCount(), 12);
        for (uint256 i; i < 6; ++i) {
            (ISystemContract.CallbackConfiguration_V_1_0 memory request,) = system.requestAt(6 + i);
            assertEq(
                request.payload,
                abi.encodeCall(IEventDirectory.finalizeFeeRefund, (address(0), address(events[order[i]]), 1))
            );
            _deliver(6 + i);
            assertTrue(events[order[i]].feesRefunded());
        }
        assertFalse(watcher.refundCronActive());
    }

    function testRejectingWalletKeepsFundsAndCanRedirectRecovery() public {
        address host = address(new RejectsEther());
        EventWaitlist e = _publish(host, starts);
        _deliver(0);
        vm.warp(starts);
        for (uint256 i = 1; i <= 3; ++i) {
            _tick();
            _deliver(i);
            vm.warp(block.timestamp + 5 minutes);
        }
        assertFalse(e.feesRefunded());
        assertFalse(watcher.refundCronActive());
        assertEq(address(e).balance, INITIAL - FEE);
        vm.prank(bob);
        vm.expectRevert("Recipient unavailable");
        e.setFeeRecipient(payable(bob));
        vm.startPrank(host);
        e.setFeeRecipient(payable(alice));
        vm.recordLogs();
        e.retryFeeRefund();
        vm.stopPrank();
        _relay(vm.getRecordedLogs());
        _tick();
        _deliver(4);
        assertEq(alice.balance, INITIAL - FEE);
        assertTrue(e.feesRefunded());
    }
}

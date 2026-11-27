// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {EventWaitlist} from "../src/EventWaitlist.sol";
import {EventDetails, SponsoredJoin} from "../src/interfaces/ISettlement.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";

interface IForkUSDC is IUSDC {
    function approve(address, uint256) external returns (bool);
}

contract CircleForkTest is Test {
    address constant KERNEL = 0xd6CEDDe84be40893d153Be9d467CD6aD37875b28;
    uint256 constant PRICE = 1e6;
    EventWaitlist event_;
    IForkUSDC usdc;
    address proxy;
    address seller;
    address buyer;
    uint256 buyerKey;
    uint256 end;

    function setUp() public {
        string memory rpc = vm.envOr("RESEAT_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, 64_300_000);
        assertEq(block.chainid, 84532);
        assertGt(KERNEL.code.length, 100);
        proxy = makeAddr("local callback proxy");
        seller = makeAddr("fork holder");
        (buyer, buyerKey) = makeAddrAndKey("fork guest");
        end = block.timestamp + 1 days;
        event_ =
            new EventWaitlist(proxy, address(this), seller, EventDetails("Fork workshop", "", "", ""), end, 2, PRICE);
        usdc = IForkUSDC(address(event_.usdc()));
        deal(address(usdc), seller, 2 * PRICE);
        deal(address(usdc), buyer, 2 * PRICE);
        vm.prank(proxy);
        event_.confirmBinding(address(this));
        vm.startPrank(seller);
        usdc.approve(address(event_), 2 * PRICE);
        event_.buy(2);
        vm.stopPrank();
    }

    function _signature(address guest, uint256 key, uint32 qty)
        private
        view
        returns (EventWaitlist.Signature memory sig)
    {
        sig.nonce = event_.sponsoredNonce(guest, qty, end, bytes32(uint256(1)));
        bytes32 body = keccak256(
            abi.encode(
                keccak256(
                    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                ),
                guest,
                address(event_),
                PRICE * qty,
                uint256(0),
                end,
                sig.nonce
            )
        );
        (sig.v, sig.r, sig.s) = vm.sign(key, keccak256(abi.encodePacked(hex"1901", usdc.DOMAIN_SEPARATOR(), body)));
    }

    function _probe(EventWaitlist.Signature memory sig) private {
        vm.prank(address(event_));
        usdc.receiveWithAuthorization(buyer, address(event_), 2 * PRICE, 0, end, sig.nonce, sig.v, sig.r, sig.s);
    }

    function _settle() private {
        vm.prank(proxy);
        event_.settle(address(this), 1);
    }

    function _enroll(address guest, uint32 qty, EventWaitlist.Signature memory sig) private {
        vm.prank(proxy);
        event_.enqueueSponsored(address(this), SponsoredJoin(guest, qty, end, bytes32(uint256(1)), sig.v, sig.r, sig.s));
    }

    function _wholeOrder() private {
        EventWaitlist.Signature memory sig = _signature(buyer, buyerKey, 2);
        uint256 snapshot = vm.snapshotState();
        _probe(sig);
        assertEq(usdc.balanceOf(buyer), 0);
        assertTrue(vm.revertToState(snapshot)); // eth_call has no persistent effects.
        _enroll(buyer, 2, sig);
        vm.prank(seller);
        event_.refund(1);
        _settle();
        assertEq(usdc.balanceOf(buyer), 2 * PRICE);
        assertEq(event_.ticketBalance(buyer), 0);
        vm.prank(seller);
        event_.refund(2);
        _settle();
        _settle();
        assertTrue(usdc.authorizationState(buyer, sig.nonce));
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(event_.ticketBalance(buyer), 2);
        assertEq(buyer.balance, 0);
    }

    function testForkEOAWholeOrder() public {
        _wholeOrder();
    }

    function testForkKernelRejectsTheExactRawAuthorization() public {
        vm.signAndAttachDelegation(KERNEL, buyerKey);
        EventWaitlist.Signature memory sig = _signature(buyer, buyerKey, 2);
        vm.expectRevert("FiatTokenV2: invalid signature");
        _probe(sig);
        assertFalse(usdc.authorizationState(buyer, sig.nonce));
        assertEq(usdc.balanceOf(buyer), 2 * PRICE);
    }

    function testForkChangedKernelDelegationReleasesTicketsToNextBuyer() public {
        EventWaitlist.Signature memory sig = _signature(buyer, buyerKey, 2);
        _enroll(buyer, 2, sig);
        (address next, uint256 key) = makeAddrAndKey("next fork guest");
        deal(address(usdc), next, PRICE);
        EventWaitlist.Signature memory nextSig = _signature(next, key, 1);
        _enroll(next, 1, nextSig);
        vm.signAndAttachDelegation(KERNEL, buyerKey);
        vm.startPrank(seller);
        event_.refund(1);
        event_.refund(2);
        vm.stopPrank();
        _settle();
        (,,, EventWaitlist.Status status) = event_.orderInfo(1);
        assertEq(uint8(status), uint8(EventWaitlist.Status.PaymentFailed));
        assertEq(usdc.balanceOf(buyer), 2 * PRICE);
        assertFalse(usdc.authorizationState(buyer, sig.nonce));
        assertEq(event_.ticketBalance(next), 1);
        assertEq(usdc.balanceOf(next), 0);
    }

    function testForkMetaMaskDelegatedWholeOrder() public {
        vm.signAndAttachDelegation(0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B, buyerKey);
        _wholeOrder();
    }
}

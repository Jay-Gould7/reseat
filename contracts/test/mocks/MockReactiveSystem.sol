// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";

abstract contract MockFeeAccounting is IPayable {
    mapping(address => uint256) public reserves;
    mapping(address => uint256) public debt;

    function setDebt(address account, uint256 amount) external {
        debt[account] = amount;
    }

    function depositTo(address target) external payable {
        uint256 repaid = msg.value < debt[target] ? msg.value : debt[target];
        debt[target] -= repaid;
        reserves[target] += msg.value - repaid;
    }
    receive() external payable {}
}

/// @notice Models filter matching, queued transport and sender injection as separate steps.
contract MockReactiveSystem is ISystemContract, MockFeeAccounting {
    uint256 private constant IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    mapping(bytes32 => bool) public subscriptions;
    uint256 public adds;
    uint256 public removals;
    uint256 public requestCount;
    mapping(uint256 => CallbackConfiguration_V_1_0) private requests;
    mapping(uint256 => address) private senders;
    event TransportRequested(uint256 indexed index);

    function subscribe(uint256 chain, address source, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 key = keccak256(abi.encode(msg.sender, chain, source, t0, t1, t2, t3));
        require(!subscriptions[key], "Duplicate subscription");
        subscriptions[key] = true;
        ++adds;
    }

    function unsubscribe(uint256 chain, address source, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 key = keccak256(abi.encode(msg.sender, chain, source, t0, t1, t2, t3));
        require(subscriptions[key], "Filter mismatch");
        delete subscriptions[key];
        ++removals;
    }

    function relay(IReactive watcher, IReactive.LogRecord memory record) external returns (bool delivered) {
        bytes32 key = keccak256(
            abi.encode(address(watcher), record.chainId, record.contractAddress, record.topic0, IGNORE, IGNORE, IGNORE)
        );
        if (!subscriptions[key]) return false;
        watcher.react(record);
        return true;
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config) external {
        emit TransportRequested(requestCount);
        requests[requestCount] = config;
        senders[requestCount++] = msg.sender;
    }

    function requestCallback(CallbackVersion, bytes memory) external pure {
        revert("Use typed Omni request");
    }

    function requestAt(uint256 index) external view returns (CallbackConfiguration_V_1_0 memory, address) {
        return (requests[index], senders[index]);
    }

    function deliver(uint256 index, MockCallbackProxy proxy) external {
        CallbackConfiguration_V_1_0 memory config = requests[index];
        require(config.chainId == block.chainid && config.gasLimit >= 100000, "Invalid destination");
        proxy.forward(config.recipient, config.payload, senders[index], config.gasLimit);
    }

    struct Delivery {
        uint256 blockNumber;
        address sender;
        uint256 index;
        uint256 chainId;
        uint256 txHash;
        bytes err;
    }
    mapping(uint256 => Delivery[]) private deliveries;

    function getCallbacks(uint256 hash) external view returns (Delivery[] memory) {
        return deliveries[hash];
    }

    function recordDelivery(uint256 hash, address sender, uint256 destinationHash) external {
        deliveries[hash].push(Delivery(block.number, sender, 0, 84532, destinationHash, ""));
    }
}

contract MockCallbackProxy is MockFeeAccounting {
    uint256 public deliveryFee;

    function setDeliveryFee(uint256 fee) external {
        deliveryFee = fee;
    }

    function forward(address target, bytes memory payload, address sender, uint64 gasLimit) external {
        require(sender != address(0) && payload.length >= 36, "Invalid request");
        require(reserves[target] >= deliveryFee, "Event credit depleted");
        reserves[target] -= deliveryFee;
        // Skip the bytes length and the four-byte selector to overwrite the reserved ABI word.
        assembly ("memory-safe") { mstore(add(payload, 36), sender) }
        (bool ok, bytes memory result) = target.call{gas: gasLimit}(payload);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}

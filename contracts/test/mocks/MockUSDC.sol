// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IUSDC} from "../../src/interfaces/IUSDC.sol";

contract MockUSDC is IUSDC {
    bool public paused;
    bool public failCollection;

    function setPaused(bool value) external {
        paused = value;
    }

    function setCollectionFailure(bool value) external {
        failCollection = value;
    }

    string public constant name = "USDC";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!failCollection, "Temporary collection failure");
        require(to == msg.sender, "Payee only");
        require(block.timestamp > validAfter && block.timestamp < validBefore, "Outside authorization window");
        bytes32 body =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _consume(from, nonce, body, v, r, s);
        _transfer(from, to, value);
        emit AuthorizationUsed(from, nonce);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _consume(authorizer, nonce, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), v, r, s);
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _consume(address authorizer, bytes32 nonce, bytes32 body, uint8 v, bytes32 r, bytes32 s) private {
        require(!authorizationState[authorizer][nonce], "Used or cancelled");
        require(
            authorizer != address(0) && (v == 27 || v == 28)
                && uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0,
            "Invalid signature"
        );
        require(
            ecrecover(keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR(), body)), v, r, s) == authorizer,
            "Invalid signer"
        );
        authorizationState[authorizer][nonce] = true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(!paused, "Token paused");
        require(to != address(0) && balanceOf[from] >= value, "Invalid transfer");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

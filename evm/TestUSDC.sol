// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @title TestUSDC
/// @notice A test dollar for the GenLayer testnet, with the EIP-3009 `receiveWithAuthorization` that x402 and
///         Coinbase's ERC3009PaymentCollector use, in the signature-bytes form USDC v2.2 exposes (ECDSA or ERC-1271).
///         Anyone may mint; it is worth nothing.
contract TestUSDC is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function name() public pure override returns (string memory) {
        return "Test USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "tUSDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("Test USDC", "2");
    }

    function DOMAIN_SEPARATOR() public view override returns (bytes32) {
        return _domainSeparator();
    }

    function mint(address to, uint256 amount) external {
        require(amount <= 1_000_000e6, "TestUSDC:mint-cap");
        _mint(to, amount);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(to == msg.sender, "TestUSDC:caller-must-be-payee");
        require(block.timestamp > validAfter, "TestUSDC:not-yet-valid");
        require(block.timestamp < validBefore, "TestUSDC:expired");
        require(!authorizationState[from][nonce], "TestUSDC:used");
        bytes32 digest = _hashTypedData(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(SignatureCheckerLib.isValidSignatureNow(from, digest, signature), "TestUSDC:bad-signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}

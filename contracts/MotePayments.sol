// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Exact-amount local prototype payment router; this is not an x402 adapter.
/// @dev Domain binds each signature to this router and chain. Immutable router
///      configuration additionally binds token, merchant, and authorized quote signer.
contract MotePayments is EIP712 {
    using SafeERC20 for IERC20;

    struct Quote {
        bytes32 quoteId;
        bytes32 requestHash;
        address payer;
        uint256 amount;
        uint256 deadline;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,bytes32 requestHash,address payer,uint256 amount,uint256 deadline)"
    );

    IERC20 public immutable token;
    address public immutable merchant;
    address public immutable quoteSigner;
    mapping(bytes32 quoteId => bool used) public consumed;

    error InvalidConfiguration();
    error InvalidQuote();
    error UnauthorizedPayer();
    error QuoteExpired();
    error QuoteAlreadyPaid();
    error InvalidSignature();

    event Paid(
        bytes32 indexed quoteId,
        bytes32 indexed requestHash,
        address indexed payer,
        uint256 amount
    );

    constructor(address token_, address merchant_, address quoteSigner_)
        EIP712("MotePayments", "1")
    {
        if (token_ == address(0) || token_.code.length == 0 ||
            merchant_ == address(0) || quoteSigner_ == address(0)) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
        merchant = merchant_;
        quoteSigner = quoteSigner_;
    }

    function pay(Quote calldata quote, bytes calldata signature) external {
        if (quote.quoteId == bytes32(0) || quote.requestHash == bytes32(0) || quote.amount == 0) {
            revert InvalidQuote();
        }
        if (msg.sender != quote.payer) revert UnauthorizedPayer();
        if (block.timestamp > quote.deadline) revert QuoteExpired();
        if (consumed[quote.quoteId]) revert QuoteAlreadyPaid();

        bytes32 structHash = keccak256(abi.encode(
            QUOTE_TYPEHASH,
            quote.quoteId,
            quote.requestHash,
            quote.payer,
            quote.amount,
            quote.deadline
        ));
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != quoteSigner) {
            revert InvalidSignature();
        }

        // A failed transfer reverts this write too, so an uncharged quote remains usable.
        consumed[quote.quoteId] = true;
        token.safeTransferFrom(quote.payer, merchant, quote.amount);
        emit Paid(quote.quoteId, quote.requestHash, quote.payer, quote.amount);
    }
}

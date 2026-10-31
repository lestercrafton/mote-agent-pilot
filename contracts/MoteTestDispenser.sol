// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Pre-funded, keyless dispenser for no-value, six-decimal test MOTE.
/// @dev Intended only for the existing fixed-supply MoteToken. Mutable, rebasing,
///      taxed or dishonest-balance tokens are unsupported. Balance-delta checks
///      reject observable non-exact transfers; they cannot authenticate a token.
///      Once per address is not Sybil resistance. There is no admin, mint, sweep,
///      allowance, reset or upgrade path. Excess/accidental funding is stranded.
///      Limits apply to this instance, not to independently deployed dispensers.
contract MoteTestDispenser is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_CLAIM_AMOUNT = 10 * 10 ** 6;
    uint256 public constant MAX_DISTRIBUTION_CAP = 10_000 * 10 ** 6;

    IERC20 public immutable token;
    uint256 public immutable claimAmount;
    uint256 public immutable distributionCap;

    uint256 public distributed;
    mapping(address claimant => bool used) public claimed;

    error InvalidConfiguration();
    error AlreadyClaimed();
    error DistributionCapExceeded();
    error InsufficientFunding();
    error UnexpectedBalanceDelta();

    event Claimed(address indexed claimant, uint256 amount, uint256 totalDistributed);

    /// @param token_ Existing, reviewed MoteToken address; never deployed here.
    /// @param claimAmount_ Positive six-decimal base units, at most 10 MOTE.
    /// @param distributionCap_ Divisible lifetime base-unit cap, at most 10,000 MOTE.
    constructor(address token_, uint256 claimAmount_, uint256 distributionCap_) {
        if (
            token_.code.length == 0 ||
            claimAmount_ == 0 || claimAmount_ > MAX_CLAIM_AMOUNT ||
            distributionCap_ == 0 || distributionCap_ > MAX_DISTRIBUTION_CAP ||
            distributionCap_ < claimAmount_ || distributionCap_ % claimAmount_ != 0
        ) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
        claimAmount = claimAmount_;
        distributionCap = distributionCap_;
    }

    /// @notice Claim exactly claimAmount for msg.sender, once for that address.
    /// @dev The caller pays native gas. Failed transfer/checks revert eligibility
    ///      and cap accounting together. Later funding never increases the cap.
    function claim() external nonReentrant {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        // Constructor guarantees cap >= amount. Subtraction avoids sum overflow.
        if (distributed > distributionCap - claimAmount) revert DistributionCapExceeded();

        uint256 dispenserBefore = token.balanceOf(address(this));
        uint256 claimantBefore = token.balanceOf(msg.sender);
        if (dispenserBefore < claimAmount) revert InsufficientFunding();

        claimed[msg.sender] = true;
        distributed += claimAmount;
        token.safeTransfer(msg.sender, claimAmount);

        uint256 dispenserAfter = token.balanceOf(address(this));
        uint256 claimantAfter = token.balanceOf(msg.sender);
        if (
            dispenserAfter > dispenserBefore ||
            dispenserBefore - dispenserAfter != claimAmount ||
            claimantAfter < claimantBefore ||
            claimantAfter - claimantBefore != claimAmount
        ) {
            revert UnexpectedBalanceDelta();
        }
        emit Claimed(msg.sender, claimAmount, distributed);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply prototype token. Local demo allocations are fixtures only.
/// @dev There is no owner, additional mint, burn, tax, blacklist, or upgrade hook.
contract MoteToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 6;

    constructor(address initialHolder) ERC20("Mote", "MOTE") {
        _mint(initialHolder, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

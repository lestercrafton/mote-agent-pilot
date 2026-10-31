// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. Deliberately adversarial token, never a supported asset.
/// The public local fixture controls modes; no production contract imports this.
contract AdversarialDispenserToken is ERC20 {
    enum Mode { Normal, ReceiverTax, SenderTax, FalseReturn, RevertTransfer, NoOp, ReenterCaught, ReenterBubble }
    Mode public mode;
    address public callback;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentryError;
    address private immutable fixtureOwner;

    constructor() ERC20("Unsupported local test token", "LOCAL-ONLY") {
        fixtureOwner = msg.sender;
        _mint(msg.sender, 1_000_000);
    }

    function setMode(Mode next, address target) external {
        require(msg.sender == fixtureOwner);
        mode = next;
        callback = target;
        reentryAttempted = false;
        reentrySucceeded = false;
        reentryError = bytes4(0);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.RevertTransfer) revert("Controlled token rejection");
        if (mode == Mode.NoOp) return true;
        if (mode == Mode.ReenterCaught || mode == Mode.ReenterBubble) {
            // Make the token itself a second msg.sender, so the callback tests
            // the reentrancy guard rather than merely the original claim flag.
            reentryAttempted = true;
            (bool ok, bytes memory reason) = callback.call(abi.encodeWithSignature("claim()"));
            reentrySucceeded = ok;
            if (reason.length >= 4) reentryError = bytes4(reason);
            if (mode == Mode.ReenterBubble && !ok) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
        }
        if (mode == Mode.ReceiverTax) {
            _transfer(msg.sender, to, amount - 1);
            _burn(msg.sender, 1);
        } else {
            _transfer(msg.sender, to, amount);
            if (mode == Mode.SenderTax) _burn(msg.sender, 1);
        }
        // Even a token that mutates its balances before returning false must
        // have the entire attempted claim reverted by SafeERC20.
        return mode != Mode.FalseReturn;
    }
}

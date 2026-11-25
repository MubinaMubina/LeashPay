// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Testnet ERC4626 mock. Yield is simulated by donating faucet USDT;
/// every redeemable asset is backed by an actual token balance.
contract MockTBill is ERC4626 {
    error TestnetOnly();

    constructor(IERC20 asset_) ERC20("LeashPay Mock T-Bill", "mTBILL") ERC4626(asset_) {
        if (block.chainid != 97 && block.chainid != 31337) revert TestnetOnly();
    }
}

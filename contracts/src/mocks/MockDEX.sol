// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILeashDEX} from "../interfaces/ILeashDEX.sol";

/// @notice Testnet demo exchange with pre-funded liquidity and configurable rates.
/// Deliberately allows a bad rate so the vault's slippage guard can be demonstrated.
contract MockDEX is ILeashDEX {
    using SafeERC20 for IERC20;
    error TestnetOnly();
    error Unauthorized();
    error InvalidPair();
    address public immutable owner;
    address public immutable usdt;
    address public immutable usdc;
    mapping(address => uint256) public rateOut;

    constructor(address usdt_, address usdc_) {
        if (block.chainid != 97 && block.chainid != 31337) revert TestnetOnly();
        if (usdt_ == address(0) || usdc_ == address(0) || usdt_ == usdc_) revert InvalidPair();
        owner = msg.sender;
        usdt = usdt_;
        usdc = usdc_;
        rateOut[usdt_] = 1e18;
        rateOut[usdc_] = 1e18;
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        if (msg.sender != owner) revert Unauthorized();
        _pair(tokenIn, tokenOut);
        rateOut[tokenIn] = rate;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
        _pair(tokenIn, tokenOut);
        amountOut = Math.mulDiv(amountIn, rateOut[tokenIn], 1e18);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    function _pair(address tokenIn, address tokenOut) private view {
        if (!((tokenIn == usdt && tokenOut == usdc) || (tokenIn == usdc && tokenOut == usdt))) revert InvalidPair();
    }
}

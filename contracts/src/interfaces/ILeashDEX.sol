// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Internal adapter: take input from msg.sender and return output there.
/// Not part of the frozen interface shared with Builder B.
interface ILeashDEX {
    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut);
}

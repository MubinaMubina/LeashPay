// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFaucetToken
/// @notice Testnet-only faucet on the mock USDT and USDC (standard 18-decimal
///         ERC-20 tokens plus this function). Mint straight to a vault address
///         to fund it in one transaction.
/// @dev Capped per call by the implementation. Never deployed on mainnet.
interface IFaucetToken {
    function mint(address to, uint256 amount) external;
}

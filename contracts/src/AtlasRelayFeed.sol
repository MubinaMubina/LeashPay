// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @notice Testnet-only mirror of an Atlas mainnet feed. The reporter preserves
/// the SOURCE timestamp; writing a cached price never makes it fresh again.
contract AtlasRelayFeed is IPriceFeed {
    error Unauthorized(address caller);
    error InvalidUpdate();
    error TestnetOnly();
    event PriceRelayed(int256 answer, uint256 sourceUpdatedAt);
    uint8 public immutable decimals;
    address public immutable reporter;
    int256 private _answer;
    uint256 private _updatedAt;

    constructor(address reporter_, uint8 decimals_) {
        if (block.chainid != 97 && block.chainid != 31337) revert TestnetOnly();
        if (reporter_ == address(0) || decimals_ > 36) revert InvalidUpdate();
        reporter = reporter_;
        decimals = decimals_;
    }

    function update(int256 answer, uint256 sourceUpdatedAt) external {
        if (msg.sender != reporter) revert Unauthorized(msg.sender);
        if (answer <= 0 || sourceUpdatedAt == 0 || sourceUpdatedAt > block.timestamp || sourceUpdatedAt < _updatedAt) {
            revert InvalidUpdate();
        }
        _answer = answer;
        _updatedAt = sourceUpdatedAt;
        emit PriceRelayed(answer, sourceUpdatedAt);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}

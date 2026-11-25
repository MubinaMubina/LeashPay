// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceFeed
/// @notice The two functions the vault reads from a price feed. ABI-compatible
///         with Atlas ISingleFeed (push mode), which follows Chainlink's
///         AggregatorV3Interface:
///         https://docs.atlasoracle.io/developers/api-reference/single-feed-contract
/// @dev On BSC mainnet this is an Atlas SingleFeed proxy. Atlas lists no BSC
///      testnet feeds, so on testnet it is AtlasRelayFeed: a relay whose
///      reporter key (never the agent key) mirrors the mainnet Atlas answer and
///      its updatedAt. Atlas's roundId and answeredInRound are synthetic
///      (always 1), so consumers must check only answer > 0 and updatedAt.
interface IPriceFeed {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

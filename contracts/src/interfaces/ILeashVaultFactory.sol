// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILeashVault} from "./ILeashVault.sol";

/// @title ILeashVaultFactory
/// @notice Creates one LeashVault per owner and publishes the deployment's
///         addresses, so the apps only need FACTORY_ADDRESS.
/// @dev FROZEN ABI. See docs/vault-abi.md.
interface ILeashVaultFactory {
    /// @notice Everything a vault is wired to in this deployment.
    /// @param usdt Mock USDT (18 decimals) on testnet.
    /// @param usdc Mock USDC (18 decimals) on testnet.
    /// @param usdtFeed Price feed for USDT: Atlas on mainnet, the relay on testnet.
    /// @param usdcFeed Price feed for USDC: Atlas on mainnet, the relay on testnet.
    /// @param maxPriceAge Default oldest acceptable feed update, in seconds.
    /// @param tbill The tokenized T-bill (ERC-4626 over USDT).
    /// @param dex The DEX the vault swaps through (MockDEX on testnet).
    /// @param defaultAgent The agent key every new vault starts with.
    struct Config {
        address usdt;
        address usdc;
        address usdtFeed;
        address usdcFeed;
        uint256 maxPriceAge;
        address tbill;
        address dex;
        address defaultAgent;
    }

    event VaultCreated(address indexed owner, address indexed vault, address indexed agent);

    /// @notice The caller already has a vault.
    error VaultAlreadyExists(address owner, address vault);

    /// @notice Create the caller's vault. The caller becomes its fixed owner,
    ///         the agent is config().defaultAgent, and USDT and USDC are
    ///         allowed with their price feeds set.
    /// @dev Reverts VaultAlreadyExists, or ILeashVault.InvalidRules (raised by
    ///      the new vault's constructor) if the rules are inconsistent. Decode
    ///      reverts with the factory ABI and the vault ABI together.
    function createVault(ILeashVault.Rules calldata rules) external returns (address vault);

    /// @notice The owner's vault, or address(0) if they have none.
    function vaultOf(address owner) external view returns (address vault);

    function config() external view returns (Config memory);
}

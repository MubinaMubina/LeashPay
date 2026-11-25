// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ILeashVault} from "./interfaces/ILeashVault.sol";
import {ILeashVaultFactory} from "./interfaces/ILeashVaultFactory.sol";
import {LeashVault} from "./LeashVault.sol";

contract LeashVaultFactory is ILeashVaultFactory {
    Config private _config;
    mapping(address => address) public vaultOf;

    constructor(Config memory cfg) {
        if (
            cfg.usdt.code.length == 0 || cfg.usdc.code.length == 0 || cfg.usdtFeed.code.length == 0
                || cfg.usdcFeed.code.length == 0 || cfg.tbill.code.length == 0 || cfg.dex.code.length == 0
        ) revert ILeashVault.ZeroAddress();
        if (
            cfg.usdt == cfg.usdc || IERC20Metadata(cfg.usdt).decimals() != 18
                || IERC20Metadata(cfg.usdc).decimals() != 18 || IERC4626(cfg.tbill).asset() != cfg.usdt
        ) revert ILeashVault.InvalidRules();
        if (cfg.maxPriceAge == 0) revert ILeashVault.ZeroAmount();
        _config = cfg;
    }

    function config() external view returns (Config memory) {
        return _config;
    }

    function createVault(ILeashVault.Rules calldata rules_) external returns (address vault) {
        address previous = vaultOf[msg.sender];
        if (previous != address(0)) revert VaultAlreadyExists(msg.sender, previous);
        vault = address(new LeashVault(msg.sender, _config, rules_));
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault, _config.defaultAgent);
    }
}

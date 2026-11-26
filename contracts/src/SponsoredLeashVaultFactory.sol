// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ILeashVault} from "./interfaces/ILeashVault.sol";
import {ISponsoredLeashVaultFactory} from "./interfaces/ISponsoredLeashVaultFactory.sol";
import {LeashOwnerAuthorization} from "./LeashOwnerAuthorization.sol";
import {SponsoredLeashVault} from "./SponsoredLeashVault.sol";

/// @notice Creates one fee-charging vault per owner by direct call or relayed approval.
contract SponsoredLeashVaultFactory is ISponsoredLeashVaultFactory, LeashOwnerAuthorization {
    bytes32 private constant ACTIVATE_TYPEHASH =
        keccak256("ActivateVault(address owner,bytes32 rulesHash,uint256 deadline)");
    address public immutable treasury;
    Config private _config;
    mapping(address => address) public vaultOf;

    constructor(Config memory cfg, address treasury_) {
        if (treasury_ == address(0)) revert ILeashVault.ZeroAddress();
        if (
            cfg.usdt.code.length == 0 || cfg.usdc.code.length == 0 || cfg.usdtFeed.code.length == 0
                || cfg.usdcFeed.code.length == 0 || cfg.tbill.code.length == 0 || cfg.dex.code.length == 0
        ) revert ILeashVault.ZeroAddress();
        if (
            cfg.usdt == cfg.usdc || IERC20Metadata(cfg.usdt).decimals() != 18
                || IERC20Metadata(cfg.usdc).decimals() != 18 || IERC4626(cfg.tbill).asset() != cfg.usdt
        ) revert ILeashVault.InvalidRules();
        if (cfg.maxPriceAge == 0) revert ILeashVault.ZeroAmount();
        treasury = treasury_;
        _config = cfg;
    }

    function config() external view returns (Config memory) {
        return _config;
    }

    function createVault(ILeashVault.Rules calldata rules_) external returns (address vault) {
        return _createVault(msg.sender, rules_);
    }

    function createVaultFor(
        address owner,
        ILeashVault.Rules calldata rules_,
        uint256 deadline,
        bytes calldata signature
    ) external returns (address vault) {
        if (owner == address(0)) revert ILeashVault.ZeroAddress();
        bytes32 structHash = keccak256(abi.encode(ACTIVATE_TYPEHASH, owner, keccak256(abi.encode(rules_)), deadline));
        _verifyOwnerAuthorization(owner, structHash, deadline, signature);
        return _createVault(owner, rules_);
    }

    function _createVault(address owner, ILeashVault.Rules calldata rules_) private returns (address vault) {
        address previous = vaultOf[owner];
        if (previous != address(0)) revert VaultAlreadyExists(owner, previous);
        vault = address(new SponsoredLeashVault(owner, _config, rules_, treasury));
        vaultOf[owner] = vault;
        emit VaultCreated(owner, vault, _config.defaultAgent);
    }
}

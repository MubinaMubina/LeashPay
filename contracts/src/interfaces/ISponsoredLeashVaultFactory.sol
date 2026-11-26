// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILeashVault} from "./ILeashVault.sol";
import {ILeashVaultFactory} from "./ILeashVaultFactory.sol";

interface ISponsoredLeashVaultFactory is ILeashVaultFactory {
    /// @notice Anyone may relay the owner's EIP-712 signature for the specified initial rules.
    function createVaultFor(address owner, ILeashVault.Rules calldata rules, uint256 deadline, bytes calldata signature)
        external
        returns (address vault);
}

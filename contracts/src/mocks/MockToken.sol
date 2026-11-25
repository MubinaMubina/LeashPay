// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IFaucetToken} from "../interfaces/IFaucetToken.sol";

/// @notice Public testnet faucet; tokens have no economic value.
contract MockToken is ERC20, IFaucetToken {
    error TestnetOnly();
    error InvalidMintAmount();
    uint256 public constant MAX_MINT = 1_000_000e18;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (block.chainid != 97 && block.chainid != 31337) revert TestnetOnly();
    }

    function mint(address to, uint256 amount) external {
        if (amount == 0 || amount > MAX_MINT) revert InvalidMintAmount();
        _mint(to, amount);
    }
}

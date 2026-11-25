// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";

contract TestToken is ERC20 {
    bool public failTransfers;
    constructor() ERC20("Test dollar", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFail(bool fail) external {
        failTransfers = fail;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, amount);
    }
}

contract TestFeed is IPriceFeed {
    uint8 public decimals = 8;
    int256 public answer = 1e8;
    uint256 public timestamp;

    constructor() {
        timestamp = block.timestamp;
    }

    function set(int256 answer_, uint256 timestamp_, uint8 decimals_) external {
        answer = answer_;
        timestamp = timestamp_;
        decimals = decimals_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, timestamp, timestamp, 1);
    }
}

contract TestTBill is ERC4626 {
    constructor(IERC20 asset_) ERC20("Test bill", "TBILL") ERC4626(asset_) {}
}

contract TestDex {
    uint256 public rate = 1e18;
    uint256 public returnLie;
    bool public skipInput;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function configure(uint256 rate_, uint256 lie_, bool skip_) external {
        rate = rate_;
        returnLie = lie_;
        skipInput = skip_;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256) {
        if (callbackTarget != address(0)) {
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
        if (!skipInput) require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn));
        uint256 out = amountIn * rate / 1e18;
        require(IERC20(tokenOut).transfer(msg.sender, out));
        return returnLie == 0 ? out : returnLie;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILeashVault} from "./interfaces/ILeashVault.sol";
import {ILeashVaultFactory} from "./interfaces/ILeashVaultFactory.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

import {ILeashDEX} from "./interfaces/ILeashDEX.sol";

/// @notice Fixed-owner payment vault implementing the frozen LeashPay rules.
contract LeashVault is ILeashVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public agent;
    bool public paused;
    address public immutable tbill;
    address private immutable _usdt;
    address private immutable _usdc;
    address private immutable _dex;
    Rules private _rules;

    struct Recipient {
        bool allowed;
        uint256 cap;
        uint256 spent;
        uint256 month;
        uint256 lastPaid;
    }

    struct Feed {
        address source;
        uint256 maxAge;
    }
    mapping(address => Recipient) private _recipients;
    mapping(address => bool) private _allowedTokens;
    mapping(address => Feed) private _feeds;
    mapping(bytes32 => mapping(address => bool)) private _paid;
    uint256 private _paymentDay;
    uint256 private _dailyPaid;
    uint256 private _swapDay;
    uint256 private _dailySwapped;

    constructor(address owner_, ILeashVaultFactory.Config memory cfg, Rules memory rules_) {
        if (owner_ == address(0)) revert ZeroAddress();
        _validateRules(rules_);
        owner = owner_;
        agent = cfg.defaultAgent;
        tbill = cfg.tbill;
        _usdt = cfg.usdt;
        _usdc = cfg.usdc;
        _dex = cfg.dex;
        _rules = rules_;
        _allowedTokens[cfg.usdt] = true;
        _allowedTokens[cfg.usdc] = true;
        _feeds[cfg.usdt] = Feed(cfg.usdtFeed, cfg.maxPriceAge);
        _feeds[cfg.usdc] = Feed(cfg.usdcFeed, cfg.maxPriceAge);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }
    modifier onlyAgent() {
        if (msg.sender != agent || agent == address(0)) revert Unauthorized(msg.sender);
        _;
    }
    modifier operator() {
        if (msg.sender != owner && (msg.sender != agent || agent == address(0))) revert Unauthorized(msg.sender);
        _;
    }
    modifier whenActive() {
        if (paused) revert VaultPaused();
        _;
    }

    function pay(address recipient, address token, uint256 amount, bytes32 ref)
        external
        onlyAgent
        whenActive
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert InvalidRef();
        _checkToken(token);
        Recipient storage r = _recipients[recipient];
        if (!r.allowed) revert RecipientNotAllowed(recipient);
        if (_paid[ref][recipient]) revert DuplicatePayment(ref, recipient);
        if (amount > _rules.perPaymentCap) revert ExceedsPaymentCap(amount, _rules.perPaymentCap);
        if (r.lastPaid != 0 && block.timestamp - r.lastPaid < _rules.cooldown) {
            uint256 readyAt =
                _rules.cooldown > type(uint256).max - r.lastPaid ? type(uint256).max : r.lastPaid + _rules.cooldown;
            revert CooldownActive(recipient, readyAt);
        }
        uint256 daily = spentToday();
        uint256 remaining = _remaining(_rules.dailyCap, daily);
        if (amount > remaining) revert ExceedsDailyCap(amount, remaining);
        uint256 month = block.timestamp / 30 days;
        uint256 monthly = r.month == month ? r.spent : 0;
        remaining = _remaining(r.cap, monthly);
        if (amount > remaining) revert ExceedsMonthlyCap(recipient, amount, remaining);
        if (_rules.minTokenPrice > 0) {
            (uint256 price,) = getPrice(token);
            if (price < _rules.minTokenPrice) revert PriceBelowFloor(token, price, _rules.minTokenPrice);
        }
        _checkBalance(token, amount);
        _paid[ref][recipient] = true;
        r.month = month;
        r.spent = monthly + amount;
        r.lastPaid = block.timestamp;
        _paymentDay = block.timestamp / 1 days;
        _dailyPaid = daily + amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit Paid(recipient, token, amount, ref);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn)
        external
        operator
        whenActive
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        _checkToken(tokenIn);
        _checkToken(tokenOut);
        if (tokenIn == tokenOut) revert TokenNotAllowed(tokenOut);
        uint256 swapped = swappedToday();
        uint256 remaining = _remaining(_rules.dailySwapCap, swapped);
        if (amountIn > remaining) revert ExceedsSwapCap(amountIn, remaining);
        (uint256 priceIn,) = getPrice(tokenIn);
        (uint256 priceOut,) = getPrice(tokenOut);
        uint256 minimum = Math.mulDiv(Math.mulDiv(amountIn, priceIn, priceOut), 10_000 - _rules.maxSlippageBps, 10_000);
        _checkBalance(tokenIn, amountIn);
        _swapDay = block.timestamp / 1 days;
        _dailySwapped = swapped + amountIn;
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(_dex, amountIn);
        ILeashDEX(_dex).swap(tokenIn, tokenOut, amountIn);
        IERC20(tokenIn).forceApprove(_dex, 0);
        uint256 afterOut = IERC20(tokenOut).balanceOf(address(this));
        amountOut = afterOut > beforeOut ? afterOut - beforeOut : 0;
        if (amountOut < minimum) revert SlippageTooHigh(minimum, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, minimum);
    }

    function sweepToTBill(uint256 assets) external operator whenActive nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        _checkBalance(_usdt, assets);
        IERC20(_usdt).forceApprove(tbill, assets);
        shares = IERC4626(tbill).deposit(assets, address(this));
        IERC20(_usdt).forceApprove(tbill, 0);
        // Refuse an ERC4626 rounding-to-zero deposit instead of donating funds.
        if (shares == 0) revert ZeroAmount();
        emit SweptToTBill(assets, shares);
    }

    function redeemFromTBill(uint256 assets) external operator whenActive nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 available = IERC4626(tbill).maxWithdraw(address(this));
        if (assets > available) revert InsufficientBalance(tbill, available, assets);
        shares = IERC4626(tbill).withdraw(assets, address(this), address(this));
        emit RedeemedFromTBill(assets, shares);
    }

    function getPrice(address token) public view returns (uint256 price, uint256 updatedAt) {
        Feed storage f = _feeds[token];
        if (f.source == address(0)) revert PriceFeedNotSet(token);
        (, int256 answer,, uint256 timestamp,) = IPriceFeed(f.source).latestRoundData();
        if (answer <= 0) revert InvalidPrice(token, answer);
        uint8 decimals = IPriceFeed(f.source).decimals();
        if (decimals > 36) revert InvalidPrice(token, answer);
        price = uint256(answer);
        if (decimals < 18) {
            uint256 scale = 10 ** (18 - decimals);
            if (price > type(uint256).max / scale) revert InvalidPrice(token, answer);
            price *= scale;
        } else if (decimals > 18) {
            price /= 10 ** (decimals - 18);
        }
        if (price == 0) revert InvalidPrice(token, answer);
        if (timestamp == 0 || timestamp > block.timestamp || block.timestamp - timestamp > f.maxAge) {
            revert StalePrice(token, timestamp, f.maxAge);
        }
        updatedAt = timestamp;
    }

    function setRules(Rules calldata rules_) external onlyOwner {
        _validateRules(rules_);
        _rules = rules_;
        emit RulesUpdated(rules_);
    }

    function setRecipient(address recipient, bool allowed, uint256 monthlyCap) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        Recipient storage r = _recipients[recipient];
        r.allowed = allowed;
        r.cap = monthlyCap;
        emit RecipientUpdated(recipient, allowed, monthlyCap);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _knownToken(token);
        _allowedTokens[token] = allowed;
        emit TokenAllowedUpdated(token, allowed);
    }

    function setPriceFeed(address token, address feed, uint256 maxAge) external onlyOwner {
        _knownToken(token);
        if (feed == address(0)) revert ZeroAddress();
        if (maxAge == 0) revert ZeroAmount();
        _feeds[token] = Feed(feed, maxAge);
        emit PriceFeedUpdated(token, feed, maxAge);
    }

    function setAgent(address newAgent) external onlyOwner {
        address previous = agent;
        agent = newAgent;
        emit AgentUpdated(previous, newAgent);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _checkBalance(token, amount);
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function rules() external view returns (Rules memory) {
        return _rules;
    }

    function recipientInfo(address recipient) external view returns (bool, uint256, uint256, uint256) {
        Recipient storage r = _recipients[recipient];
        return (r.allowed, r.cap, r.month == block.timestamp / 30 days ? r.spent : 0, r.lastPaid);
    }

    function spentToday() public view returns (uint256) {
        return _paymentDay == block.timestamp / 1 days ? _dailyPaid : 0;
    }

    function swappedToday() public view returns (uint256) {
        return _swapDay == block.timestamp / 1 days ? _dailySwapped : 0;
    }

    function isTokenAllowed(address token) external view returns (bool) {
        return _allowedTokens[token];
    }

    function priceFeed(address token) external view returns (address, uint256) {
        Feed storage f = _feeds[token];
        return (f.source, f.maxAge);
    }

    function tbillValue() public view returns (uint256) {
        return IERC4626(tbill).convertToAssets(IERC20(tbill).balanceOf(address(this)));
    }

    function _validateRules(Rules memory r) private pure {
        if (r.dailyCap == 0 || r.perPaymentCap > r.dailyCap || r.maxSlippageBps > 200 || r.minTokenPrice > 1e18) {
            revert InvalidRules();
        }
    }

    function _knownToken(address token) private view {
        if (token != _usdt && token != _usdc) revert TokenNotAllowed(token);
    }

    function _checkToken(address token) private view {
        if (!_allowedTokens[token]) revert TokenNotAllowed(token);
    }

    function _checkBalance(address token, uint256 needed) private view {
        uint256 available = IERC20(token).balanceOf(address(this));
        if (available < needed) revert InsufficientBalance(token, available, needed);
    }

    function _remaining(uint256 cap, uint256 spent) private pure returns (uint256) {
        return cap > spent ? cap - spent : 0;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILeashVault
/// @notice The frozen public surface of a LeashPay vault: an AI payments agent
///         moves stablecoins out of this vault, but only inside rules that the
///         contract (not the prompt) enforces.
/// @dev FROZEN ABI shared by Builder A (contracts) and Builder B (agent + UI).
///      Change it only through the change rule in docs/vault-abi.md, and
///      regenerate contracts/abi/frozen-signatures.txt in the same PR.
///
///      Roles:
///      - owner: the wallet that created the vault through the factory. Fixed
///        forever (no transfer, no renounce).
///      - agent: the agent server's key. It can call pay, swap, sweepToTBill
///        and redeemFromTBill, and nothing else. It can never withdraw or
///        change rules.
///
///      Units:
///      - Token amounts are in base units. The only payout tokens are the
///        deployment's USDT and USDC, both 18 decimals; caps count them 1:1.
///      - Prices are USD with 18 decimals.
///      - Basis points: 10_000 = 100%.
///      - "Today" is the UTC day bucket block.timestamp / 1 days.
///      - "This month" is the 30-day bucket block.timestamp / 30 days.
///        Spending can reach up to 2x a cap across a bucket boundary.
interface ILeashVault {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Spending and safety rules, set by the owner.
    /// @param perPaymentCap Max amount for a single pay() call.
    /// @param dailyCap Max total paid out per UTC day, across all recipients.
    /// @param cooldown Seconds that must pass between two payments to the SAME
    ///        recipient. Different recipients can be paid back to back.
    /// @param maxSlippageBps Max swap shortfall versus the Atlas price, in
    ///        basis points. setRules rejects values above 200 (2%).
    /// @param dailySwapCap Max total swap() input per UTC day. Bounds what a
    ///        compromised agent can lose by swapping back and forth.
    /// @param minTokenPrice pay() refuses a coin whose Atlas price is below
    ///        this (18-decimal USD, for example 0.98e18). 0 turns the check off.
    struct Rules {
        uint256 perPaymentCap;
        uint256 dailyCap;
        uint256 cooldown;
        uint256 maxSlippageBps;
        uint256 dailySwapCap;
        uint256 minTokenPrice;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice A payment left the vault.
    /// @param ref The agent's plan id. Links this payment to the off-chain
    ///        evidence (plan, Cournot claim, probability and sources).
    event Paid(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed ref);

    /// @notice Stablecoins were swapped inside the vault.
    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 minAmountOut
    );

    /// @notice Idle USDT was moved into the tokenized T-bill.
    event SweptToTBill(uint256 assets, uint256 shares);

    /// @notice USDT was pulled back out of the tokenized T-bill.
    event RedeemedFromTBill(uint256 assets, uint256 shares);

    event RulesUpdated(Rules rules);
    event RecipientUpdated(address indexed recipient, bool allowed, uint256 monthlyCap);
    event TokenAllowedUpdated(address indexed token, bool allowed);
    event PriceFeedUpdated(address indexed token, address feed, uint256 maxAge);
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Kill switch turned on: every agent action is blocked.
    event Paused(address indexed by);

    /// @notice Kill switch turned off.
    event Unpaused(address indexed by);

    // ---------------------------------------------------------------------
    // Errors (each carries the values the agent and UI need to explain it)
    // ---------------------------------------------------------------------

    /// @notice The caller lacks the role this function needs (owner, agent,
    ///         or agent-or-owner).
    error Unauthorized(address caller);
    /// @notice The kill switch is on.
    error VaultPaused();
    error ZeroAddress();
    error ZeroAmount();
    /// @notice pay() needs a nonzero ref.
    error InvalidRef();
    /// @notice The rules are inconsistent: dailyCap is 0, perPaymentCap is
    ///         above dailyCap, maxSlippageBps is above 200, or minTokenPrice
    ///         is above 1e18.
    error InvalidRules();
    /// @notice The token is not the deployment's USDT or USDC, or the owner
    ///         turned it off.
    error TokenNotAllowed(address token);
    /// @notice The recipient is not on the owner's allowlist.
    error RecipientNotAllowed(address recipient);
    /// @notice This (ref, recipient) pair was already paid. Makes retries safe.
    error DuplicatePayment(bytes32 ref, address recipient);
    error ExceedsPaymentCap(uint256 amount, uint256 cap);
    error ExceedsDailyCap(uint256 amount, uint256 remaining);
    error ExceedsMonthlyCap(address recipient, uint256 amount, uint256 remaining);
    /// @param readyAt Unix time when this recipient can be paid again.
    error CooldownActive(address recipient, uint256 readyAt);
    error InsufficientBalance(address token, uint256 available, uint256 needed);
    error PriceFeedNotSet(address token);
    /// @notice The feed returned a zero or negative price.
    error InvalidPrice(address token, int256 answer);
    /// @notice The feed's last update is older than its maxAge.
    error StalePrice(address token, uint256 updatedAt, uint256 maxAge);
    /// @notice The coin trades below the owner's minTokenPrice (depeg floor).
    error PriceBelowFloor(address token, uint256 price, uint256 floor);
    /// @notice The DEX returned less than the Atlas-based minimum.
    error SlippageTooHigh(uint256 minAmountOut, uint256 actualAmountOut);
    error ExceedsSwapCap(uint256 amountIn, uint256 remaining);

    // ---------------------------------------------------------------------
    // Agent actions
    // ---------------------------------------------------------------------

    /// @notice Pay a recipient. The only function that sends value out of the
    ///         vault, so every rule is checked here.
    /// @dev Agent only. Reverts in this order: Unauthorized, VaultPaused,
    ///      ZeroAmount, InvalidRef, TokenNotAllowed, RecipientNotAllowed,
    ///      DuplicatePayment, ExceedsPaymentCap, CooldownActive,
    ///      ExceedsDailyCap, ExceedsMonthlyCap, then the price floor
    ///      (PriceFeedNotSet, InvalidPrice, StalePrice, PriceBelowFloor; only
    ///      when minTokenPrice > 0), then InsufficientBalance. Emits Paid.
    /// @param ref The agent's plan id (nonzero). Each (ref, recipient) pays once.
    function pay(address recipient, address token, uint256 amount, bytes32 ref) external;

    /// @notice Swap between USDT and USDC inside the vault. The output never
    ///         leaves the vault.
    /// @dev Agent or owner. The minimum output comes from the Atlas price of
    ///      both coins minus maxSlippageBps. Counts toward dailySwapCap
    ///      (a dailySwapCap of 0 blocks all swaps). Reverts in this order:
    ///      Unauthorized, VaultPaused, ZeroAmount, TokenNotAllowed (either
    ///      token, or tokenIn == tokenOut), ExceedsSwapCap, PriceFeedNotSet /
    ///      InvalidPrice / StalePrice (tokenIn, then tokenOut),
    ///      InsufficientBalance, SlippageTooHigh. Emits Swapped.
    function swap(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut);

    /// @notice Move idle USDT into the tokenized T-bill (the RWA treasury).
    /// @dev Agent or owner. Reverts Unauthorized, VaultPaused, ZeroAmount or
    ///      InsufficientBalance. Emits SweptToTBill.
    function sweepToTBill(uint256 assets) external returns (uint256 shares);

    /// @notice Pull USDT back out of the T-bill, for example before a payout.
    /// @dev Agent or owner. Reverts Unauthorized, VaultPaused, ZeroAmount or
    ///      InsufficientBalance (token = tbill, amounts in USDT terms).
    ///      Emits RedeemedFromTBill.
    function redeemFromTBill(uint256 assets) external returns (uint256 shares);

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Replace all rules at once. Reverts InvalidRules if inconsistent.
    /// @dev Every owner function reverts Unauthorized for any other caller.
    function setRules(Rules calldata rules) external;

    /// @notice Add, update or remove (allowed = false) a recipient.
    /// @dev Reverts ZeroAddress for recipient address(0).
    function setRecipient(address recipient, bool allowed, uint256 monthlyCap) external;

    /// @notice Turn USDT or USDC on or off. Any other token reverts
    ///         TokenNotAllowed.
    function setTokenAllowed(address token, bool allowed) external;

    /// @notice Point USDT or USDC at a price feed (Atlas on mainnet, the relay
    ///         on testnet), with the oldest acceptable update age in seconds.
    /// @dev Reverts TokenNotAllowed for any other token, ZeroAddress for feed
    ///      address(0), ZeroAmount for maxAge 0.
    function setPriceFeed(address token, address feed, uint256 maxAge) external;

    /// @notice Replace the agent key. address(0) fires the agent.
    function setAgent(address newAgent) external;

    /// @notice Kill switch: blocks pay, swap, sweepToTBill and redeemFromTBill.
    /// @dev Safe to call twice; each call emits Paused.
    function pause() external;

    /// @dev Safe to call twice; each call emits Unpaused.
    function unpause() external;

    /// @notice Owner withdrawal of any token, including T-bill shares.
    ///         Works while paused, so the owner can always recover funds.
    /// @dev Reverts ZeroAddress (to), ZeroAmount or InsufficientBalance.
    function withdraw(address token, uint256 amount, address to) external;

    // ---------------------------------------------------------------------
    // Views (window math already applied; the UI never recomputes it)
    // ---------------------------------------------------------------------

    function owner() external view returns (address);

    function agent() external view returns (address);

    function paused() external view returns (bool);

    function rules() external view returns (Rules memory);

    /// @return allowed Whether the recipient is on the allowlist.
    /// @return monthlyCap The recipient's cap per 30-day bucket.
    /// @return spentThisMonth Paid to them in the current 30-day bucket.
    /// @return lastPaidAt Unix time of their last payment (0 if never).
    function recipientInfo(address recipient)
        external
        view
        returns (bool allowed, uint256 monthlyCap, uint256 spentThisMonth, uint256 lastPaidAt);

    /// @notice Total paid out in the current UTC day.
    function spentToday() external view returns (uint256);

    /// @notice Total swap input in the current UTC day.
    function swappedToday() external view returns (uint256);

    function isTokenAllowed(address token) external view returns (bool);

    function priceFeed(address token) external view returns (address feed, uint256 maxAge);

    /// @notice The validated Atlas price the vault itself uses (18-decimal
    ///         USD). Reverts like swap: PriceFeedNotSet, InvalidPrice or
    ///         StalePrice.
    function getPrice(address token) external view returns (uint256 price, uint256 updatedAt);

    /// @notice The tokenized T-bill (an ERC-4626 vault over USDT).
    function tbill() external view returns (address);

    /// @notice USDT value of the T-bill shares the vault holds.
    function tbillValue() external view returns (uint256 assets);
}

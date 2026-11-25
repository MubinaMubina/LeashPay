# LeashVault ABI reference

This is the complete reference for the vault interface that sits between LeashPay's smart contracts (Builder A) and its AI agent and web app (Builder B). The agent server and the dashboard call exactly these functions, listen for these events and show these errors. Builder A's `LeashVault` must implement every one of them.

**Status:** frozen. Builder A reviewed and approved v1, and it was merged into `main` on 25 Nov 2026. The interfaces compile; no contract implements them or is deployed yet.

- Source: [`contracts/src/interfaces/`](../contracts/src/interfaces/)
- Frozen signature list: [`contracts/abi/frozen-signatures.txt`](../contracts/abi/frozen-signatures.txt)
- Why it looks this way: [vault-design.md](vault-design.md)
- Checking an implementation: [how-to-check-abi.md](how-to-check-abi.md)
- Changing it after the freeze: [how-to-change-abi.md](how-to-change-abi.md)

## At a glance

| Interface | File | Functions | Events | Errors | Implemented by |
|---|---|---|---|---|---|
| `ILeashVault` | [ILeashVault.sol](../contracts/src/interfaces/ILeashVault.sol) | 24 | 12 | 20 | `LeashVault` (Builder A) |
| `ILeashVaultFactory` | [ILeashVaultFactory.sol](../contracts/src/interfaces/ILeashVaultFactory.sol) | 3 | 1 | 1 | `LeashVaultFactory` (Builder A) |
| `IPriceFeed` | [IPriceFeed.sol](../contracts/src/interfaces/IPriceFeed.sol) | 2 | 0 | 0 | Atlas SingleFeed on mainnet, `AtlasRelayFeed` on testnet |
| `IFaucetToken` | [IFaucetToken.sol](../contracts/src/interfaces/IFaucetToken.sol) | 1 | 0 | 0 | Mock USDT and USDC (testnet only) |

All four compile with solc 0.8.28 (`pragma solidity ^0.8.24`). The counts come from the compiled ABI, not from this page.

## Roles

| Role | Who | Can call | Can never |
|---|---|---|---|
| **owner** | The wallet that called `createVault` (a Privy email wallet in the app). Fixed forever: there is no transfer and no renounce. | Every owner function, plus `swap`, `sweepToTBill`, `redeemFromTBill` | `pay` (paying is the agent's job) |
| **agent** | The agent server's key. Starts as `factory.config().defaultAgent`; the owner can replace it or fire it. | `pay`, `swap`, `sweepToTBill`, `redeemFromTBill` | `withdraw`, any setter, `pause`, `unpause` |
| **anyone** | Any address | Every view; sending USDT or USDC to the vault address (that is how deposits work) | Everything else |

A third key exists only on testnet: the **reporter**, which updates the testnet price relay (see [Price feeds](#ipricefeed)). It is not part of the vault and must never be the agent key.

## Units and conventions

- **Token amounts** are in base units. The only payout tokens are the deployment's USDT and USDC, and both use **18 decimals** (like Binance-Peg USDT and USDC on BSC; Ethereum's versions use 6). So 300 USDT is `300e18`. Caps count USDT and USDC 1:1.
- **Prices** are USD with 18 decimals: `1e18` is one dollar, `0.98e18` is 98 cents.
- **Basis points (bps):** `10_000` is 100%, `100` is 1%.
- **"Today"** is the UTC day: `block.timestamp / 1 days`. Daily counters reset at 00:00 UTC.
- **"This month"** is a 30-day bucket: `block.timestamp / 30 days`. It is not a calendar month. Spending can reach up to twice a cap across a bucket boundary (end of one bucket plus start of the next); this is a known, accepted limit.
- **`ref`** is a nonzero `bytes32` that the agent picks per payment plan (its plan id). Each `(ref, recipient)` pair can be paid only once. The agent server stores what each `ref` means: the plan, the Cournot claim, probability and sources.
- **Deposits** have no function. Send USDT or USDC to the vault address with a normal ERC-20 transfer. On testnet, call `mint(vault, amount)` on the mock token to fund the vault in one transaction.

## Types

### `ILeashVault.Rules`

Set with `setRules` or passed to `createVault`. Any constraint below that fails reverts with `InvalidRules`.

| Field | Type | Meaning | Constraint |
|---|---|---|---|
| `perPaymentCap` | `uint256` (token units) | Most a single `pay` can send | `<= dailyCap` |
| `dailyCap` | `uint256` (token units) | Most the vault pays out per UTC day, all recipients together | `> 0` |
| `cooldown` | `uint256` (seconds) | Minimum time between two payments to the **same** recipient. Different recipients can be paid back to back. | none |
| `maxSlippageBps` | `uint256` (bps) | How far below the Atlas-based price a swap may land | `<= 200` (2%) |
| `dailySwapCap` | `uint256` (token units) | Most `swap` input per UTC day. `0` blocks all swaps. | none |
| `minTokenPrice` | `uint256` (18-decimal USD) | `pay` refuses a coin whose Atlas price is below this (the depeg floor). `0` turns the check off. | `<= 1e18` |

### `ILeashVaultFactory.Config`

Read with `config()`. This is why the apps only need one address, `FACTORY_ADDRESS`.

| Field | Type | Meaning |
|---|---|---|
| `usdt` | `address` | USDT (a mock token on testnet) |
| `usdc` | `address` | USDC (a mock token on testnet) |
| `usdtFeed` | `address` | USDT price feed: Atlas on mainnet, the relay on testnet |
| `usdcFeed` | `address` | USDC price feed: Atlas on mainnet, the relay on testnet |
| `maxPriceAge` | `uint256` (seconds) | Default oldest acceptable feed update for new vaults |
| `tbill` | `address` | The tokenized T-bill, an ERC-4626 vault over USDT |
| `dex` | `address` | The DEX the vault swaps through (MockDEX on testnet) |
| `defaultAgent` | `address` | The agent key every new vault starts with |

## `ILeashVault` functions

### Agent actions

#### `pay(address recipient, address token, uint256 amount, bytes32 ref)`

Pays a recipient. This is the **only** function that sends value out of the vault to someone other than the owner, so every rule is checked here.

- **Caller:** agent only.
- **Checks, in this order:** the first failing check decides the error.
  1. `Unauthorized(caller)`: caller is not the agent
  2. `VaultPaused()`: kill switch is on
  3. `ZeroAmount()`: `amount == 0`
  4. `InvalidRef()`: `ref == 0`
  5. `TokenNotAllowed(token)`: not USDT or USDC, or turned off
  6. `RecipientNotAllowed(recipient)`: not on the allowlist
  7. `DuplicatePayment(ref, recipient)`: this pair was already paid
  8. `ExceedsPaymentCap(amount, cap)`
  9. `CooldownActive(recipient, readyAt)`
  10. `ExceedsDailyCap(amount, remaining)`
  11. `ExceedsMonthlyCap(recipient, amount, remaining)`
  12. Only when `minTokenPrice > 0`: `PriceFeedNotSet`, `InvalidPrice`, `StalePrice`, then `PriceBelowFloor(token, price, floor)`
  13. `InsufficientBalance(token, available, needed)`
- **Emits:** `Paid(recipient, token, amount, ref)`.

#### `swap(address tokenIn, address tokenOut, uint256 amountIn) returns (uint256 amountOut)`

Swaps between USDT and USDC inside the vault. The output stays in the vault.

- **Caller:** agent or owner.
- **Minimum output:** `amountIn * priceIn / priceOut * (10_000 - maxSlippageBps) / 10_000`, using the vault's own Atlas prices.
- **Checks, in this order:** `Unauthorized`, `VaultPaused`, `ZeroAmount`, `TokenNotAllowed` (either token, or `tokenIn == tokenOut`), `ExceedsSwapCap(amountIn, remaining)`, then `PriceFeedNotSet` / `InvalidPrice` / `StalePrice` for `tokenIn` and then `tokenOut`, `InsufficientBalance`, `SlippageTooHigh(minAmountOut, actualAmountOut)`.
- **Counts toward** `dailySwapCap`.
- **Emits:** `Swapped(tokenIn, tokenOut, amountIn, amountOut, minAmountOut)`.

#### `sweepToTBill(uint256 assets) returns (uint256 shares)`

Moves idle USDT into the tokenized T-bill, the vault's real-world-asset treasury.

- **Caller:** agent or owner.
- **Checks:** `Unauthorized`, `VaultPaused`, `ZeroAmount`, `InsufficientBalance`.
- **Emits:** `SweptToTBill(assets, shares)`.

#### `redeemFromTBill(uint256 assets) returns (uint256 shares)`

Pulls USDT back out of the T-bill, for example right before a payout. `assets` is in USDT terms; `shares` is the T-bill shares burned.

- **Caller:** agent or owner.
- **Checks:** `Unauthorized`, `VaultPaused`, `ZeroAmount`, `InsufficientBalance` (token = the T-bill, amounts in USDT terms).
- **Emits:** `RedeemedFromTBill(assets, shares)`.

### Owner actions

Every function in this section reverts `Unauthorized(caller)` for anyone but the owner.

| Function | What it does | Other reverts | Emits |
|---|---|---|---|
| `setRules(Rules rules)` | Replaces all rules at once | `InvalidRules` | `RulesUpdated(rules)` |
| `setRecipient(address recipient, bool allowed, uint256 monthlyCap)` | Adds, updates or removes (`allowed = false`) a recipient | `ZeroAddress` | `RecipientUpdated(recipient, allowed, monthlyCap)` |
| `setTokenAllowed(address token, bool allowed)` | Turns USDT or USDC on or off, for example to stop paying in a coin that is losing its peg | `TokenNotAllowed` for any other token | `TokenAllowedUpdated(token, allowed)` |
| `setPriceFeed(address token, address feed, uint256 maxAge)` | Points USDT or USDC at a price feed with the oldest acceptable update age | `TokenNotAllowed` (other token), `ZeroAddress` (feed), `ZeroAmount` (`maxAge == 0`) | `PriceFeedUpdated(token, feed, maxAge)` |
| `setAgent(address newAgent)` | Replaces the agent key. `address(0)` fires the agent. | none | `AgentUpdated(previousAgent, newAgent)` |
| `pause()` | Kill switch on: blocks `pay`, `swap`, `sweepToTBill`, `redeemFromTBill`. Safe to call twice. | none | `Paused(by)` |
| `unpause()` | Kill switch off. Safe to call twice. | none | `Unpaused(by)` |
| `withdraw(address token, uint256 amount, address to)` | Sends any token, including T-bill shares, to `to`. **Works while paused**, so the owner can always recover funds. | `ZeroAddress` (to), `ZeroAmount`, `InsufficientBalance` | `Withdrawn(token, to, amount)` |

### Views

Anyone can call these. Window math is already applied, so the UI never recomputes daily or monthly totals.

| Function | Returns |
|---|---|
| `owner()` | The fixed owner |
| `agent()` | The current agent key (`address(0)` if fired) |
| `paused()` | Whether the kill switch is on |
| `rules()` | The current `Rules` |
| `recipientInfo(address recipient)` | `allowed`, `monthlyCap`, `spentThisMonth` (current 30-day bucket), `lastPaidAt` (0 if never paid) |
| `spentToday()` | Total paid out in the current UTC day |
| `swappedToday()` | Total swap input in the current UTC day |
| `isTokenAllowed(address token)` | Whether `pay` and `swap` accept the token |
| `priceFeed(address token)` | The feed address and its `maxAge` |
| `getPrice(address token)` | The validated Atlas price the vault itself uses (18-decimal USD) and its `updatedAt`. Reverts like `swap`: `PriceFeedNotSet`, `InvalidPrice`, `StalePrice`. |
| `tbill()` | The T-bill token address |
| `tbillValue()` | USDT value of the T-bill shares the vault holds |

Useful derived values for the dashboard:

- Left to pay today: `rules().dailyCap - spentToday()`
- Left for a recipient this month: `monthlyCap - spentThisMonth`
- Next allowed payment to a recipient: `lastPaidAt + rules().cooldown` (any time if `lastPaidAt == 0`)
- Vault balance per coin: `balanceOf(vault)` on the USDT and USDC tokens, plus `tbillValue()`

## Events

| Event | Indexed | Emitted by | Typical use |
|---|---|---|---|
| `Paid(recipient, token, amount, ref)` | `recipient`, `token`, `ref` | `pay` | Recipient page (filter by `recipient`), plan status (filter by `ref`), BscScan links |
| `Swapped(tokenIn, tokenOut, amountIn, amountOut, minAmountOut)` | `tokenIn`, `tokenOut` | `swap` | Show the depeg route switch and the slippage bound |
| `SweptToTBill(assets, shares)` | none | `sweepToTBill` | Treasury history |
| `RedeemedFromTBill(assets, shares)` | none | `redeemFromTBill` | Treasury history |
| `RulesUpdated(rules)` | none | `setRules`, vault creation | Rules history |
| `RecipientUpdated(recipient, allowed, monthlyCap)` | `recipient` | `setRecipient` | Allowlist history |
| `TokenAllowedUpdated(token, allowed)` | `token` | `setTokenAllowed` | Token switch history |
| `PriceFeedUpdated(token, feed, maxAge)` | `token` | `setPriceFeed`, vault creation | Feed configuration |
| `AgentUpdated(previousAgent, newAgent)` | `previousAgent`, `newAgent` | `setAgent`, vault creation | Show who the agent is, or that it was fired |
| `Withdrawn(token, to, amount)` | `token`, `to` | `withdraw` | Owner withdrawals |
| `Paused(by)` | `by` | `pause` | Kill switch on |
| `Unpaused(by)` | `by` | `unpause` | Kill switch off |

A reverted transaction emits no events. The agent learns why a payment failed from the revert error, not from logs.

## Errors

Every error carries the values the agent and the UI need to explain it. The last column is a suggested message for the dashboard and agent chat.

| Error | Raised by | Message to show |
|---|---|---|
| `Unauthorized(address caller)` | Every gated function | "This wallet isn't allowed to do that." |
| `VaultPaused()` | `pay`, `swap`, `sweepToTBill`, `redeemFromTBill` | "The vault is paused by its owner. Nothing goes out until it's resumed." |
| `ZeroAddress()` | `setRecipient`, `setPriceFeed`, `withdraw` | "An address is missing." |
| `ZeroAmount()` | `pay`, `swap`, `sweepToTBill`, `redeemFromTBill`, `withdraw`, `setPriceFeed` | "The amount must be more than zero." |
| `InvalidRef()` | `pay` | "Internal error: the payment has no plan reference." |
| `InvalidRules()` | `setRules`, `createVault` | "These rules don't fit together. Check the caps, the slippage limit (2% max) and the price floor ($1 max)." |
| `TokenNotAllowed(address token)` | `pay`, `swap`, `setTokenAllowed`, `setPriceFeed` | "{token} isn't enabled for this vault." |
| `RecipientNotAllowed(address recipient)` | `pay` | "Blocked: {recipient} isn't on your recipient list." |
| `DuplicatePayment(bytes32 ref, address recipient)` | `pay` | "{recipient} was already paid for this plan. Nothing was sent twice." |
| `ExceedsPaymentCap(uint256 amount, uint256 cap)` | `pay` | "{amount} is over the {cap} limit per payment." |
| `ExceedsDailyCap(uint256 amount, uint256 remaining)` | `pay` | "Only {remaining} is left in today's limit." |
| `ExceedsMonthlyCap(address recipient, uint256 amount, uint256 remaining)` | `pay` | "Only {remaining} is left for {recipient} this month." |
| `CooldownActive(address recipient, uint256 readyAt)` | `pay` | "{recipient} was paid recently. The next payment is possible at {readyAt}." |
| `InsufficientBalance(address token, uint256 available, uint256 needed)` | `pay`, `swap`, `sweepToTBill`, `redeemFromTBill`, `withdraw` | "Not enough {token}: {available} available, {needed} needed." |
| `PriceFeedNotSet(address token)` | `pay` (floor on), `swap`, `getPrice` | "No price feed is set for {token}." |
| `InvalidPrice(address token, int256 answer)` | `pay` (floor on), `swap`, `getPrice` | "The price feed for {token} returned an invalid price." |
| `StalePrice(address token, uint256 updatedAt, uint256 maxAge)` | `pay` (floor on), `swap`, `getPrice` | "The {token} price is out of date (last update {updatedAt})." |
| `PriceBelowFloor(address token, uint256 price, uint256 floor)` | `pay` | "{token} trades at {price}, below your {floor} floor, so paying in it is blocked." |
| `SlippageTooHigh(uint256 minAmountOut, uint256 actualAmountOut)` | `swap` | "The swap would return {actualAmountOut}, below the minimum {minAmountOut}. Cancelled." |
| `ExceedsSwapCap(uint256 amountIn, uint256 remaining)` | `swap` | "Only {remaining} of today's swap limit is left." |
| `VaultAlreadyExists(address owner, address vault)` (factory) | `createVault` | "You already have a vault." Then open `vaultOf(owner)`. |

One more error can appear but is not in the interface: OpenZeppelin's `ReentrancyGuardReentrantCall()`, inherited by the implementation. It only fires during a reentrancy attack. Builder B's final TypeScript ABI is generated from Builder A's compiled contract, so it includes it.

## Rules, errors and required tests

The interface fixes names and types. This table fixes **behavior**: each rule, the error that proves it, and the Foundry test Builder A writes for it. Status: none of these tests exist yet; they are Builder A's next work.

| Rule | Error | Foundry test |
|---|---|---|
| Only the agent pays | `Unauthorized` | `test_pay_revertsWhenCallerIsNotAgent` |
| Kill switch blocks the agent but not the owner's rescue | `VaultPaused` | `test_pay_revertsWhenPaused`, `test_withdraw_worksWhilePaused` |
| Allowlist | `RecipientNotAllowed` | `test_pay_revertsForUnknownRecipient` |
| Each `(ref, recipient)` pays once | `DuplicatePayment` | `test_pay_revertsOnDuplicateRef` |
| Per-payment cap | `ExceedsPaymentCap` | `test_pay_revertsAbovePerPaymentCap` |
| Cooldown is per recipient | `CooldownActive` | `test_pay_cooldownBlocksSameRecipient`, `test_pay_cooldownAllowsOtherRecipients` |
| Daily cap and its reset | `ExceedsDailyCap` | `test_pay_revertsAboveDailyCap`, `test_pay_dailyCapResetsNextUtcDay` |
| Monthly cap and its reset | `ExceedsMonthlyCap` | `test_pay_revertsAboveMonthlyCap`, `test_pay_monthlyCapResetsNextBucket` |
| Depeg floor | `PriceBelowFloor` | `test_pay_revertsBelowPriceFloor`, `test_pay_floorZeroSkipsOracle` |
| Only USDT and USDC | `TokenNotAllowed` | `test_pay_revertsForOtherToken`, `test_setTokenAllowed_rejectsOtherToken` |
| Fresh, valid prices | `StalePrice`, `InvalidPrice`, `PriceFeedNotSet` | `test_swap_revertsOnStalePrice`, `test_swap_revertsOnNonPositivePrice`, `test_swap_revertsWithoutFeed` |
| Swap bounded by the Atlas price | `SlippageTooHigh` | `test_swap_revertsOnRiggedDexRate` |
| Daily swap cap | `ExceedsSwapCap` | `test_swap_revertsAboveDailySwapCap` |
| No leftover token approval | none | `test_swap_leavesZeroAllowance` |
| Rule validation | `InvalidRules` | `test_setRules_rejectsInconsistentRules` (all four constraints) |
| Firing the agent works | `Unauthorized` | `test_setAgent_zeroRevokesOldAgent` |
| Owner-only setters | `Unauthorized` | `test_ownerFunctions_rejectOtherCallers` |
| T-bill round trip grows in value | none | `test_tbill_sweepRedeemRoundTripGrowsValue` |
| One vault per owner | `VaultAlreadyExists` | `test_factory_secondVaultReverts` |
| The ABI matches the freeze | signature check | [how-to-check-abi.md](how-to-check-abi.md), run in CI |

## `ILeashVaultFactory`

| Member | Description |
|---|---|
| `createVault(Rules rules) returns (address vault)` | Creates the caller's vault. The caller becomes its fixed owner, the agent is `config().defaultAgent`, and USDT and USDC are allowed with their feeds set. Reverts `VaultAlreadyExists`, or `ILeashVault.InvalidRules` from the new vault's constructor. Decode its reverts with the factory and vault ABIs together. |
| `vaultOf(address owner) returns (address vault)` | The owner's vault, or `address(0)` if none. |
| `config() returns (Config)` | The deployment's addresses (see [Types](#ileashvaultfactoryconfig)). |
| `event VaultCreated(owner, vault, agent)` | All three fields indexed. |
| `error VaultAlreadyExists(address owner, address vault)` | The caller already has a vault. |

## `IPriceFeed`

The vault reads prices through two functions that are ABI-compatible with Atlas's `ISingleFeed` and Chainlink's `AggregatorV3Interface`:

```solidity
function decimals() external view returns (uint8);
function latestRoundData() external view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
```

| Network | Feed | Notes |
|---|---|---|
| BSC mainnet | Atlas SingleFeed proxy per pair ([Atlas push-mode docs](https://docs.atlasoracle.io/developers/atlas-oracle/integrate-the-push-mode)) | Atlas can restrict reads to approved contracts. The vault address would need approval. |
| BSC testnet | `AtlasRelayFeed` (Builder A) | Atlas lists no testnet feeds, so a reporter reads the **mainnet** Atlas answer and `updatedAt` and writes them to the relay. |

Rules every consumer follows:

- Reject `answer <= 0` (`InvalidPrice`).
- Reject `block.timestamp - updatedAt > maxAge` (`StalePrice`).
- Normalize with `decimals()` to 18-decimal USD.
- Ignore `roundId` and `answeredInRound`. Atlas fills them with a constant (`1`), so round-based checks prove nothing.

## `IFaucetToken`

```solidity
function mint(address to, uint256 amount) external;
```

Testnet only, on the mock USDT and USDC (standard 18-decimal ERC-20 tokens plus this function). Each call is capped by the token. Mint straight to a vault address to fund it in one transaction. For every other token function, use the standard ERC-20 ABI (in viem: `erc20Abi`).

## Freeze and change rule

These are frozen:

- the four files in [`contracts/src/interfaces/`](../contracts/src/interfaces/)
- [`contracts/abi/frozen-signatures.txt`](../contracts/abi/frozen-signatures.txt), generated from them

After the freeze, a change needs **both builders' agreement first**, then one PR that edits the interface, regenerates `frozen-signatures.txt` and adds a line to the changelog below. The steps are in [how-to-change-abi.md](how-to-change-abi.md). Adding something new is safe for existing callers; renaming or retyping something breaks the other builder's code.

## Notes for implementers (Builder A)

These are not part of the freeze. They are the traps that would make an implementation fail the signature check.

- Declare `contract LeashVault is ILeashVault, ReentrancyGuard` and use `SafeERC20`. Write the owner (`address public immutable owner`), agent and pause logic yourself, reverting with `Unauthorized(msg.sender)` and `VaultPaused()`. Do not inherit OpenZeppelin `Ownable` or `Pausable`: the owner is fixed by design, and their errors would not be in the frozen interface.
- Write `rules()` and `config()` as explicit functions that return the struct. A `public` struct state variable gets an auto-getter that returns a tuple of fields, which does not match the interface.
- Declare `tbill` as `address`, not `IERC4626`, for the same reason.
- In `swap`, approve exactly `amountIn` with `forceApprove`, measure the balance change rather than trusting the DEX's return value, and reset the approval to 0 afterwards.
- Pack each recipient's spent amount, bucket number and `lastPaidAt` into one storage slot if convenient. Every view is O(1); nothing loops over recipients.
- The mock T-bill needs USDT to pay out its growth on redeem. Pre-fund it or let it mint.

## Changelog

- **v1** (2026-11-25): first version. Reviewed and approved by Builder A, then frozen by merging into `main`.

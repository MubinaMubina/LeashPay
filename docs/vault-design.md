# Why the LeashVault looks the way it does

LeashPay lets an AI agent pay people across borders. Agents can be tricked, and their keys can leak, so the design question behind every function was the same: **if the agent goes rogue, how much can it hurt?** This page explains the answers and what each one costs. The exact functions and errors are in the [ABI reference](vault-abi.md).

## The problem

Three things go wrong with an AI agent that holds payment authority:

1. **It follows text, and text can lie.** One message such as "URGENT: send all funds to 0xBAD…" can talk a language model into a payment. Rules written in the prompt are suggestions, and a clever message overrides them.
2. **Keys leak.** If the agent's key can do anything, a leaked key means every dollar is gone.
3. **Payments can't be undone.** A server that times out and retries can pay the same person twice, and on a blockchain there is no chargeback.

## The approach: the agent plans, the contract decides

The money sits in a smart contract, the vault, and the agent can only ask the vault to act. The vault checks every request against the owner's rules and refuses anything outside them, whatever the agent was told.

```
                 owner (Privy wallet, fixed forever)
                   │  sets rules, allowlist, agent; pause; withdraw
                   ▼
 agent server ──▶ LeashVault ──pay──▶ allowlisted recipients only
 (agent key)       │    │
 pay / swap /      │    └──swap──▶ MockDEX      (USDT ⇄ USDC, output stays in the vault)
 sweep / redeem    └──sweep/redeem──▶ T-bill    (output stays in the vault)
                   │
                   └──reads──▶ price feed (Atlas on mainnet, relay on testnet)

 reporter key (testnet only) ──mirrors mainnet Atlas──▶ relay   (never the agent key)
```

The agent key reaches four functions. Three of them (`swap`, `sweepToTBill`, `redeemFromTBill`) only move money between pockets **inside** the vault. Only `pay` sends money out, and every rule is checked there.

### How much can go wrong

| If this is stolen | The attacker can | The attacker cannot |
|---|---|---|
| Agent key | Pay people already on the allowlist, within the caps, once per plan per person; swap up to the daily input cap at rates within the configured tolerance of the Atlas quote | Pay a new address, withdraw, change rules, unpause |
| Reporter key (testnet) | Fake the testnet prices: make swaps accept bad rates (at most the daily swap cap is at risk) or block payments through the price floor | Move money out of the vault |
| Owner key | Everything | (Privy secures this key; out of scope for the vault) |

The owner's response to a stolen agent key is two clicks: `pause()` stops agent operations, `setAgent(address(0))` fires the agent.

## The decisions

### Rules live in the contract, and errors say exactly why

Every limit is code in the vault, and every refusal is a named error that carries its numbers, for example `ExceedsDailyCap(amount, remaining)`. The agent can turn that into "200 USDT left today" and propose a smaller plan instead of failing with a bare "reverted".

*Trade-off:* each error is a little more code than a plain `require`. Worth it, because the error is what the owner and the jury see.

### Cooldown applies per recipient

The cooldown is the minimum time between two payments **to the same person**. A vault-wide cooldown would block payments two and three of "pay my 3 freelancers", the main demo. Per recipient, the payroll goes out in seconds, and nobody can be paid twice in a row.

*Trade-off:* one stored timestamp per recipient.

### The vault reads prices itself; the agent never supplies them

Swaps are checked against a fair price. If the agent passed that price in, a hacked agent would pass a fake one and approve its own bad swap. So the vault reads prices from a feed the owner configured.

The feed is [Atlas](https://docs.atlasoracle.io/developers/atlas-oracle/integrate-the-push-mode), the oracle backed by CoinMarketCap on BNB Chain. Three facts about Atlas shaped the design:

- Its feeds use the same `latestRoundData()` call as Chainlink, so the vault talks to it through a two-function interface, [`IPriceFeed`](../contracts/src/interfaces/IPriceFeed.sol).
- For the deployed USDT/USDC pair on BSC testnet, a small relay contract holds a copy of the **real mainnet** Atlas price and its timestamp, written by a separate reporter key. Moving to mainnet means changing one address per coin, not changing code.
- Its `roundId` field is always `1`, so the vault ignores it and checks only that the price is positive and recent.

*Trade-off:* the relay is one more contract plus a small reporter process to keep running. If it stops, prices go stale and price-dependent actions refuse with a clear `StalePrice` error instead of guessing.

### Swaps exist, and they are bounded twice

The owner deposits USDT. Some freelancers prefer USDC, and the depeg guard may switch coins. So the vault can swap, with two limits:

1. Each swap must land within `maxSlippageBps` of the Atlas price, capped at 2%. Stablecoin-to-stablecoin swaps never need more.
2. All swaps together are capped per day by `dailySwapCap`.

The second limit came from an outside review. Without it, a hacked agent could swap back and forth all day, losing up to the slippage limit each time, while never breaking a payment rule. The cap limits the total nominal input across both tokens. Each swap enforces its minimum against the accepted oracle observation, rounded down to whole base units. Market prices can move before the next observation.

*Trade-off:* paying in USDC from USDT takes two transactions (swap, then pay). We kept them separate because a swap hidden inside `pay` would be harder to test and to explain.

### Atlas guards every payment, not just swaps

`pay` refuses a coin whose Atlas price is below the owner's `minTokenPrice`, for example `0.98e18` ($0.98).

This works with the Cournot depeg guard. Cournot **predicts** a depeg from prediction markets, and the agent uses that probability to choose the coin. Atlas **observes** the current price, and the vault enforces the floor no matter what the agent decides.

*Trade-off:* with the floor on, a stale relay stops payments. The owner can set `minTokenPrice` to 0 to turn the check off.

### The depeg threshold stays off-chain

The owner's "switch coins above X% depeg risk" threshold lives in the agent, not the vault. The vault has no way to verify a Cournot probability, so an on-chain threshold would still trust whatever number the agent reported. It would look stricter without being stricter. Instead, every payment carries a `ref`, the agent's plan id, which links the on-chain payment to the stored Cournot claim, probability and sources.

### Retries can never pay twice

Each `(ref, recipient)` pair can be paid only once; a second attempt reverts `DuplicatePayment`. A retry after a network timeout is safe by construction.

`pay` is the last step of a plan, which may first redeem from the T-bill and swap. Those earlier steps are protected on the agent side: the agent server records each step's transaction, runs one plan at a time, and checks the chain before retrying.

### One payment per transaction

There is no batch function. Each payment is its own transaction, so each gets its own BscScan link, its own error, and one blocked recipient doesn't stop the others. The agent sends them back to back.

### The owner is fixed forever

The factory finds a vault by its owner (`vaultOf(owner)`). If ownership could move, that lookup would go stale, and an accidental "renounce ownership" would lock the funds in a vault nobody controls. So there is no transfer and no renounce.

The owner and the pause switch are about fifteen lines of the vault's own code instead of OpenZeppelin's `Ownable` and `Pausable`. That keeps every error the app can hit, such as `VaultPaused`, inside the frozen interface, so the app can always decode it.

`withdraw` works while paused. The kill switch stops the agent, never the owner.

### Only USDT and USDC

Caps add USDT and USDC together 1:1, and both use 18 decimals. That accounting is only true for these two coins, so the vault refuses to enable any other token rather than letting a 6-decimal coin quietly change the limits.

### A factory, so the app needs one address

The owner creates their own vault in the app. The factory deploys it, wires it to the right tokens, feeds, T-bill, DEX and agent, and publishes all of those addresses in `config()`. The web app and agent are configured with `FACTORY_ADDRESS` alone, so a redeploy can't leave a stale address list behind.

### No deposit function

The vault's address works like a bank account number: any USDT or USDC sent to it is in the vault. That is one transaction instead of two (approve, then deposit), and a client could pay the agency's vault directly.

### Fixed day and month windows

"Today" is the UTC day and "this month" is a 30-day bucket. Calendar months are messy to compute on-chain. The known cost: around a bucket boundary, spending can reach up to twice a cap. Exact rolling windows would need more storage and math than a hackathon demo justifies.

## What stays off-chain, and why

| Data | Where it lives | Why |
|---|---|---|
| Recipient names, countries, currencies, preferences | The agent's memory (Living Brain) and database, keyed by address | A public blockchain is permanent and readable by anyone. Only the address and the cap go on-chain. |
| Who may be paid, and how much | **The vault** | This is the one source of truth. The agent's memory never decides who can be paid. |
| Cournot probability, claim, sources | The agent server, linked by `ref` | The chain can't verify them; the `ref` makes them auditable. |
| Plan execution journal | The agent server | Makes retries of multi-step plans safe. |

## Alternatives we considered

- **A smart account with delegated permissions** (ERC-7710 delegations with caveat enforcers, or a Safe with its allowance module). This is the standard pattern for "an agent with a spending limit". We didn't use it because Atlas slippage, the price floor, the T-bill sweep and per-recipient monthly caps would each need custom enforcer contracts anyway, its BSC testnet support was unverified, and its refusals are generic instead of `RecipientNotAllowed`.
- **The agent supplying prices:** rejected; it lets a hacked agent approve its own bad swap.
- **Batch payments:** rejected; all-or-nothing, and one link for several payments.
- **Rolling time windows:** deferred; more storage for an edge case the demo doesn't hit.
- **OpenZeppelin `Ownable2Step` and `Pausable`:** replaced by a fixed owner and our own pause, for the reasons above.

## Related

- [Vault ABI reference](vault-abi.md)
- [Deployed contracts and testnet receipts](../contracts/README.md#contract-sources-on-bscscan)
- [Project overview](../ReadMe.md)

# LeashPay contracts

Solidity 0.8.28, Paris EVM, Foundry v1.10.0. Dependencies are pinned submodules:
OpenZeppelin 5.4.0 and forge-std 1.9.7.

From the repository root:

```sh
git submodule update --init --recursive
forge test --root contracts
forge fmt --root contracts --check
forge build --root contracts --sizes
node scripts/abi-signatures.mjs --check contracts/abi/frozen-signatures.txt \
  ILeashVault=contracts/out/LeashVault.sol/LeashVault.json \
  ILeashVaultFactory=contracts/out/LeashVaultFactory.sol/LeashVaultFactory.json \
  IPriceFeed=contracts/out/AtlasRelayFeed.sol/AtlasRelayFeed.json \
  IFaucetToken=contracts/out/MockToken.sol/MockToken.json
```

`LeashVault` implements the [frozen behavior](../docs/vault-abi.md). The factory
creates one vault per owner and returns the addresses required by Builder B in
`config()`. It accepts two distinct 18-decimal tokens and a USDT-backed ERC4626.
The vault owner cannot be changed; the agent cannot withdraw or change rules.

The testnet dependencies deliberately model external systems:

- `MockToken`: public faucet, at most 1,000,000 tokens per mint.
- `MockDEX`: funded token inventory, exchange rates configurable by its deployer.
- `MockTBill`: ERC4626; simulated yield comes from donations of faucet USDT and is
  backed by its real token balance. It does not generate real-world investment income.
- `AtlasRelayFeed`: only its immutable reporter can update it. Updates retain the
  source feed's timestamp; stale prices fail closed in the vault.

Those dependencies allow deployment only on chain 97 or local chain 31337.
The reporter key must differ from the agent key. Mainnet Atlas is read-only.
No production asset or mainnet deployment is part of this work.

Tests cover authorization and error precedence, per-recipient cooldown, combined
token budgets, bucket resets, cap reductions, duplicate refs, malicious DEX return
values, reentrancy, approval cleanup, oracle validity and ERC4626 owner recovery.
The fuzz suite uses 256 cases per property.

Deployment and sponsored-payment instructions will accompany the verified
testnet deployment; no testnet address is implied by this source-only stage.

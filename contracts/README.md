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

## BSC testnet deployment

The chain 97 deployment is recorded in [deployments/97.json](deployments/97.json).
Factory: [`0x80b66347374C6df4f157368497201aa63a371f60`](https://testnet.bscscan.com/address/0x80b66347374C6df4f157368497201aa63a371f60).
Builder B needs only this factory address and the compiled frozen interfaces;
read token, feed, treasury, DEX and agent addresses from `factory.config()`.
Both factory variables are populated in the local ignored `.env`.

The [sponsored payment](https://testnet.bscscan.com/tx/0xc358512d795e0ea18e218f5816ecf2f32b386fff1bd5cde742648c15648a079d)
transferred 1 mock USDT from the demo vault to a controlled recipient. Its receipt
has `effectiveGasPrice = 0`, and the agent's BNB balance is unchanged across the
payment block. Evidence is in [97-smoke.json](deployments/97-smoke.json) and the
read-only receipt/event/revert checks in [97-checks.json](deployments/97-checks.json).
This validates the contract and agent signing key; the LLM agent and web UI still
need integration. Source publication on BscScan is pending explicit approval.

From the repository root, create an isolated Python environment and install the
operational dependencies:

```sh
python3 -m venv .setup/testnet-venv
.setup/testnet-venv/bin/pip install -r requirements-testnet.txt
.setup/testnet-venv/bin/python scripts/check-testnet.py --nodereal # read-only historical proof checks
.setup/testnet-venv/bin/python scripts/testnet.py relay # reporter transactions
```

`scripts/testnet.py` reads the root `.env` without printing credentials. Its
`deploy-dry-run`, `deploy`, `confirm`, `relay` and `smoke` actions are chain-97 only;
the mainnet source RPC permits reads only. The existing deployment must not be
repeated. Deployment writes Foundry journals, and the smoke test journals signed
transaction hashes before submission. Keep these ignored local files: a retry
checks the same receipt and never silently creates another payment. A signed
transaction without a receipt requires checking its hash and account nonce before
any recovery; do not delete the journal to retry.

The public RPC prunes historical account state. `check-testnet.py --nodereal`
uses the server-side NodeReal key with its
[BSC testnet endpoint](https://docs.nodereal.io/reference/getting-started-with-your-api)
to reread balances at the payment block, as well as validate the receipt and
simulate both refusals. This command sends no transactions.

After source-publication approval, `scripts/verify-testnet.py` uses the local
Etherscan key to submit the seven deployed contracts and the demo vault. It stores
only redacted logs locally and public verification outcomes in the deployments
directory. No key belongs in a command-line argument or a committed file.

## Oracle and demo limitations

Both relays preserve the timestamps of real Atlas mainnet observations. The free
[USDT](https://atlasoracle.io/feeds/649) and [USDC](https://atlasoracle.io/feeds/650)
push feeds advertise a 24-hour heartbeat, so this deployment uses a 25-hour
`maxPriceAge`. These prices are not instantaneous depeg signals. The latest
mirrored observations are recorded in [97-atlas.json](deployments/97-atlas.json).
The relay command is a manual refresh; no continuous worker is running yet.
If observations expire or fall below the owner's floor, payments fail closed.

The mock DEX starts with 100,000 units of each faucet token. The demo vault was
funded with 1,000 mock USDT; its owner, agent and reporter are separate test
wallets. Mock tokens, simulated T-bill returns and the permissive faucet are for
the hackathon testnet only. MegaFuel's private policy has its own funding, limits
and expiration; sponsorship eligibility is checked again before each new send.

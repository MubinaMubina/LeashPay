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
need integration.

From the repository root, create an isolated Python environment and install the
operational dependencies:

```sh
python3 -m venv .setup/testnet-venv
.setup/testnet-venv/bin/pip install -r scripts/requirements-testnet.txt
.setup/testnet-venv/bin/python scripts/check-testnet.py --nodereal # read-only historical proof checks
.setup/testnet-venv/bin/python scripts/testnet.py relay # reporter transactions
```

`scripts/testnet.py` reads the root `.env` without printing credentials. Its
`deploy-dry-run`, `deploy`, `confirm`, `relay` and `smoke` actions are chain-97 only;
the mainnet source RPC permits reads only. The existing deployment must not be
repeated. Deployment writes Foundry journals, and the smoke test journals signed
transaction hashes before submission. Keep these ignored local files: a retry
checks the same receipt and never silently creates another payment. For new journal entries, recovery can resubmit the identical signed transaction.
Keep the journal when investigating an unconfirmed hash.

The public RPC prunes historical account state. `check-testnet.py --nodereal`
uses the server-side NodeReal key with its
[BSC testnet endpoint](https://docs.nodereal.io/reference/getting-started-with-your-api)
to reread balances at the payment block, as well as validate the receipt and
simulate both refusals. This command sends no transactions.

### Contract sources on BscScan

BscScan reports **Exact Match** for seven addresses, including the vault and
factory. It reports **Similar Match** to the mUSDT implementation for mUSDC.
We also checked the mUSDC creation bytecode and its own name and symbol
against the [original deployment transaction](https://testnet.bscscan.com/tx/0x98969168dcbab3f92f5c148628e391af75ccd4521eab1dcb71e59886c39e2895).

| Contract | BSC testnet address |
|---|---|
| Demo vault | [`0x1df5aba120b14d2dd3878b876d9676c5a503b3d2`](https://testnet.bscscan.com/address/0x1df5aba120b14d2dd3878b876d9676c5a503b3d2#code) |
| Vault factory | [`0x80b66347374C6df4f157368497201aa63a371f60`](https://testnet.bscscan.com/address/0x80b66347374C6df4f157368497201aa63a371f60#code) |
| Mock USDT | [`0x0081297D056308340E5501B5F2f076344A46aB44`](https://testnet.bscscan.com/address/0x0081297D056308340E5501B5F2f076344A46aB44#code) |
| Mock USDC | [`0xAdbbBc9a09F258E6d0184D0d5EDb0688db15f421`](https://testnet.bscscan.com/address/0xAdbbBc9a09F258E6d0184D0d5EDb0688db15f421#code) |
| Atlas USDT relay | [`0x1340584cB70f8C660dCe87E3a503ED9F0866B73C`](https://testnet.bscscan.com/address/0x1340584cB70f8C660dCe87E3a503ED9F0866B73C#code) |
| Atlas USDC relay | [`0xCEfEAD2402C3F612187000258AFf686899370D82`](https://testnet.bscscan.com/address/0xCEfEAD2402C3F612187000258AFf686899370D82#code) |
| Mock T-bill | [`0xC821eC5277Ff38601B44e59c6e756C23ddCB021d`](https://testnet.bscscan.com/address/0xC821eC5277Ff38601B44e59c6e756C23ddCB021d#code) |
| Mock DEX | [`0x5BE028F7Ec3EB4Fc4CF8277e0501673F9c4E75E1`](https://testnet.bscscan.com/address/0x5BE028F7Ec3EB4Fc4CF8277e0501673F9c4E75E1#code) |

Run `make verify-sources` to compare the published Solidity and compiler settings
with this checkout. The check uses `ETHERSCAN_API_KEY` and `BSC_TESTNET_RPC_URL`.
It reads the creation transactions for addresses marked **Similar Match** to check
their original creation bytecode and constructor arguments. The per-address results
are in [97-verification.json](deployments/97-verification.json).

## Oracle and demo limitations

Both relays preserve the timestamps of real Atlas mainnet observations. The free
[USDT](https://atlasoracle.io/feeds/649) and [USDC](https://atlasoracle.io/feeds/650)
push feeds advertise a 24-hour heartbeat, so this deployment uses a 25-hour
`maxPriceAge`. These prices are not instantaneous depeg signals. The latest
mirrored observations are recorded in [97-atlas.json](deployments/97-atlas.json).
From the repository root, `make start` runs the reporter in your current
terminal and displays each check. Press Ctrl-C to stop, or use `make stop`
from another terminal. It checks both feeds every 60 seconds while the Mac is awake and
online, and writes an update only for a newer valid observation. There is no
scheduled shutdown. `make status` shows the process state and last completed check.
`make logs` shows recent activity. `make stop` lets the current operation finish.
During sleep polling pauses; after wake the process resumes. After a reboot use
`make start` again. Starting twice keeps a single process. The deployer and agent
signing keys are not required by the reporter.

Use `make test` for local checks and `make verify` to replay the recorded
payment, swap and T-bill transactions on BSC testnet. For a fresh checkout, run `make setup` and
provide Foundry as described above.

If observations expire or fall below the owner's floor, payments fail closed.

The mock DEX starts with 100,000 units of each faucet token. The demo vault was
funded with 1,000 mock USDT; its owner, agent and reporter are separate test
wallets. Mock tokens, simulated T-bill returns and the permissive faucet are for
the hackathon testnet only. MegaFuel's private policy has its own funding, limits
and expiration; sponsorship eligibility is checked again before each new send.
The policy ends on **27 November 2026 at 09:00 Bangkok time**.
[Check, extend or top up MegaFuel for a jury demo](../docs/megafuel-jury.md).

## Swap proof

One sponsored testnet transaction swapped 1 mUSDT for 1 mUSDC at the demo DEX.
The vault's minimum was 0.978863781006942765 mUSDC. At the same block, a read-only
simulation set a quote of 0.90 mUSDC and the vault returned `SlippageTooHigh`
with the expected minimum and actual amounts. The simulated rate was discarded.
[Receipt](https://testnet.bscscan.com/tx/0x3a0dd0b84af9105c542db87e6838dd4b5909c444eaca205d6eda217ac6d4f8c8) ·
[Machine-readable proof](deployments/97-atlas-swap.json)

Replay the proof from the repository root with
`.setup/testnet-venv/bin/python scripts/check_atlas_swap.py`. It checks the receipt,
the vault's balance changes, both oracle prices, and the simulated refusal at the
recorded block. The replay uses `BSC_TESTNET_RPC_URL` and optionally `NODEREAL_API_KEY`
for historical state and requires no signing key. The RPC used for historical
reads must support `eth_simulateV1` and retain state at that block.

## T-bill deposit, withdrawal and payment

The demo agent placed 5 mUSDT from the vault into the mock ERC4626 T-bill, withdrew
5 mUSDT back into the vault, then paid the allowlisted demo recipient. MegaFuel
sponsored all three transactions on chain 97. The agent paid zero tBNB in gas.

| Confirmed step | Liquid mUSDT in vault | T-bill shares in vault | Recipient mUSDT |
|---|---:|---:|---:|
| Before deposit | 998 | 0 | 1 |
| [Deposit](https://testnet.bscscan.com/tx/0x36169f72200d39ad3e687e5fa0693e4dd79ee03bb9255bdf9a39cfc770b670de) | 993 | 5 | 1 |
| [Withdraw](https://testnet.bscscan.com/tx/0xd5d6051a5bdb65a76b16f303b8bcc2d761624ffef7b6b58fe3f6a2cdf511c6f4) | 998 | 0 | 1 |
| [Pay](https://testnet.bscscan.com/tx/0xbdd84fa076be1e36c900f1bea7c9a5cc99c420c773923fef80fe8c4165d2c63e) | 993 | 0 | 6 |

Run `make verify-tbill` to check the transaction inputs, vault events, gas price and
balances immediately before and after each block against the [recorded proof](deployments/97-tbill.json).
The command only reads chain history and needs an archive RPC. It works after
sponsorship expires and while the Atlas relay is stopped. A Foundry test also
invests the vault's entire mUSDT balance and confirms that the same payment fails
before withdrawal and succeeds afterward.

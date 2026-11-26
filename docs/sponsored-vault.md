# Pay from a wallet with zero tBNB

On BSC testnet, the owner signs an approval to activate the vault, a second approval to authorize a beneficiary and their monthly cap, and a third approval to pay them. The agent submits each transaction and pays the network in tBNB. Activation and adding a beneficiary are free to the owner. The vault needs spendable stablecoins for a payout.

For a **20 USDT** payment, the review card and wallet approval both show **0.01 USDT in fees** and a **20.01 USDT total debit**. The beneficiary receives 20. A single confirmed transaction transfers the fee to the project's testnet treasury. A refused or reverted payout charges zero USDT. For a batch of three successful payouts the total fee is 0.03 USDT. For a 20 USDC payout the debit is 20 USDC plus 0.01 USDT, so the vault needs both coins. Each spending limit includes the fee.

## Try the complete flow locally

Install the agent's dependencies with `npm ci --prefix agent`. The check uses Node 22 or later, Foundry's `forge` and `anvil`, and initialized contract submodules. Run from the repository root.

```sh
make test-sponsored-flow
```

This starts a fresh local chain and stops it on exit. A newly generated owner signs actual wallet messages. The check activates the vault, registers a beneficiary, mints 20.01 mock USDT directly into the vault, and submits the payment through the agent. It checks both token transfers, all three gas payers and the owner's zero native balance and transaction count. It repeats both setup requests and the signed payout to check that each executes once. The payment text is fixed so the test can run without an AI API key.

## Check the public testnet run

The signing wallet used in this run had **0 tBNB and zero outgoing transactions** at activation, beneficiary addition and payment. The agent paid the three network charges below. The funding transaction used the test token's faucet.

| Action | Result | Gas paid by the agent |
| --- | --- | --- |
| [Activate the vault](https://testnet.bscscan.com/tx/0xa53d7dc935e61d88a45f17ad419d4a721cc33c6293db7a0aa65cd7a7a921c4d9) | The new wallet owns the vault | 0.0003129667 tBNB |
| [Add the beneficiary](https://testnet.bscscan.com/tx/0xbc456abc9b3f10bc6be9d21c6769d73c076221d26d124069c71b6aca3b77689f) | The owner approved a 1,000 monthly cap | 0.0000100101 tBNB |
| [Pay the beneficiary](https://testnet.bscscan.com/tx/0x44e14f8ecf7c5d72bac78909197e8fc4a1af9fa0f92cfb49e2b1df0ad3b16f09) | 20 mUSDT to the beneficiary and 0.01 mUSDT to the treasury | 0.0000247974 tBNB |

Run `make verify-sponsored-flow` to read the published receipts and check the owner's balance at each block. It only reads chain data. For historical balances it uses NodeReal when `NODEREAL_API_KEY` is set, or the configured BSC testnet RPC when that endpoint serves archive data. The [deployment record](../contracts/deployments/97-sponsored.json) includes the wallet addresses, the [factory deployment](https://testnet.bscscan.com/tx/0x70d15d64ea7b09d0802bb4243bf8e2298b697229abfd71d412b0ba5b54f74c0e) and the [test funding receipt](https://testnet.bscscan.com/tx/0xb86e469dda68ba169cec470129a25e6a9df12c92adbf9293713e24e948abee6a).

## Connect a preview

The sponsored factory on chain 97 is `0xec8339Aa64277e759475c6777D7832652a390b99`. Each factory looks up its own vaults. A user of the original app keeps ownership and access through the original deployment. Switching factories opens a separate vault and balance.

| Environment | Setting | Value |
| --- | --- | --- |
| Agent | `FACTORY_ADDRESS` and `SPONSORED_FACTORY_ADDRESS` | Sponsored factory address above |
| Web preview | `NEXT_PUBLIC_FACTORY_ADDRESS` and `NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS` | Same address, set before building the web preview |
| Web preview | `AGENT_URL` and `AGENT_API_TOKEN` | The HTTPS endpoint and matching server-side token for that agent |

The test network uses mock USDT and USDC with 18 decimals. The factory's configured agent needs a funded testnet signing key and one running signer process for that key. Use persistent storage for its `DATA_DIR` so the sponsor budget and payment journal survive restarts. This test factory uses the project's existing test agent. A concurrent preview with its own independently running agent needs a factory configured for that preview's own funded key. [Agent settings](../agent/README.md)

Sponsorship covers activation and first-time beneficiary authorization. Changing a cap, removing a beneficiary or pausing the vault still uses an owner-submitted transaction. The fixed USDT fee applies to payments through sponsored vaults.

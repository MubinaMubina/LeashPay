# Pay from a wallet with zero tBNB

On BSC testnet, the owner signs an approval to activate the vault, a second approval to authorize a beneficiary and their monthly cap, and a third approval to pay them. The agent submits each transaction and pays the network in tBNB. Activation and adding a beneficiary are free to the owner. The vault needs spendable stablecoins for a payout.

For a **20 USDT** payment, the review card and wallet approval both show **0.01 USDT in fees** and a **20.01 USDT total debit**. The beneficiary receives 20. A single confirmed transaction transfers the fee to the project's testnet treasury. A refused or reverted payout charges zero USDT. For a batch of three successful payouts the total fee is 0.03 USDT. For a 20 USDC payout the debit is 20 USDC plus 0.01 USDT, so the vault needs both coins. Each spending limit includes the fee.

## What happens when an owner signs back in?

LeashPay uses the wallet from the owner's Privy session to look up their vault. On the published sponsored deployment it checks the sponsored factory (V2) first. If that factory confirms the wallet has no vault, it checks the original factory (V1). If a lookup fails, the app offers a retry before activation.

| What the wallet owns | What opens | Example: pay 20 USDT |
| --- | --- | --- |
| An original V1 vault only | The same vault, with its balance, authorized recipients and limits | The recipient gets 20. The vault spends 20. The treasury receives zero. |
| A sponsored V2 vault | The sponsored vault | The recipient gets 20. The vault spends 20.01. The treasury gets 0.01. |
| No vault yet | The workspace offers sponsored activation | The owner can activate and add a beneficiary with zero tBNB, then fund the vault with stablecoins. |

**An existing owner can pay immediately with their usual approval.** A still-valid V1 approval can finish on the same V1 vault after the rollout. If the owner already has a separate V2 vault, new plans use V2 and the owner reviews a fresh approval for it. Funds stay at their original vault addresses.

**On V2 the owner signs one payment approval.** It covers the recipient amount, the fee and the maximum vault debit. The agent verifies the exact signed terms. The vault sends the payout and the treasury fee in the same transaction. The treasury needs no token allowance or place in the recipient directory. For a receipt of everything Casey receives, use the recipient amount. For the total spent by the vault, include the fee.

## Try both accounts locally

Install the agent's dependencies with `npm ci --prefix agent`. The check uses Node 22 or later, Foundry's `forge` and `anvil`, and initialized contract submodules. Run from the repository root.

```sh
make test-sponsored-flow
make test-existing-account
```

Each command starts a temporary chain and stops it on exit. The first activates a V2 vault with gas paid by the agent, registers a beneficiary, and funds the vault with 20.01 mock USDT. It tries a signature that omits the fee, then submits the correct approval and verifies both transfers and the owner's zero native balance. The second creates an original account, signs a V1 payment, and restarts the agent with the V2 configuration. It verifies the same vault and contact, a fee-free new quote and a single 20 mUSDT transfer on the original approval. Both checks use test wallets and fixed payment text.

## Check the public testnet run

The signing wallet used in this run had **0 tBNB and zero outgoing transactions** at activation, beneficiary addition and payment. The agent paid the three network charges below. The funding transaction used the test token's faucet.

| Action | Result | Gas paid by the agent |
| --- | --- | --- |
| [Activate the vault](https://testnet.bscscan.com/tx/0xa53d7dc935e61d88a45f17ad419d4a721cc33c6293db7a0aa65cd7a7a921c4d9) | The new wallet owns the vault | 0.0003129667 tBNB |
| [Add the beneficiary](https://testnet.bscscan.com/tx/0xbc456abc9b3f10bc6be9d21c6769d73c076221d26d124069c71b6aca3b77689f) | The owner approved a 1,000 monthly cap | 0.0000100101 tBNB |
| [Pay the beneficiary](https://testnet.bscscan.com/tx/0x44e14f8ecf7c5d72bac78909197e8fc4a1af9fa0f92cfb49e2b1df0ad3b16f09) | 20 mUSDT to the beneficiary and 0.01 mUSDT to the treasury | 0.0000247974 tBNB |

Run `make verify-sponsored-flow` to read the published receipts and check the owner's balance at each block. It only reads chain data. For historical balances it uses NodeReal when `NODEREAL_API_KEY` is set, or the configured BSC testnet RPC when that endpoint serves archive data. The [deployment record](../contracts/deployments/97-sponsored.json) includes the wallet addresses, the [factory deployment](https://testnet.bscscan.com/tx/0x70d15d64ea7b09d0802bb4243bf8e2298b697229abfd71d412b0ba5b54f74c0e) and the [test funding receipt](https://testnet.bscscan.com/tx/0xb86e469dda68ba169cec470129a25e6a9df12c92adbf9293713e24e948abee6a).

## Connect the hosted web app and agent

The published sponsored factory on BSC testnet (chain 97) is `0xec8339Aa64277e759475c6777D7832652a390b99`. Its built-in fallback is the original factory at `0x80b66347374C6df4f157368497201aa63a371f60`. Use the same Privy app so returning accounts resolve to the same wallets.

| Environment | Setting | Value |
| --- | --- | --- |
| Railway agent | `FACTORY_ADDRESS` and `SPONSORED_FACTORY_ADDRESS` | Sponsored factory address above |
| Vercel web app | `NEXT_PUBLIC_FACTORY_ADDRESS` and `NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS` | Same address, set for the target environment before rebuilding the web app |
| Vercel web server | `AGENT_URL` and `AGENT_API_TOKEN` | The HTTPS endpoint and matching server-side token for that agent |

The test network uses mock USDT and USDC with 18 decimals. The factory's configured agent needs a funded testnet signing key and one running signer process for that key. Use persistent storage for its `DATA_DIR` so the sponsor budget and payment journal survive restarts. This test factory uses the project's existing test agent. A concurrent preview with its own independently running agent needs a factory configured for that preview's own funded key. [Agent settings](../agent/README.md)

Sponsorship covers activation and first-time beneficiary authorization. Changing a cap, removing a beneficiary or pausing the vault still uses an owner-submitted transaction. The fixed USDT fee applies to payments through sponsored vaults.

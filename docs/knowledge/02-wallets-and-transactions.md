# Follow one payment from the keyboard to Marco

Open [Marco’s payment on BscScan Testnet](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d). BscScan is a **block explorer**. It turns the network’s public records into a page you can read. You can follow this entire guide without connecting a wallet.

## Before looking at the receipt

- An **address** identifies an account or a program on a particular network. Marco gives the agency his public address so it can pay him.
- A **wallet** is the tool someone uses to manage an account and approve actions. Marco can close his wallet app and the token contract will still record his balance.
- A **private key** lets its holder sign for an account. A **signature** lets others check who approved a particular message or transaction while the key stays secret. Sharing an address lets someone pay you. Sharing your private key lets them act as you.
- A **smart contract** is a program deployed at an address. Our **vault** is one such program. It holds the agency’s test tokens and checks payment rules.

In this rehearsal, the **agent** signed a transaction asking the **vault** to pay Marco. BSC executed the vault’s code, which instructed the **mUSDT token contract** to move one unit. When the transaction was included in a block, it had a **receipt**, the record of how execution ended. Its **transaction hash** is the lookup ID in the BscScan link. [How transactions work](https://ethereum.org/developers/docs/transactions/)

## Marco’s receipt, annotated

**BSC testnet · 26 November 2026, 03:24:55 Bangkok time**

These are the fields from the confirmed transaction, shortened for reading. Match them to the explorer’s overview and token transfers.

| Find this on the receipt | What this payment says | How to read it |
|---|---|---|
| **① Status and block** | Success · [144,851,480](https://testnet.bscscan.com/block/144851480) | The network included the transaction and the vault call completed. Next, check what moved. |
| **② From** | Agent · `0xbb7418…1797a0` | The agent’s key signed the instruction. |
| **③ To / Interacted With** | Vault · `0x1df5ab…03b3d2` | The instruction went to a program. This field answers “who was called?” |
| **④ Token transfer** | Vault → **Marco** · `0xEBe6E6…A4b13B` · **1 mUSDT** | This row answers “who got the money?” The mUSDT contract recorded the vault as sender and Marco as recipient. |
| **⑤ Value** | **0 tBNB** | Native coins attached to the call. Token movements have their own row, above. |
| **⑥ Gas** | **118,493 gas used** · **0 effective gas price** | Gas measures computation. MegaFuel sponsored this transaction. The agent paid **0 tBNB** in network fees. |

### How do we know Marco received it?

The receipt contains two **events**, messages emitted by contracts during execution. The vault’s `Paid` event identifies the intended recipient, token, amount and payment reference. The token’s `Transfer` event records the move from the vault to Marco. Both refer to the same payment. [Receipt event logs](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d#eventlog)

We also read Marco’s balance from the token contract at two points in the chain’s history. These historical balances are a separate check alongside the receipt.

| End of block | Marco’s balance |
|---|---:|
| 144,851,479 · immediately before | 2 mUSDT |
| 144,851,480 · payment included | 3 mUSDT |

**Quick check:** A judge sees “Value 0” and asks where the payment went. Point to **④** for the token amount and recipient, then to **⑤** for the amount of native coin. A later payment might change Marco’s current balance. These two blocks always identify the moment you are explaining.

**Remember seeing 0 → 1 in the terminal?** That was Marco’s first payment, when the team ran `make pay-demo` for all three freelancers. You can read that receipt the same way. Look for the transfer of **1 mUSDT** from the vault to Marco’s address ending in **4b13B**. The **2 → 3** example above comes from a later rehearsal. [Marco’s first payroll receipt](https://testnet.bscscan.com/tx/0x96679c473e4d8c7664dd41b7777b55d7ab302e9b7a2003dff7117cea567e4d59)

**Next:** [See who can request, approve and stop a payment](03-how-leashpay-works.md).

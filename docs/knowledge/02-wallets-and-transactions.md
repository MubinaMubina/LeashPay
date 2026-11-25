# Follow one payment from the keyboard to Marco

BscScan is a **block explorer**, a website where anyone can look up what happened on the network. Each transaction has its own public ID, a string of letters and numbers called a **transaction hash**. You can use it to open the payment without a wallet or a login.

## Before looking at the receipt

- An **address** identifies an account or a program on a particular network. Marco gives the agency his public address so it can pay him.
- A **wallet** is the tool someone uses to manage an account and approve actions. Marco can close his wallet app and the token contract will still record his balance.
- A **private key** lets its holder sign for an account. A **signature** lets others check who approved a particular message or transaction while the key stays secret. Sharing an address lets someone pay you. Sharing your private key lets them act as you.
- A **smart contract** is a program deployed at an address. Our **vault** is one such program. It holds the agency’s test tokens and checks payment rules.

The **agent**, the software that submits payments, signed an instruction asking the vault to pay Marco. The vault checked its rules and told the token program to move 1 mUSDT from the vault to Marco. The network recorded the outcome in a **receipt**. BscScan shows the original instruction and that receipt on the same page. [How transactions work](https://ethereum.org/developers/docs/transactions/)

## Marco’s receipt, annotated

**BSC testnet · 26 November 2026, 03:24:55 Bangkok time** · [Open this transaction on BscScan](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d)

**Start with the token transfer.** Look for the recipient address ending in **4b13B** and the amount **1**. That is Marco’s payment. Then look at the transaction’s **From** and **To** fields to find who sent the instruction and which program received it. BscScan may show addresses in place of names. The team’s public roster identifies Marco’s full address. [Demo recipient roster](../../contracts/deployments/97-demo-recipients.json)

| Find this on the receipt | What this payment says | How to read it |
|---|---|---|
| **① Token transfer** | Vault → **Marco** · `0xEBe6E6…A4b13B` · **1 mUSDT** | The vault’s balance funded the payment. The token program credited Marco’s address. |
| **② From** | Agent · `0xbb7418…1797a0` | The agent’s key signed the instruction. |
| **③ To / Interacted With** | Vault · `0x1df5ab…03b3d2` | The instruction went to a program. This field answers “who was called?” |
| **④ Status and block** | Success · [144,851,480](https://testnet.bscscan.com/block/144851480) | The vault completed the request. The block number tells you where it appears in the network’s history. |
| **⑤ Value** | **0 tBNB** | This counts the network’s own coin sent along with the instruction. The **1 mUSDT** transfer is recorded separately in ①. |
| **⑥ Gas and transaction fee** | **118,493 units of gas** at **0 tBNB per unit** | Gas measures the work the network did. Multiply units used by price per unit. The agent’s fee was **0 tBNB**. The team submitted this payment through its MegaFuel sponsorship. |

### How do we know Marco received it?

An **event** is an entry a program writes to the receipt. Row ① comes from the token’s `Transfer` event. It names the vault as sender and Marco as recipient. A second event, `Paid`, comes from the vault and ties this transfer to its payroll reference. [Receipt event logs](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d#eventlog)

For a second check, we asked the token program for Marco’s balance at the end of two consecutive blocks. A wallet opened today shows the latest balance. These readings let us go back to the moment of payment.

| End of block | Marco’s balance |
|---|---:|
| 144,851,479 · immediately before | 2 mUSDT |
| 144,851,480 · payment included | 3 mUSDT |

The difference is **3 − 2 = 1 mUSDT**, exactly the amount in the transfer. If someone asks why the page also shows two zeros, point to **⑤** for the tBNB sent and **⑥** for the fee the agent paid.

**Remember seeing 0 → 1 in the terminal?** That was Marco’s first payment, when the team ran `make pay-demo` for all three freelancers. You can read that receipt the same way. Look for the transfer of **1 mUSDT** from the vault to Marco’s address ending in **4b13B**. The **2 → 3** example above comes from a later rehearsal. [Marco’s first payroll receipt](https://testnet.bscscan.com/tx/0x96679c473e4d8c7664dd41b7777b55d7ab302e9b7a2003dff7117cea567e4d59)

**Next:** [See who can request, approve and stop a payment](03-how-leashpay-works.md).

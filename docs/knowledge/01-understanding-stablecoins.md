# What did Marco actually receive?

Marco had **2 mUSDT**. LeashPay paid him **1 mUSDT**, and his balance reached **3 mUSDT**. Three questions help explain what happened. What is the unit? Who keeps count? What could that amount be worth?

## Who keeps count?

Imagine a record with an address in one column and a balance in another. A **token** is a unit tracked by a program that keeps such a record. When the program accepts a transfer, it subtracts units from one address and adds them to another.

In LeashPay, that program runs on **BNB Smart Chain (BSC)**. Many computers maintain a shared history of what the programs on that network did. New groups of transactions, called **blocks**, are added in order. That shared history is the **blockchain**. It lets you look up Marco’s balance at the end of one block and compare it with his balance at the end of the next.

## Why use a stablecoin for payroll?

Suppose Marco invoices an agency for **100 US dollars**. He wants to know roughly what he will receive while the agency prepares the payment. **USDT** and **USDC** are two different tokens, each designed to trade close to one US dollar. That target is called a **peg**. Their issuers maintain reserves to support redemption. The price buyers and sellers actually agree on can still move. [Stablecoins explained](https://ethereum.org/stablecoins/)

| If one token trades at… | Marco holds… | Estimated dollar value |
|---|---:|---:|
| $1.00 | 100 tokens | $100 |
| $0.97 | 100 tokens | $97 |

The balance stayed at 100 in both rows. The **price** changed. When a token moves away from its target, people call it a **depeg**. This is why the LeashPay vault can check a price before releasing a payment.

## The four units you will see in our demo

| Unit | How to read it |
|---|---|
| **USD** | The US dollar. It is the reference currency when we talk about a dollar peg. |
| **USDT / USDC** | Two dollar-targeting stablecoins with separate issuers and token contracts. The market data services in our demo observe these assets. |
| **mUSDT / mUSDC** | Our **mock** tokens on BSC **testnet**, a separate practice network. The team can create test units to rehearse payments. They carry no claim on the issuers’ dollar reserves. |
| **tBNB** | The test network’s native coin. It is used for network fees. Marco’s payment amount is measured in mUSDT. |

**What about pesos?** PHP means Philippine pesos. If the displayed market quote were 60 PHP per USDT, a payment of 1 mUSDT would display an estimated equivalent of 60 PHP in our demo. The token transfer credits Marco with 1 mUSDT. Receiving pesos in a bank account would require a separate conversion and payout.

**Try saying it aloud:** “We made a real transaction on a practice network. Marco received one test token, and we can independently check his balance.”

**Next:** [Follow the payment and read Marco’s receipt](02-wallets-and-transactions.md).

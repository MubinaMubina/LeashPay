# What did Marco actually receive?

Marco is a freelancer in our payroll demo. He had **2 mUSDT**, the agency paid him **1 mUSDT**, and his balance reached **3 mUSDT**. The **m** stands for *mock*. We use this practice version of USDT to learn how payments work before handling money.

## Who keeps count?

Imagine a record with an account number in one column and a balance in another. Here the account number is called an **address**, and each unit in the balance is a **token**. When the program that keeps the record accepted Marco’s payment, it subtracted one token from the agency’s vault and added one to Marco’s address. The **vault** is the program that holds the agency’s funds and checks its spending rules.

In LeashPay, that program runs on **BNB Smart Chain (BSC)**. Many computers maintain a shared history of what the programs on that network did. New groups of transactions, called **blocks**, are added in order. That shared history is the **blockchain**. It lets you look up Marco’s balance at the end of one block and compare it with his balance at the end of the next.

## Why use a stablecoin for payroll?

Suppose Marco invoices an agency for **100 US dollars**. A **stablecoin** is a token designed to track the value of something else. **USDT** and **USDC** each aim to trade for one US dollar. That target is called a **peg**. It lets the agency quote Marco’s pay in familiar units, although the price people actually pay for a token can still change. [Stablecoins explained](https://ethereum.org/stablecoins/)

| If one token trades at… | Marco holds… | Estimated dollar value |
|---|---:|---:|
| $1.00 | 100 tokens | $100 |
| $0.97 | 100 tokens | $97 |

The balance stayed at 100 in both rows. The **price** changed. When a token moves away from its target, people call it a **depeg**. This is why the LeashPay vault can check a price before releasing a payment.

## What the abbreviations mean

| Unit | How to read it |
|---|---|
| **USD** | The US dollar. It is the reference currency when we talk about a dollar peg. |
| **USDT / USDC** | Two dollar-targeting stablecoins with separate issuers and token contracts. The market data services in our demo observe these assets. |
| **mUSDT / mUSDC** | Our **mock** tokens on BSC **testnet**, a separate practice network. The team can create test units to rehearse payments. They carry no claim on the issuers’ dollar reserves. |
| **tBNB** | The practice coin that BSC testnet uses to charge for processing transactions. The fee and Marco’s payment use different units. |

**What about pesos?** PHP means Philippine pesos. Imagine the price of one USDT is 60 PHP. The screen can use that quote to show *about 60 PHP* next to a one-token demo payment. Marco’s wallet receives **1 mUSDT**. To receive pesos in a bank account, he would need a separate service that converts real funds and pays them out.

**Try saying it aloud:** “We made a real transaction on a practice network. Marco received one test token, and we can independently check his balance.”

**Next:** [Follow the payment and read Marco’s receipt](02-wallets-and-transactions.md).

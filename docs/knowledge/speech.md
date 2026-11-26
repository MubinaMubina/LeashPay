# The 90-second pitch

**If you lose your place:** Bangkok agency → one sentence → owner’s rules → Marco’s receipt → what the owner can trust.

## Say this

**B · The problem**

Imagine you run an agency in Bangkok. On payday you owe three freelancers money in two countries. An AI could turn your instructions into a list of payments in seconds. But would you give it a wallet that could send the whole payroll to an address someone just pasted into chat?

**A · The idea**

With LeashPay, the agency puts its funds in a vault on BNB Smart Chain. Think of it as an account with spending rules built in. The owner chooses who can get paid and how much. The agent prepares a plan. The owner reads it and signs it. The agent can then ask the vault to pay. We simulated what would happen if it asked to pay a stranger. The vault refused.

**B · The proof**

Here’s Marco’s receipt from a separate rehearsal on the practice network. Find the line that says one token went from the vault to Marco. His balance was two before that payment and three afterward. The fee the agent paid was zero because this transfer was sponsored.

**A · The close**

The agency can hand payroll to an assistant and still decide where the money goes. And Marco can check for himself that he got paid.

## When a judge asks

| Question | Short answer |
|---|---|
| **Was it real money?** | “It was a confirmed transaction on BSC testnet using mock USDT. We can prove delivery. We used practice assets for the hackathon.” |
| **Who can withdraw?** | “The owner can withdraw, including while the vault is paused. The agent can request permitted payments, swaps and transfers into or out of the mock T-bill.” |
| **What if I run the same payment twice?** | “The vault remembers the payment reference for each recipient. A second attempt with the same reference is refused.” |
| **Did Marco get pesos?** | “He received mUSDT. We use a market quote to show the estimated value in pesos. A bank payout would be a separate step.” |
| **Who approved Marco’s payment?** | “In the app, the owner signs the plan and the agent sends the payment request. For the sponsored terminal rehearsal, we sent the request directly as the demo agent. The vault checked its rules in both cases.” |
| **What can we verify today?** | “Here are the owner-approved payment, the sponsored payment, and the mock T-bill receipts. And Living Brain: it saves each payout and attack, then connects them to the next plan.” |

**Proof to keep open:** [Owner-approved payment](https://testnet.bscscan.com/tx/0xe58a8c675e542437271c962b7f5adf029d7198e01ea541f1876fcec7a8818ddc) · [Marco’s annotated sponsored receipt](02-wallets-and-transactions.md#marcos-receipt-annotated) · [T-bill receipts](../../contracts/README.md#t-bill-deposit-withdrawal-and-payment) · [Live demo cues](demo.md)

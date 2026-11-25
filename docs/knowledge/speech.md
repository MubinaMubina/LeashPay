# The 90-second pitch

**If you lose your place:** Bangkok agency → one sentence → owner’s rules → Marco’s receipt → what the owner can trust.

## Say this

**B · The problem**

Imagine you run an agency in Bangkok. On payday you owe three freelancers money in two countries. An AI could turn your instructions into a list of payments in seconds. But would you give it a wallet that could send the whole payroll to an address someone just pasted into chat?

**A · The idea**

With LeashPay, the agency puts its funds in a vault on BNB Smart Chain. Think of it as an account with spending rules built in. The owner chooses who can get paid and how much. The agent prepares a plan for the owner to review. Even after approval, the vault checks each payment against those rules. We tested a request for an unknown address. The vault refused it.

**B · The proof**

Here’s Marco. In our sponsored testnet demo, his balance went from two tokens to three. You can open the public receipt and see one token move from the vault to his address. The agent paid zero in network fees for this transfer because our sponsor covered it.

**A · The close**

That’s what we want an agency to be able to delegate: preparing and sending payroll, while the owner keeps control of where the money can go.

## When a judge asks

| Question | Short answer |
|---|---|
| **Was it real money?** | “It was a confirmed transaction on BSC testnet using mock USDT. We can prove delivery. We used practice assets for the hackathon.” |
| **Who can withdraw?** | “The owner can withdraw, including while the vault is paused. The agent can request permitted payments, swaps and transfers into or out of the mock T-bill.” |
| **What if I run the same payment twice?** | “The vault remembers the payment reference for each recipient. A second attempt with the same reference is refused.” |
| **Did Marco get pesos?** | “He received mUSDT. We use a market quote to show the estimated value in pesos. A bank payout would be a separate step.” |
| **Did the AI approve its own payment?** | “In the app flow the owner signs the plan, then the agent signs the transaction. We also have a terminal harness with a demo signer to test sponsorship.” |
| **What can we verify today?** | “Here are the owner-approved payment, the sponsored payment, and the mock T-bill receipts. Living Brain’s write-and-recall test is waiting for project credits.” |

**Proof to keep open:** [Owner-approved payment](https://testnet.bscscan.com/tx/0xe58a8c675e542437271c962b7f5adf029d7198e01ea541f1876fcec7a8818ddc) · [Marco’s annotated sponsored receipt](02-wallets-and-transactions.md#marcos-receipt-annotated) · [T-bill receipts](../../contracts/README.md#t-bill-deposit-withdrawal-and-payment) · [Live demo cues](demo.md)

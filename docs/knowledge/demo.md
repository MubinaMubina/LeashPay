# Live demo cue card

**B drives the screen. A explains the contract.** Keep [Marco’s annotated receipt](02-wallets-and-transactions.md#marcos-receipt-annotated) and the [public BscScan receipt](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d) open side by side. Either one gives you a place to resume if you lose your train of thought.

| Moment | B shows | A says | What the audience can check |
|---|---|---|---|
| **1 · Ask** | In the rehearsed app, enter “Pay Marco 1 USDT now.” Show the recipient, token and amount before the owner signs. The terminal alternative is below. | “Claude turns the request into a plan. The owner can see exactly which address will receive one token.” | Marco’s address ends in **4b13B**. The amount is **1 mUSDT** on BSC testnet. |
| **2 · Pay** | In the app, approve the reviewed plan and open its resulting receipt. For the recorded terminal example, open the receipt linked above. | “The agent signed a call to the vault. Here’s the token transfer from the vault to Marco.” | In the recorded example, **2 → 3 mUSDT** and **0 tBNB** in agent fees. A new run has its own hash and balances. |
| **3 · Refuse** | Show the unapproved-recipient result in the [recorded contract checks](../../contracts/deployments/97-checks.json). Point to `RecipientNotAllowed`. If rehearsed in the UI, show the owner’s pause control. | “We asked the deployed vault what it would do with an address outside the owner’s list. It refused before any tokens could move. The owner can also pause future payments.” | This refusal was a simulation. The success in step 2 has an on-chain receipt. |
| **4 · Explain the coin choice** | Show the question, probability, source and threshold from a rehearsed Cournot result. Use `make test-cournot` for a fresh query if quota is available. | “This number estimates a future depeg. Our demo compares it with a threshold to choose a coin. At payment time, the vault also checks the current price from Atlas.” | Label the result **live** or **recorded**. The routing check by itself sends no payment. |

## Before going on stage

- **Pick one payment path.** If the UI is ready, rehearse the owner signature there. For the terminal path, run `make test-demo RUN=stage-01` from the repository root. A fresh run ID sends **one actual test token to Marco** via MegaFuel. Reusing that ID on the same Mac checks the same payment. This terminal path uses the demo signer directly.
- **Start the price relay.** On the configured demo Mac, run `make start` in one terminal and leave it open. In a second terminal, run `make test-atlas` to check both prices. Press Ctrl-C in the first terminal when the demo ends.
- **Check sponsorship.** Run `make megafuel-status` before sending. The scheduled cutoff is **27 November 2026 at 09:00 Bangkok time**. For a later presentation, check the displayed expiry and remaining credit. If a provider is unavailable, show the recorded receipt and say when it happened. [Extend sponsorship or top up](../megafuel-jury.md)
- **Keep the receipts straight.** For a question about the *owner’s signature*, show the [agent-server payment](https://testnet.bscscan.com/tx/0xe58a8c675e542437271c962b7f5adf029d7198e01ea541f1876fcec7a8818ddc) alongside the app’s approval step. For a question about *gas sponsorship*, use the annotated terminal receipt.
- **If asked about memory**, the open item is [Living Brain credits](../../ReadMe.md#live-terminal-checks). Demonstrate recall once `make test-brain` has successfully written and retrieved a fresh preference.

**Closing line:** “You can see what the agent asked for, what the vault allowed, and what Marco actually received.”

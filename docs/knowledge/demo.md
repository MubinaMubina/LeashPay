# Live demo cue card

**B drives the screen. A explains the payment.** Keep two tabs open for the recorded example. [Annotated receipt](02-wallets-and-transactions.md#marcos-receipt-annotated) · [Same payment on BscScan](https://testnet.bscscan.com/tx/0x9842fec16b5c798a4c22cb2411573c1c530bd8c8e0905123ba0ae24cbcd75b3d)

## Before going on stage

- **Start the price relay.** On the configured demo Mac, run `make start` in one terminal and leave it open. In a second terminal, run `make test-atlas` to check both prices. Press Ctrl-C in the first terminal when the demo ends.
- **Check sponsorship.** Run `make megafuel-status` before sending. The scheduled cutoff is **27 November 2026 at 09:00 Bangkok time**. For a later presentation, check the displayed expiry and remaining credit. If a provider is unavailable, show the recorded receipt and say when it happened. [Extend sponsorship or top up](../megafuel-jury.md)
- **Choose how to show the payment.** Use the rehearsed app to show the owner signing. For a live terminal payment, run `make test-demo RUN=stage-01` in the second terminal from the repository root. A new run ID sends **1 mUSDT to Marco** if the checks pass. Reusing the ID on the same Mac with its saved transaction history checks the existing payment. The terminal submits directly as the agent. For a recorded walkthrough, simply open the two tabs above.

## Demo wallets on BSC testnet

New accounts open with zero tBNB and an empty recipient list. Even before login, open **Your vault** and switch between **Add money** and **Withdraw** to preview the direction of a bank transfer. For a live payment, sign in with a prepared, funded test vault. Before rehearsal, open **Recipients → Add recipient** and add Marco if needed. To show the three-person payroll, add all three.

| Recipient | Public wallet address | Country | Local currency |
| --- | --- | --- | --- |
| Linh | `0x47D948f58f4a495283BF0F74257E2F73D446D7Ea` | Vietnam | VND |
| Marco | `0xEBe6E66c61DC57185F2c9a63bbc9914B85A4b13B` | Philippines | PHP |
| Mai | `0x5eEccB731a3b642BFE93f0aaBe95AC74F5126B21` | Vietnam | VND |

The owner chooses the spending cap for each contact. [Original testnet roster](../../contracts/deployments/97-demo-recipients.json)

## On stage

| Moment | B shows | A says |
|---|---|---|
| **1 · Ask** | In the app, enter “Pay Marco 1 USDT now.” Point to Marco’s address ending in **4b13B** and the amount before signing. In the terminal, point to the printed plan. | “Here’s what the agency asked for. One test token will go to this address.” |
| **2 · Pay** | In the app, sign the plan, then open the resulting receipt. On the terminal path, open the receipt it prints. Find the **token transfer** row first. | “The agent sent the instruction. The vault held the tokens. See this transfer of one mUSDT to Marco?” |
| **3 · Prove it** | Open the annotated rehearsal. Point to the historical balances, **2 → 3 mUSDT**, then the agent fee, **0 tBNB**. A live payment will have its own receipt and balances. | “In this recorded example his balance went up by one. The zero here is the fee the agent paid on that sponsored run.” |
| **4 · Show a refusal** | Open the recorded check and find `RecipientNotAllowed`. [Recorded contract checks](../../contracts/deployments/97-checks.json) | “We simulated a payment to an address the owner hadn’t approved. The vault refused it. No tokens moved.” |

**If the jury asks about coin choice**, show a saved Cournot result or run `make test-cournot` if quota is available. Label it **recorded** or **live**. Cournot estimates future risk. Atlas supplies the recent dollar price the vault checks during payment.

**If asked about the owner’s signature**, show the approval on screen and then the resulting transfer. BscScan shows the agent’s transaction. LeashPay checked the owner’s approval on the server. [Recorded agent-server payment](https://testnet.bscscan.com/tx/0xe58a8c675e542437271c962b7f5adf029d7198e01ea541f1876fcec7a8818ddc)

**If asked about memory**, the team needs credits to test saving and finding a new preference. [Living Brain follow-up](../../ReadMe.md#live-terminal-checks)

**Closing line:** “You can see what the agent asked for, what the vault allowed, and what Marco actually received.”

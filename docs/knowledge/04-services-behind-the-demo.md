# Which service answers which question?

For Marco’s payment, start with three questions. **What arrived?** The receipt shows 1 mUSDT. **What would one USDT be worth in pesos?** CoinMarketCap supplies an estimated exchange rate for the screen. **Is the dollar price high enough to pay?** The vault checks a recent Atlas price against the minimum the owner set.

| Question | Who answers it? | What you can demonstrate |
|---|---|---|
| Who signed in? | **Privy** gives LeashPay proof that a user signed in. | `make test-privy` checks that proof for the demo user. The owner still has to approve the payment plan with their wallet. |
| What did the owner ask for? | **Claude** turns a sentence into a proposed list of payments. LeashPay matches names to addresses and checks the amounts. | `make test-agent` asks for 1 mUSDT each for Linh, Marco and Mai, then checks all three entries. This command only prepares the plan. |
| What is the payment worth in pesos? | **CoinMarketCap Pro** supplies a timestamped market quote for USDT in PHP. | `make test-cmc` shows the quote and its time. Use it to explain the display beside Marco’s payment. |
| What price can the vault read? | **Atlas** publishes prices on BSC’s production network (**mainnet**). A **relay** copies each price and the time it was observed onto the practice network (**testnet**). | `make test-atlas` compares the two readings. The vault can stop a payment if the price is too old or below the owner’s minimum. |
| Which coin would the demo choose? | **Cournot** estimates the chance that USDC will trade below $0.98 for 24 hours in a row by 31 December 2026. | `make test-cournot` counts against the provider’s query allowance. With the default setting, the demo suggests USDT if the estimated chance exceeds 5%. Otherwise it suggests USDC. |
| Can the agent remember a preference? | **Living Brain** lets the agent save a note, then search for it later. | `make test-brain` saves one new preference and finds it through search. It passed on 27 November, after the project's memory credits arrived (on 26 November saving was refused with HTTP 402). |
| Who covers the network fee? | **NodeReal’s MegaFuel** sponsors eligible testnet transactions under the project’s policy. | Marco’s [sponsored receipt](02-wallets-and-transactions.md) shows gas used and zero gas price for the agent. `make megafuel-status` checks the policy’s remaining credit and expiry. |
| Where can anyone check the transfer? | **BscScan Testnet** displays public blockchain records. | Give someone the receipt link. They can independently match the vault, Marco’s address, the token and the amount. |

## Where does the T-bill fit?

A **Treasury bill** is a short-term loan to a government. Our demo uses a **mock T-bill** to answer a payroll question. If the vault sets aside five tokens between paydays, can it get them back in time to pay Linh? When the vault deposits the tokens, it gets **shares** that keep track of its claim. To **redeem** the shares, it gives them back to the practice contract and receives tokens it can spend. This rehearsal uses test tokens throughout.

| What the team did | Spendable mUSDT in the vault | T-bill shares held by the vault |
|---|---:|---:|
| Started the rehearsal | 998 | 0 |
| Deposited 5 mUSDT into the mock T-bill | 993 | 5 |
| Redeemed those 5 shares for 5 mUSDT | 998 | 0 |
| Paid 5 mUSDT to Linh | 993 | 0 |

Linh’s balance increased from 1 to 6 mUSDT. This is a different payment from Marco’s. To show the three steps, run `make verify-tbill` or open the [deposit, redemption and payment receipts](../../contracts/README.md#t-bill-deposit-withdrawal-and-payment).

**Ready to present?** Open the [live demo cue card](demo.md) and the [90-second pitch](speech.md).

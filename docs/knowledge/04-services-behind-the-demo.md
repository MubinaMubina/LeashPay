# Which service answers which question?

When Marco asks “What did I receive?”, there are three different numbers you might show him. **1 mUSDT** is the amount transferred. A **PHP quote** estimates what a USDT is worth in Philippine pesos. A **USD price** is what the vault reads when checking whether a stablecoin meets the owner’s minimum price. Each comes from a different place.

| Question | Who answers it? | What you can demonstrate |
|---|---|---|
| Who signed in? | **Privy** issues a signed session after login. The server can check which app and user it belongs to and when it expires. | `make test-privy` authenticated the LeashPay test user. A login establishes identity. Approving a payment plan is a separate wallet signature. |
| What did the owner ask for? | **Claude** turns a sentence into a proposed list of payments. LeashPay matches names to addresses and checks the amounts. | `make test-agent` asks for 1 mUSDT each for Linh, Marco and Mai, then checks all three entries. This command only prepares the plan. |
| What is the payment worth in pesos? | **CoinMarketCap Pro** supplies a timestamped market quote for USDT in PHP. | `make test-cmc` shows the quote and its time. Use it to explain the display beside Marco’s payment. |
| What price can the contract itself read? | **Atlas** publishes prices on BSC mainnet. A **relay** copies the prices and their original timestamps to testnet, where the vault can read them. | `make test-atlas` compares both observations. The vault can refuse a stale price, a price below its floor, or a swap that would return too few tokens. |
| How likely is a future USDC depeg? | **Cournot** returns a market-based probability and supporting sources. Our terminal check compares that probability with a threshold to illustrate a choice of coin. | `make test-cournot` queries a market about USDC spending 24 hours below $0.98. It consumes provider quota. Its output is a risk estimate and a routing example. |
| Can the agent remember a preference? | **Living Brain** stores a note so the agent can search for it later. | `make test-brain` attempts to write, search and read back one new preference. At the 26 November rehearsal the API accepted reads but returned HTTP 402 on the write. The team needs memory credits before claiming a successful round trip. |
| Who covers the network fee? | **NodeReal’s MegaFuel** sponsors eligible testnet transactions under the project’s policy. | Marco’s [sponsored receipt](02-wallets-and-transactions.md) shows gas used and zero gas price for the agent. `make megafuel-status` checks the policy’s remaining credit and expiry. |
| Where can anyone check the transfer? | **BscScan Testnet** displays public blockchain records. | Give someone the receipt link. They can independently match the vault, Marco’s address, the token and the amount. |

## Where does the T-bill fit?

A **Treasury bill** is a short-term loan to a government. We wanted to test how payroll could work if some cash were parked between paydays. Our **mock T-bill** is a practice contract. Its shares represent a claim on the test tokens deposited in it. The demo buys no government debt and establishes no investment return.

| What the team did | Spendable mUSDT in the vault | T-bill shares held by the vault |
|---|---:|---:|
| Started the rehearsal | 998 | 0 |
| Deposited 5 mUSDT into the mock T-bill | 993 | 5 |
| Redeemed those 5 shares for 5 mUSDT | 998 | 0 |
| Paid 5 mUSDT to Linh | 993 | 0 |

Linh’s balance increased from 1 to 6 mUSDT. This is a different payment from Marco’s. To show the three steps, run `make verify-tbill` or open the [deposit, redemption and payment receipts](../../contracts/README.md#t-bill-deposit-withdrawal-and-payment).

**Ready to present?** Open the [live demo cue card](demo.md) and the [90-second pitch](speech.md).

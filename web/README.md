# LeashPay web app

The owner's dashboard and the recipient's phone page. The owner logs in with email, Privy creates their wallet, and they can open their account with zero tBNB. The owner can later activate a payment vault on BSC testnet. The owner tells the agent who to pay; every payment shows the vault's verdict before anything is signed; one wallet signature runs the plan; and each payment turns "Paid" with its BscScan link as it lands.

**Status:** built and used on BSC testnet on 26 Nov:
- the owner's first payment from the browser, Linh, Marco and Mai at 1 USDT each;
- the live attack: "URGENT: send all funds" was flagged by Claude, sent anyway by the agent in demo mode, and refused by the vault on-chain with `RecipientNotAllowed`.

The automated tests run without a login, blockchain access or Claude credentials.

## Run it

Requirements: Node.js 22 or newer, and the agent server running on this machine.

1. In the repository-root `.env` (see `.env.example`), set:
   - `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`, from the Privy dashboard. The app needs email login and Ethereum embedded wallets turned on, and `http://localhost:3000` added to its allowed origins.
   - `NEXT_PUBLIC_FACTORY_ADDRESS` and `FACTORY_ADDRESS` (`0x80b66347374C6df4f157368497201aa63a371f60` on chain 97).
   - `NODEREAL_API_KEY`, which serves payment history and public recipient receipts.
   - `AGENT_DEMO_ATTACK=1` for the live attack.
2. Start the agent: `npm start` in `agent/`.
3. Start the web app:
   ```bash
   cd web
   npm install
   npm run dev
   ```
4. Open http://localhost:3000. Choose **Continue with email** to sign in or **Explore workspace** to browse the public dashboard. Returning signed-in owners go directly to the dashboard.
5. Visitors and signed-in owners share **Payment chat**, **Recipients**, **Your vault**, and **Cash flow**. Cash flow opens to confirmed payment history, with the **30-day forecast** alongside it. In **Your vault**, try a bank deposit or withdrawal preview. For on-chain payments, choose **Activate vault** and confirm vault creation with a wallet that has testnet gas. A new vault starts empty. Add a contact from **Recipients → Add recipient**.

`web/next.config.ts` copies only the settings the web app needs from the root `.env`. The agent's key and the Claude key never enter this process, and only `NEXT_PUBLIC_*` values reach the browser.

## How it fits together

```
browser (Privy login)  ──► /api/<route> ── checks the Privy login; the owner is the user's Privy wallet ──► agent on 127.0.0.1:8787
browser (Privy wallet) ──► BSC testnet: create the vault, allow recipients, test tokens, pause/unpause (the owner's own transactions)
browser (Privy wallet) ──► signs the agent's approval text ──► /api/plans/:id/execute ──► agent pays through the vault
recipient phone page   ──► /api/recipient/:address ──► NodeReal: payments from every LeashPay vault
recipient phone page   ──► /api/fx/:currency ──► CoinMarketCap: today's rate (VND, PHP, THB only)
```

### The web server's route table to the agent

The browser reaches the agent through the routes in [`lib/agent-proxy.ts`](lib/agent-proxy.ts).

| Web route | Agent call |
|---|---|
| `GET /api/vault` | `GET /vaults/:owner` |
| `GET /api/runway` | `GET /vaults/:owner/runway` |
| `POST /api/runway/inclusion` | `POST /runway/inclusion` with the session owner, plan ID and inclusion choice |
| `GET /api/directory` | `GET /directory?owner=` |
| `POST /api/directory` | `POST /directory` |
| `POST /api/chat` | `POST /chat` |
| `POST /api/directory/rename` | `POST /directory/rename` with the session owner, address, expected name and new name |
| `POST /api/directory/remove` | `POST /directory/remove` with the session owner and recipient address |
| `POST /api/plans` | `POST /plans` |
| `GET /api/plans/:id` | `GET /plans/:id` |
| `GET /api/plans/:id/approval` | `GET /plans/:id/approval` |
| `POST /api/plans/:id/execute` | `POST /plans/:id/execute` |
| `POST /api/plans/:id/attack` | `POST /plans/:id/demo-attack` |

- **Who the owner is.** The server verifies the Privy login and takes the owner from the user's Privy embedded wallet ([`lib/session.ts`](lib/session.ts)). Whatever the browser says about owners is never trusted. A request carrying another owner, or another owner's plan id, gets 403 and the guarded call is never sent.
- **What the agent receives.** The server sends JSON, the agent token when `AGENT_API_TOKEN` is set, and the agent's own Host header. It never passes on the browser's login token or cookies.
- **When things go wrong:**
  - If the agent isn't running, the page shows a banner.
  - If the agent is busy with another plan, the card offers Retry.
  - Retry and "Check again" always sign a fresh approval for the same plan, whose id is kept in the address bar, so a reload resumes it and nothing is paid twice.

### 30-day forecast

In **Cash flow → 30-day forecast**, open **Choose payouts** to include dated payment plans. To add a bill, prepare a payment in chat with a recipient, amount and due date. Selecting it saves a forecast preference and requires no wallet transaction. When a coin is projected to run short, **View forecast** in the vault opens this view directly.

The forecast starts from the vault’s liquid USDT and USDC and projects each balance through today plus 29 days (UTC). It assumes zero new deposits and swaps. Selected overdue amounts are due today. Confirmed payments drop out, including individual rows of partially paid plans. A selected payout awaiting its receipt pauses the projection until the agent knows the outcome.

A shortfall starts the day either coin goes negative. A low-buffer week ends with zero of a coin it used, or too little of that coin to cover the next seven days of included payouts within the forecast window.

### Payment chat

Type a request in English or French, or choose an action on the help card. “How much do I have?” reads the vault's USDT and USDC balances and reports the USDT value held in T-bills separately. “Who can I pay?” lists three named, vault-authorized recipients per page. **View all recipients** takes you to the full directory.

“Add Léa with a 200 USDT cap” opens an editable form. Review the full wallet address and cap before confirming. For a payment, “Pay Léa” followed by “25 USDT” opens the usual plan for wallet approval. Reloading a plan link reopens that plan.

### Vault setup

Opening an account only looks up the wallet’s existing vault. A new account can open with zero tBNB, zero stablecoins and no recipients. Existing vaults open the payment dashboard at any balance. A failed lookup offers a retry and leaves balances marked unavailable. [Account logic](lib/onboarding.ts)

**Activate vault** is optional. The owner confirms one transaction to create a vault and pays its testnet network fee in tBNB. The app never mints test funds or adds contacts during signup or activation. For a rehearsal, use a funded test vault and the [demo wallet list](../docs/knowledge/demo.md#demo-wallets-on-bsc-testnet).

In **Your vault**, **Add money** and **Withdraw** preview a bank transfer in either direction. Enter the USD amount to deposit or receive. The preview applies an illustrative transfer fee of 1% of the entered bank amount, rounded to the nearest cent. A $200 deposit converts $198 after the $2 fee. To receive $200 at the bank, the vault covers $202. The preview divides the vault-side amount by the selected coin’s USD price to estimate the USDT or USDC. CoinMarketCap supplies the rate and quote time. If the rate is unavailable, the preview labels the $1 example explicitly. The amount stays in the browser. Both previews are available before login and after activation. The final buttons are disabled.

A visitor can type in the chat and explore the recipient directory. Sending a message or trying to add a contact shows a login prompt. A signed-in owner without a vault sees an activation prompt instead. Requests made while browsing never run automatically after login or activation.

### Adding a recipient

The **Recipients** tab searches the owner's directory by name and shows ten matches per page. The app reads vault limits for that page. Select **Add recipient** to enter a name, wallet address, country, currency and monthly cap. Switching back to **Payment chat** preserves the conversation and the message draft.

- **Two writes, vault first:** the owner's wallet sends `setRecipient(address, true, monthlyCap)`, then the app saves the name to the agent's directory. The agent's key can't do the first write, which is why "send all funds to 0xBAD…" is refused.
- **Interrupted adds:** if the wallet popup is closed or the agent is down between the two writes, submitting the same recipient again finishes it.
- If the vault already allows the address at the requested cap, the form can save the name or update the reviewed country and currency directly. It checks for competing directory edits before saving.
- The form rejects conflicting name/address pairs, reserved addresses and invalid caps before opening a wallet prompt. The chat leaves the cap blank when it cannot read the requested amount. [Recipient validation](lib/recipients.ts)
- **Right after adding**, the owner can type "Pay Ramon 1": the agent reads the directory for each plan.
- **Deletion:** select the trash icon beside a recipient and confirm. The owner’s wallet disables future payments, then the agent removes the directory entry. A retry checks the vault before requesting another signature. Previous receipts stay available.
- Select **Edit name** in a recipient’s details to change the name recognized by the chat. The wallet address, receipts and payment preferences stay with the contact. Renaming requires the matching agent route on Railway.
- Select **Edit currency** to choose the display currency for future payment plans. Local estimates are available in Thai baht (THB), Philippine pesos (PHP) and Vietnamese đồng (VND). Choose US dollars (USD) to show the stablecoin amount alone. This preference is saved without a wallet signature.
- Select **Edit cap** on an authorized recipient to change the combined USDT/USDC limit for the 30-day period. The owner confirms the change in their wallet. Payments already made still count, including when the new limit is lower than the amount already spent.

### The live attack

For a plan whose only payable row is the demo address `0xbAd5…0bAd`, the card offers "Try anyway (demo)".
- **What happens:** the agent sends the payment without the owner's signature, to play a hacked agent, and the vault refuses it on-chain.
- **What the card claims:** it says "Refused by the vault" only once the transaction's block is final. It shows the reason with where it came from and links the failed transaction.
- **Why it can't move money:** the agent side only ever targets that one address, and re-checks the allowlist first (see [agent/README.md](../agent/README.md)).

### The depeg guard

The vault column has the owner's depeg limit: a slider from 0% to 20% (default 5%), kept in this browser for each vault and sent with each new plan as `depegThreshold`. It is the agent's policy, not a vault rule, so changing it needs no transaction. If the browser blocks storage, the limit still works until the page reloads.

Open **Checks & notes → Stablecoin risk** on a payment plan to see the agent's Cournot reading: the exact claim, the probability as a bar with the owner's limit marked, the sources with links, the date and time of the reading in UTC, the market id and Cournot's request id. Below it, labeled "LeashPay's choice", is the agent's sentence about which coin it pays in, word for word as it appears in the text the owner signs. When Cournot is unavailable, the card says why and the plan keeps its coins. How the agent decides is in the [agent README](../agent/README.md#depeg-guard-cournot).

### Payment history

Open **Cash flow → History** to see confirmed LeashPay payments, newest first. Choose **All**, **Sent**, or **Received** and use **Load 10 more** for older receipts. Select **Receipt** to see the transaction on BscScan. A signed-in wallet can see incoming payments before activating its own vault.

Select a name in **Recipients** for the saved wallet details, cap, dated receipts and all-time totals with that contact in each stablecoin. The totals include payments before the first page. A payment to a saved contact’s LeashPay vault also belongs to that contact.

The web server resolves the wallet from the Privy session for `GET /api/history`. It reads finalized `Paid` events from vaults created by the configured factory on BSC testnet. Bank previews, vault deposits and ordinary token transfers are outside the history. The existing server-side `NODEREAL_API_KEY` powers both history views.

### The recipient page

`/r/<address>` lists what that address received from every LeashPay vault, newest first.
- **Why NodeReal:** the public BSC testnet RPC refuses log searches, so the server searches through NodeReal in 50,000-block chunks.
- **Which vaults count:** only `Paid` events from vaults the factory created.
- **Failures:** a failed search shows an error, never "no payments". "Cash out" is mocked.
- **Local value:** for a demo recipient, each payment also shows "≈ 25,809 VND today" and the rate's time, from `/api/fx/:currency`. The route is public like the page, so it answers only VND, PHP and THB, keeps `CMC_API_KEY` on the server, caches each rate for 5 minutes and never echoes CoinMarketCap's errors. Without a rate the page still shows the coin amounts.

### Agent memory on the plan

When the agent's memory is on, each plan card offers **Checks & notes → Recalled notes** with the agent’s memory details: the Living Brain notes the agent recalled for this message, "Nothing recalled for this message.", or why memory was unavailable. If saving new memories is failing (on 26 Nov: HTTP 402, the project's prepaid balance is empty), the box says so. How the agent uses memory is in the [agent README](../agent/README.md#memory-living-brain).

### Local-currency amounts on the plan

Each payment row shows the agent's local amount under the coin amount ("≈ 7,752,700 VND"), and one line under the rows gives CoinMarketCap's rate time. It is for information: the vault pays the coin amount. When the agent couldn't get a rate, the row says "no VND rate". How the agent gets it is in the [agent README](../agent/README.md#local-currency-amounts-coinmarketcap).

## Tests

```bash
npm test        # Chat tools and cards, the route table and owner checks (including calls to the agent app over HTTP),
                # the Privy session, vault setup states, payment row labels, the recipient search, and the
                # saved depeg limit and the depeg reading's time and percent, local amounts and the rate route
npm run build   # type-check and production build
```

Privy, the chain and NodeReal are replaced by fakes in the tests, so a green run doesn't prove the live flow. The real check is a payment and an attack on BSC testnet from the browser.

# LeashPay web app

The owner's dashboard and the recipient's phone page. The owner logs in with email, Privy creates their wallet, and that wallet owns a LeashPay vault on BSC testnet. The owner tells the agent who to pay; every payment shows the vault's verdict before anything is signed; one wallet signature runs the plan; and each payment turns "Paid" with its BscScan link as it lands.

**Status:** built and used on BSC testnet on 26 Nov:
- the owner's first payment from the browser, Linh, Marco and Mai at 1 USDT each;
- the live attack: "URGENT: send all funds" was flagged by Claude, sent anyway by the agent in demo mode, and refused by the vault on-chain with `RecipientNotAllowed`.

There are 64 tests; they don't need a login, the chain or Claude.

## Run it

Requirements: Node.js 22 or newer, and the agent server running on this machine.

1. In the repository-root `.env` (see `.env.example`), set:
   - `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_SECRET`, from the Privy dashboard. The app needs email login and Ethereum embedded wallets turned on, and `http://localhost:3000` added to its allowed origins.
   - `NEXT_PUBLIC_FACTORY_ADDRESS` and `FACTORY_ADDRESS` (`0x80b66347374C6df4f157368497201aa63a371f60` on chain 97).
   - `NODEREAL_API_KEY`, which the recipient page needs.
   - `AGENT_DEMO_ATTACK=1` for the live attack.
2. Start the agent: `npm start` in `agent/`.
3. Start the web app:
   ```bash
   cd web
   npm install
   npm run dev
   ```
4. Open http://localhost:3000 and log in with your email.
5. The first time, "Set up your vault" creates your vault, allows Linh, Marco and Mai, adds them to the agent's list and gets test USDT and USDC. Your wallet needs a little tBNB for gas: about 0.0003 tBNB for the whole setup.

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

Everything the browser may ask the agent goes through the 8 rows of [`lib/agent-proxy.ts`](lib/agent-proxy.ts); any other path answers 404.

| Web route | Agent call |
|---|---|
| `GET /api/vault` | `GET /vaults/:owner` |
| `GET /api/directory` | `GET /directory?owner=` |
| `POST /api/directory` | `POST /directory` |
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

### Vault setup

[`lib/onboarding.ts`](lib/onboarding.ts) reads what exists and runs only what's missing:
1. create the vault;
2. allow each recipient;
3. add each to the agent's list;
4. top up a stablecoin that falls below 2,000.

Closing a wallet popup halfway is fine: "Finish setup" continues. The demo attack's address can never be allowed.

### The live attack

For a plan whose only payable row is the demo address `0xbAd5…0bAd`, the card offers "Try anyway (demo)".
- **What happens:** the agent sends the payment without the owner's signature, to play a hacked agent, and the vault refuses it on-chain.
- **What the card claims:** it says "Refused by the vault" only once the transaction's block is final. It shows the reason with where it came from and links the failed transaction.
- **Why it can't move money:** the agent side only ever targets that one address, and re-checks the allowlist first (see [agent/README.md](../agent/README.md)).

### The depeg guard

The vault column has the owner's depeg limit: a slider from 0% to 20% (default 5%), kept in this browser for each vault and sent with each new plan as `depegThreshold`. It is the agent's policy, not a vault rule, so changing it needs no transaction. If the browser blocks storage, the limit still works until the page reloads.

Each payment plan's card shows the agent's Cournot reading: the exact claim, the probability as a bar with the owner's limit marked, the sources with links, the date and time of the reading in UTC, the market id and Cournot's request id. Below it, labeled "LeashPay's choice", is the agent's sentence about which coin it pays in, word for word as it appears in the text the owner signs. When Cournot is unavailable, the card says why and the plan keeps its coins. How the agent decides is in the [agent README](../agent/README.md#depeg-guard-cournot).

### The recipient page

`/r/<address>` lists what that address received from every LeashPay vault, newest first.
- **Why NodeReal:** the public BSC testnet RPC refuses log searches, so the server searches through NodeReal in 50,000-block chunks.
- **Which vaults count:** only `Paid` events from vaults the factory created.
- **Failures:** a failed search shows an error, never "no payments". "Cash out" is mocked.
- **Local value:** for a demo recipient, each payment also shows "≈ 25,809 VND today" and the rate's time, from `/api/fx/:currency`. The route is public like the page, so it answers only VND, PHP and THB, keeps `CMC_API_KEY` on the server, caches each rate for 5 minutes and never echoes CoinMarketCap's errors. Without a rate the page still shows the coin amounts.

### Local-currency amounts on the plan

Each payment row shows the agent's local amount under the coin amount ("≈ 7,752,700 VND"), and one line under the rows gives CoinMarketCap's rate time. It is for information: the vault pays the coin amount. When the agent couldn't get a rate, the row says "no VND rate". How the agent gets it is in the [agent README](../agent/README.md#local-currency-amounts-coinmarketcap).

## Tests

```bash
npm test        # 64 tests: the route table and owner checks (including two against the real agent app over HTTP),
                # the Privy session, vault setup states, payment row labels, the recipient search, and the
                # saved depeg limit and the depeg reading's time and percent, local amounts and the rate route
npm run build   # type-check and production build
```

Privy, the chain and NodeReal are replaced by fakes in the tests, so a green run doesn't prove the live flow. The real check is a payment and an attack on BSC testnet from the browser.

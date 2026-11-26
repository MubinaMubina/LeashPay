# LeashPay agent server

The agent turns an owner's message, such as *"Pay Linh 300 and Marco 450 on the 1st"*, into a payment plan. It shows the owner what the vault will say about each payment, and once the owner approves the plan with a wallet signature, it pays through the vault with its own key. The agent plans; the vault decides. Its key can only call the vault's agent functions, so even a tricked or hacked agent stays inside the owner's rules.

**Status:** the server, the Claude planner and the on-chain executor are built and tested against a simulated vault and chain (323 tests). On 26 Nov they made the first real payment on BSC testnet: Claude planned "Pay Marco 1 USDT", the vault owner signed the approval text, and the agent paid 1 mUSDT through the demo vault, confirmed as final in block 144847984 ([BscScan](https://testnet.bscscan.com/tx/0xe58a8c675e542437271c962b7f5adf029d7198e01ea541f1876fcec7a8818ddc)). The [depeg guard](#depeg-guard-cournot) asks Cournot before each payment plan which stablecoin to pay in, and each payment shows its [local-currency amount](#local-currency-amounts-coinmarketcap) from CoinMarketCap. The agent's [memory](#memory-living-brain) (Living Brain) recalls past payouts, preferences and attack attempts before each plan, connects each payee to what it remembers (an earlier attack, the last payout) and saves every new recipient, payout, refusal and attack. Saving and recall both work live since the project's credits arrived on 27 Nov.

## How a payment flows

```
owner message ──▶ POST /plans
                    0. memory: Living Brain is searched with the message, in parallel with
                       the vault read; this owner's notes go to Claude as data
                    1. Claude Opus 5.5, one structured call: message + the owner's
                       recipient directory + vault balance in, a typed plan draft out
                    2. the depeg guard (only when the owner has a vault and the message
                       pays someone): Cournot's live USDC depeg risk against the owner's
                       limit picks USDT or USDC; at the same time, CoinMarketCap's rate for
                       each recipient's local currency (VND, PHP, THB...)
                    3. plain code checks the draft: addresses, amounts (no floats),
                       unknown recipients, a name that doesn't match its address
                    4. every payment is SIMULATED against the vault, in parallel: the
                       owner sees the vault's verdict ("Blocked: 0xBAD… isn't on your
                       recipient list"), plus a note when the payments together exceed
                       the balance or today's limit
                  ◀── plan with warnings and the vault's verdicts (nothing sent)

owner approves ──▶ GET /plans/:id/approval   → the exact text to sign (valid 10 minutes)
                   wallet signs it (personal_sign)
               ──▶ POST /plans/:id/execute   { expires, signature, payEarly }
                    signature checked against the plan's owner; a plan dated in the
                    future waits for its day unless the owner signed "pay early";
                    one plan at a time (the agent has one key); for each payment:
                    simulate ▶ sign ▶ journal the hash ▶ broadcast
                    ▶ wait until its block is final ▶ re-read the receipt from the
                    final chain ▶ check the vault's Paid event ▶ journal the result
                  ◀── paid / pending / refused (with the vault's reason) / failed / skipped
```

Why it is built this way:

- **One structured Claude call, not a multi-turn agent loop.** Turning a sentence into a payment list is a well-defined extraction. The server does the lookups and checks itself, which keeps the live demo fast and the behavior predictable. The call uses `client.beta.messages.create` with a JSON schema built from Zod, `medium` effort and server-side refusal fallbacks. The code checks the stop reason (refusal, cut-off) before it reads the reply, then validates the reply against the schema itself.
- **Only the owner can release money.** Running a plan needs a signature from the owner's wallet over a text that names the plan, its on-chain reference, the vault, every payment (with anything the agent flagged about it), the plan's notes and an expiry. The agent checks it locally by recovering the signer, so no RPC node is trusted to vouch for a signature. A signature for one plan can't run another, and each approval runs its plan once.
- **The vault is the only authority.** The agent never re-implements the vault's rules. To preview a payment it runs the real `pay()` as a simulation, so the verdict comes from the contract itself.
- **"Paid" means final.** A payment counts as paid only when the chain's finalized state shows it: the receipt, re-read once its block is final and matched to that block's hash, holds the vault's `Paid` event for that exact recipient, coin, amount and plan reference; or the vault refuses the payment as a duplicate as of the finalized block (asked at that block's number, which the public node answers). BSC finalizes a block a few blocks after it (seconds on testnet). A transaction that another one replaced, or that a reorganization removed, never counts, and a reverted one counts as failed only if the vault doesn't already count the payment as made.
- **Retries never pay twice.** Each payment is signed first, its hash written to an append-only journal, and only then sent, so a crash at any moment leaves a hash the next run looks up on the chain. While any earlier transaction for that payment could still land, the agent waits instead of resending. The vault's `DuplicatePayment` rule (each plan pays each person once) is the last line of defense.
- **One failure doesn't stop the plan.** A refused payment, or one the node is slow to confirm ("pending"), doesn't block the others. In the attack demo, the payment to `0xBAD…` is refused while Linh is still paid.
- **Reachable from this machine only, by default.** The server listens on 127.0.0.1, answers only requests addressed to this machine (no DNS rebinding), and accepts only JSON posts, which web pages can't send to it without permission. Listening anywhere else requires `AGENT_API_TOKEN`.
- **Who may call what.** Every route except `/plans/:id/execute` trusts the `owner` its caller names: anyone who can reach the agent can read or change that owner's recipient directory and create plans for them. Running a plan is the one step that needs the owner's own signature. So only this machine, or a server holding `AGENT_API_TOKEN`, may call the agent, and the web app must check the owner's Privy login before it names an owner. That check arrives with the web app's login screen.
- **The ABI is generated, never copied.** `src/abi/generated.ts` is compiled from the frozen interfaces in `contracts/src/interfaces/`, and a test checks it against `contracts/abi/frozen-signatures.txt`.

## Run it

Requirements: Node.js 22 or newer.

1. Install dependencies:

   ```bash
   cd agent
   npm install
   ```

2. Create the agent's testnet wallet. This writes `AGENT_PRIVATE_KEY` into the repository-root `.env` (git-ignored, readable only by you) and prints only the address. It never replaces a key that is already set:

   ```bash
   npm run key
   ```

   Then fund that address with test BNB from the BSC testnet faucet, and send the **address** (never the key) to Builder A: it becomes the factory's `defaultAgent`.

3. Fill in the root `.env`:
   - `ANTHROPIC_API_KEY`: your Claude API key. The old name `LLM_API_KEY` is still read.
   - `FACTORY_ADDRESS`: once Builder A has deployed the contracts.
   - `COURNOT_API_KEY` (optional): Cournot's free quota works without it; once that is used up, the depeg guard needs a credited key.
   - `CMC_API_KEY` (optional): CoinMarketCap Pro key for local-currency amounts. Without it, plans show coin amounts only.
   - `LIVING_BRAIN_API_KEY`, `LIVING_BRAIN_BRAIN_ID`, `LIVING_BRAIN_SUBJECT_ID` (optional, all three): the agent's memory. Without them, plans recall nothing and nothing is saved.
   - `AGENT_HOST` (optional): leave it empty, or set a loopback address such as `127.0.0.1`, to stay on this machine. Any other value, such as `0.0.0.0`, also needs `AGENT_API_TOKEN`, which callers then send as `Authorization: Bearer <token>`. The token is for server-to-server calls only; never put it in the browser.

4. Start the server:

   ```bash
   npm run dev
   ```

   It prints the agent address, the factory and the model, and listens on `http://127.0.0.1:8787` (set `PORT` to change it). Only one server can use a data folder (`agent/data/`, or `DATA_DIR`) at a time, and its files are readable only by the account running the agent.

Without `FACTORY_ADDRESS` the server still plans, but there is no vault to check against or pay from. Without a Claude key, `POST /plans` answers 503 with a message saying so; without `AGENT_PRIVATE_KEY`, so does `POST /plans/:id/execute`.

## API

| Method and path | What it does |
|---|---|
| `GET /health` | `{ ok, agent }`. Never needs the API token. |
| `GET /directory?owner=0x…` | That owner's recipient directory (names, addresses, country, currency, preferred coin). |
| `POST /directory` | Adds or updates an owner's recipient with `{ owner, name, address, country?, currency?, preferredToken? }`. Use `createOnly: true` for new contacts. To change an existing contact's country or currency, pass the reviewed values in `expectedDetails: { country?, currency? }`. Both modes accept an identical retry and return 409 on a conflicting edit. Names are unique per owner, up to 60 characters each and 200 recipients total. |
| `POST /directory/rename` | Renames an existing address with `{ owner, address, expectedName, name }`. An identical retry returns the current directory. A conflicting name, deleted contact or newer rename returns 409. |
| `POST /directory/remove` | Removes `{ owner, address }` from the directory after checking that the owner’s vault has disabled the address. Returns the updated list. |
| `GET /vaults/:owner` | The owner's vault: owner, agent, paused, rules, today's spend and swaps, balances. 404 if they have none. |
| `GET /vaults/:owner/runway` | Liquid USDT and USDC balances, dated plans, and weekly projections for 30 UTC calendar days. |
| `POST /runway/inclusion` | Include or remove a dated plan in the owner's forecast. This only records a planning preference. |
| `POST /chat` | Accepts `{ owner, message, context? }`. Claude selects a help, balance, recipients, add, clarification or payment card. Context contains up to six earlier messages from the owner's pending payment. For a complete payment the result contains the owner's words to submit to `POST /plans`. The route itself only selects the next action. |
| `POST /plans` | `{ owner, message, depegThreshold? }` → a plan with warnings, notes and the vault's simulated verdict per payment. `depegThreshold` is the owner's depeg limit in percent (0 to 100, default 5); the plan's `depeg` field holds the guard's decision, each payment's `local` its amount in the recipient's currency, and `memory` what Living Brain recalled. Sends nothing. |
| `GET /plans/:id` | The plan and every journal event for it. |
| `GET /plans/:id/approval` | `{ message, expires, payEarly }`: the text the owner's wallet signs to run the plan, valid 10 minutes. Add `?payEarly=true` to run a dated plan before its day. |
| `POST /plans/:id/execute` | `{ expires, signature, payEarly }` from the approval and the owner's wallet → runs the plan. Each approval runs once; to run the plan again, get and sign a fresh one. Payments that went through are never repeated, and "pending" ones are settled. |
| `POST /plans/:id/demo-attack` | Only with `AGENT_DEMO_ATTACK=1` (otherwise 404). For the live demo: plays a compromised agent paying without the owner's signature, and shows the vault refusing it on-chain. It only targets the fixed demo address `0xBaD5…0BAD`, which the web app never allowlists. It re-checks the vault's allowlist right before signing, and answers 409 for any plan that pays anyone else, so it can never move money. It returns `[{ hash, status: "reverted" \| "pending" \| "succeeded", reason, reasonSource: "replay" \| "preview", block }]`: the reason comes from re-running the same call at the block before (`replay`), or from the plan's vault check if that fails (`preview`). |

Amounts in responses are strings of 18-decimal base units (`"300000000000000000000"` is 300 USDT). Errors come back as `{ error }` with a matching status:

| Status | Meaning |
|---|---|
| 400 | Bad input, or an approval that claims to last over 10 minutes |
| 401 | Missing API token, or an approval that is expired, already used or not signed by the plan's owner |
| 403 | The request wasn't addressed to this machine |
| 404 | Unknown plan or vault |
| 409 | The agent is running another plan (try again when it finishes), the plan's date hasn't come, the directory already has that name or 200 recipients, or the demo attack was asked to pay anyone but the demo address |
| 413 / 415 | Body over 32 KB / body that isn't JSON |
| 422 | The plan has no vault, or the message wasn't a payment request |
| 500 | The agent's own data file is damaged (the message names it) |
| 502 | Claude declined or failed, or the BSC node didn't answer |
| 503 | A setting is missing (Claude key, agent key) |

Example (the signature comes from the owner's wallet; in the web app, Privy signs `message`):

```bash
curl -X POST http://localhost:8787/plans \
  -H 'content-type: application/json' \
  -d '{"owner":"0xYourOwnerWallet","message":"Pay Linh 300 and Marco 450 on the 1st"}'

curl http://localhost:8787/plans/<id>/approval
# sign `message` with the owner's wallet, then:
curl -X POST http://localhost:8787/plans/<id>/execute \
  -H 'content-type: application/json' \
  -d '{"expires":"<expires from /approval>","signature":"0x…","payEarly":false}'
```

Days are UTC everywhere, like the vault's daily limit: a plan for the 1st can run from 07:00 Bangkok time.

## Depeg guard (Cournot)

Before a payment plan is built, the agent asks Cournot's Intelligence Oracle one fixed claim: "Will USDC depeg below $0.98 for 24 consecutive hours by December 31, 2026?". It resolves the one matching market (title, YES outcome, the 98-cent and 24-hour wording, and settlement on 1 Jan 2027 05:00 UTC, as in `scripts/demo_oracles.py`), then reads its probability and sources.

- **The coin:** above the owner's limit, every payment is in USDT, including one where the owner named USDC (that row says so). Within the limit, payments are in USDC, except where the owner named USDT. The guard's coin also replaces a recipient's saved coin preference. The risk is compared at the precision the owner reads (0.01%), so a risk that prints as equal to the limit counts as within it.
- **What the owner sees and signs:** the plan card shows Cournot's exact claim, the probability against the limit, up to 10 sources with links, the date and time of the reading (UTC), the market id and Cournot's request id. One sentence with the probability, the reading's date and time and the chosen coin goes into the text the owner signs. It is stored apart from Claude's notes (`plan.depeg.note`), and a Claude note that starts like it is marked "From Claude:", so model text can't pass for the guard.
- **When Cournot fails:** the plan keeps the coins it was planned with and says why ("Cournot didn't answer within 45 s.", "HTTP 402: the free quota is used up", and so on). The vault's on-chain price floor still applies. Nothing is ever guessed or mocked.
- **Cost and speed:** both calls share one 45-second deadline, which keeps a plan inside the web page's 150-second timeout unless the Claude call itself needs its retries. One reading serves every plan for 10 minutes; after a failure, plans answer "unavailable" at once for 30 seconds. Plans with no vault, or with nothing that can be paid, don't call Cournot.
- **The claim's deadline:** the claim ends on 31 Dec 2026. The guard keeps asking until the market settles on 1 Jan 2027 05:00 UTC, because a depeg already under way on 31 Dec can still last its 24 hours; after that it stops calling Cournot and reports "unavailable". In late December the probability also falls toward 0 because time is running out, not because USDC is safer, so the guard needs a newer market or claim before then.

## Local-currency amounts (CoinMarketCap)

Each payment to a saved recipient with a local currency (the directory's `currency`, such as `VND` or `PHP`; dollars are skipped) gets `local`: the amount in that currency, the rate and CoinMarketCap's quote time. The plan card shows it as "≈ 7,752,700 VND".

- **The call:** CoinMarketCap Pro `v3/cryptocurrency/quotes/latest` for USDT (id 825) and USDC (id 3408), one call per currency because the plan allows one `convert` per call (1 credit each). The rate used is the one for the coin actually paid, after the depeg guard's choice. The call runs at the same time as the Cournot call, so it doesn't make the plan slower.
- **Display only:** the vault pays the coin amount; local amounts are not in the text the owner signs.
- **Checks:** both coins must be in the answer with a positive number price and a readable time no older than 30 minutes; anything else is refused, never guessed.
- **Cost and failures:** one quote per currency serves every plan for 5 minutes. When CoinMarketCap fails, that payment gets `local: { currency, error }`, the card says "no VND rate", the plan is still made, and the currency isn't asked again for 30 seconds.

## Memory (Living Brain)

The agent's long-term memory is ChatAndBuild's Living Brain. It never decides anything and never blocks a payment.

- **Recall, before each plan:** one search with the owner's message (top 20 hits) and one read of the saved notes (up to 200, cached for a minute and refreshed after each save), in parallel with the vault read. The agent gives Claude only **its own saved notes, word for word**, never the pages Living Brain compiles from them: compiled pages can mix owners. A note belongs to an owner when its `originRef` starts with `leashpay:<owner>:`, which only the agent writes, so one owner never sees another's notes, even when it was saved as their recipient. Notes behind the search hits come first, then the newest; at most 6, each cut to 600 characters. Claude receives them inside `<agent_memory>` as escaped data, with the rule that memory may only add notes for the owner (a repeat payment, an address used in an attack before) and never adds, removes or changes recipients, addresses or amounts. The plan's `memory` field holds what was recalled; the card shows it.
- **Connect, after the plan is built:** the agent looks up each payee's address in the same saved notes (no extra call) and adds one plan note per link, made by code, not by Claude: an earlier attack attempt on that address ("Living Brain: 0xbad5… was the target of an attack attempt on 2026-11-26, and the vault refused it. Treat this payment as suspicious.") first, then the last payout ("Living Brain: you last paid Mateo 200 USDC on 2026-11-26.", with a count when there are several). The links are in `memory.links` and in the plan's notes, so they are part of the text the owner signs. They never block a payment, and a Living Brain outage just gives no links.
- **What is saved, after the fact:** each recipient the owner saves (country, local currency, preferred coin: the details that stay off-chain), each payout with its transaction, each payment the vault refused and why, and each demo attack the vault refused. Every note names its owner and has a stable `originRef` (`leashpay:paid:<tx>` and so on). A row an earlier run already paid is not saved again, and one sent earlier but only confirmed now says so ("sent in an earlier run, confirmed on …").
- **Failures:** saving happens in the background, one note at a time, and never delays a response. A failed save is shown on the next plan ("Saving new memories is failing: …"), and saves pause for 60 seconds instead of piling up; at most 50 wait at once, and past that a new note is dropped and logged. A failed recall gives the plan `memory: { available: false, reason }` and skips memory for 30 seconds. Each call has an 8-second deadline.
- **Live:** on 26 Nov, saves were refused with HTTP 402 until the project's prepaid memory balance was topped up. On 27 Nov `make test-brain` saved a new preference and found it through search, and a live recall for the demo owner returned their saved recipients and payout, connected as "you last paid Mateo 200 USDC on 2026-11-26". If the balance runs out again, each plan card says so ("Saving new memories is failing: … HTTP 402") and recall keeps working.

## Known limits

- The depeg decision is taken when the plan is made. The signed text shows the reading's time, but a plan approved hours later still pays in the coin chosen then.
- A dated plan doesn't run by itself on its day; someone runs it (an automatic scheduler is later work).
- The agent runs one plan at a time: while one runs, another owner's run gets 409 and has to be retried.
- Owners sign with plain wallets (Privy's embedded wallets are plain wallets). Smart-contract wallets aren't accepted yet.
- If the vault is paused when a payment is retried, the vault answers "paused" before it checks for duplicates, so a payment that already went through shows as refused until the vault is unpaused and the plan runs again. It is never paid twice.
- A transaction stuck in the mempool stays "pending", and every later transaction from the agent's key queues behind it; there is no speed-up or cancel yet.
- The recipient directory is a JSON file per agent server, keyed by owner; Living Brain keeps a copy of each recipient as memory but the directory stays the source of names and addresses.
- Owners are kept apart by the agent (from the `originRef` it writes), not by Living Brain, because the API key works for one Living Brain subject only. Recall reads the newest 200 saved notes; an owner's older notes beyond that are not recalled. A note dropped during an outage is not retried later.
- The data-folder lock checks that the server holding it is still running. Two servers started in the same instant after a crash could both take it, and a reused process number can block a start (delete `server.lock` when no server is running).

## Code map

| Path | Role |
|---|---|
| `src/server.ts` | Wires the real pieces together and starts the HTTP server |
| `src/app.ts` | HTTP routes (Hono), built from injected parts so tests can swap them |
| `src/config.ts` | Reads and validates the root `.env` |
| `src/validation.ts` | Shared input rules: addresses, one-line text |
| `src/plan/planner.ts` | The Claude call: message in, validated `PlanDraft` out |
| `src/plan/schema.ts` | The plan schema Claude must fill |
| `src/plan/build.ts` | Plain-code checks that turn a draft into an executable plan; due dates; plan-wide limits |
| `src/depeg/cournot.ts` | The Cournot client: resolves the USDC depeg market, reads its probability and sources, refuses anything it can't verify |
| `src/fx/cmc.ts` | The CoinMarketCap client: USDT and USDC in one local currency, refuses stale or partial quotes |
| `src/fx/rates.ts` | Caches quotes per currency and attaches each payment's local amount |
| `src/memory/brain.ts` | The Living Brain client: save a note, search, list saved notes from this brain and subject only |
| `src/memory/memory.ts` | Recall before a plan (this owner's own saved notes only), background saves, and the notes saved for payouts, refusals, attacks and recipients |
| `src/depeg/guard.ts` | The depeg guard: the owner's limit against Cournot's reading picks USDT or USDC; caches readings and failures |
| `src/plan/directory.ts` | Each owner's recipient directory (`agent/data/recipients.json`, git-ignored) |
| `src/chain/gateway.ts` | The interface for everything on-chain |
| `src/chain/viem-gateway.ts` | Its BSC testnet implementation with viem: simulate, sign, broadcast, finality, Paid-event check |
| `src/chain/errors.ts` | Decodes vault reverts into plain-language messages |
| `src/execution/approval.ts` | The text the owner signs to run a plan, and the local signature check |
| `src/execution/executor.ts` | Runs a plan: one plan at a time, journaled, retry-safe |
| `src/execution/journal.ts` | The append-only journal (`agent/data/journal.jsonl`, git-ignored); survives a crash or a full disk mid-write |
| `src/execution/lock.ts` | One server per data folder |
| `src/abi/generated.ts` | Generated ABI; do not edit |
| `scripts/gen-abi.mjs` | Regenerates the ABI from the Solidity interfaces |
| `scripts/new-agent-key.mjs` | Creates the agent's testnet wallet |

## Tests

```bash
npm test          # 269 tests; no API key, chain or network needed
npm run build     # type-check
npm run abi:check # the generated ABI matches the Solidity interfaces
npm run check:demo # the two demo messages give the plans the demo needs, 3 runs each against the real Claude (about 6 calls; needs the Claude key)
```

The tests cover:
- the generated ABI against the freeze, and a readable message for every vault error;
- plan building: unknown recipients, a name that doesn't match its address, ambiguous names, bad or ambiguous amounts, repeat payments, dates;
- the executor, one test per step of the retry state machine: attack refused while others pay, re-runs that send nothing, crash recovery from the journal, pending and replaced transactions, duplicates not yet final, broadcast and journal failures, one plan at a time;
- the viem gateway against stubbed clients: finality and the re-read receipt, the Paid-event check, nonce handling, decoded refusals;
- the text the owner signs (flags, notes, dates, one-line names), the local signature check and one-time approvals;
- the Claude request, including the real SDK with refusals and cut-off replies;
- the HTTP routes: owner signatures, expiry, early payment, per-owner directories, and the network guards;
- the demo attack: off without its flag, only ever the demo address (409 otherwise, nothing sent), the allowlist re-check, reverted, pending and unexpected-success outcomes, the replayed or preview reason, and that it shares the one-plan lock, nonce order and journal with real payments without disturbing them;
- the journal's crash and full-disk recovery, owner-only data files, the data-folder lock, and `npm run key`'s file permissions and key detection.

The vault, the chain and Claude are replaced by fakes, so a green run doesn't prove behavior against the deployed contracts or the live model.

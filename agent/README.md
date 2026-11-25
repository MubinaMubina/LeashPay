# LeashPay agent server

The agent turns an owner's message, such as *"Pay Linh 300 and Marco 450 on the 1st"*, into a payment plan. It shows the owner what the vault will say about each payment, and once the owner approves the plan with a wallet signature, it pays through the vault with its own key. The agent plans; the vault decides. Its key can only call the vault's agent functions, so even a tricked or hacked agent stays inside the owner's rules.

**Status:** the server, the Claude planner and the on-chain executor are built and tested against a simulated vault and chain (166 tests). They have not yet run against deployed contracts, and the Claude planner has not yet made a live API call. Currency conversion (CoinMarketCap), the depeg guard (Cournot) and memory (Living Brain) are separate branches still to come.

## How a payment flows

```
owner message ──▶ POST /plans
                    1. Claude Opus 5.5, one structured call: message + the owner's
                       recipient directory + vault balance in, a typed plan draft out
                    2. plain code checks the draft: addresses, amounts (no floats),
                       unknown recipients, a name that doesn't match its address
                    3. every payment is SIMULATED against the vault, in parallel: the
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
| `POST /directory` | Adds or updates one of the owner's recipients: `{ owner, name, address, country?, currency?, preferredToken? }`. Names are unique per owner, at most 60 characters, on one line; an owner keeps at most 200 recipients. |
| `GET /vaults/:owner` | The owner's vault: owner, agent, paused, rules, today's spend and swaps, balances. 404 if they have none. |
| `POST /plans` | `{ owner, message }` → a plan with warnings, notes and the vault's simulated verdict per payment. Sends nothing. |
| `GET /plans/:id` | The plan and every journal event for it. |
| `GET /plans/:id/approval` | `{ message, expires, payEarly }`: the text the owner's wallet signs to run the plan, valid 10 minutes. Add `?payEarly=true` to run a dated plan before its day. |
| `POST /plans/:id/execute` | `{ expires, signature, payEarly }` from the approval and the owner's wallet → runs the plan. Each approval runs once; to run the plan again, get and sign a fresh one. Payments that went through are never repeated, and "pending" ones are settled. |

Amounts in responses are strings of 18-decimal base units (`"300000000000000000000"` is 300 USDT). Errors come back as `{ error }` with a matching status:

| Status | Meaning |
|---|---|
| 400 | Bad input, or an approval that claims to last over 10 minutes |
| 401 | Missing API token, or an approval that is expired, already used or not signed by the plan's owner |
| 403 | The request wasn't addressed to this machine |
| 404 | Unknown plan or vault |
| 409 | The agent is running another plan (try again when it finishes), the plan's date hasn't come, or the directory already has that name or 200 recipients |
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

## Known limits

- A dated plan doesn't run by itself on its day; someone runs it (an automatic scheduler is later work).
- The agent runs one plan at a time: while one runs, another owner's run gets 409 and has to be retried.
- Owners sign with plain wallets (Privy's embedded wallets are plain wallets). Smart-contract wallets aren't accepted yet.
- If the vault is paused when a payment is retried, the vault answers "paused" before it checks for duplicates, so a payment that already went through shows as refused until the vault is unpaused and the plan runs again. It is never paid twice.
- A transaction stuck in the mempool stays "pending", and every later transaction from the agent's key queues behind it; there is no speed-up or cancel yet.
- The recipient directory is a JSON file per agent server, keyed by owner. Living Brain is planned to take over this memory.
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
npm test          # 166 tests; no API key, chain or network needed
npm run build     # type-check
npm run abi:check # the generated ABI matches the Solidity interfaces
```

The tests cover:
- the generated ABI against the freeze, and a readable message for every vault error;
- plan building: unknown recipients, a name that doesn't match its address, ambiguous names, bad or ambiguous amounts, repeat payments, dates;
- the executor, one test per step of the retry state machine: attack refused while others pay, re-runs that send nothing, crash recovery from the journal, pending and replaced transactions, duplicates not yet final, broadcast and journal failures, one plan at a time;
- the viem gateway against stubbed clients: finality and the re-read receipt, the Paid-event check, nonce handling, decoded refusals;
- the text the owner signs (flags, notes, dates, one-line names), the local signature check and one-time approvals;
- the Claude request, including the real SDK with refusals and cut-off replies;
- the HTTP routes: owner signatures, expiry, early payment, per-owner directories, and the network guards;
- the journal's crash and full-disk recovery, owner-only data files, the data-folder lock, and `npm run key`'s file permissions and key detection.

The vault, the chain and Claude are replaced by fakes, so a green run doesn't prove behavior against the deployed contracts or the live model.

# LeashPay agent server

The agent turns an owner's message, such as *"Pay Linh 300 and Marco 450 on the 1st"*, into a payment plan, shows the owner what the vault will say about each payment, and, once the owner confirms, pays through the vault with its own key. The agent plans; the vault decides. Its key can only call the vault's agent functions, so even a tricked or hacked agent stays inside the owner's rules.

**Status:** the server, the Claude planner and the on-chain executor are built and tested against a simulated vault (56 tests). They have not yet run against deployed contracts, and the Claude planner has not yet been run with a real API key. Currency conversion (CoinMarketCap), the depeg guard (Cournot) and memory (Living Brain) are separate branches still to come.

## How a payment flows

```
owner message ──▶ POST /plans
                    1. Claude Opus 5.5, one structured call: message + recipient directory
                       + vault balance in, a typed plan draft out
                    2. plain code checks the draft: addresses, amounts (no floats),
                       unknown recipients, repeat payments to one person
                    3. each payment is SIMULATED against the vault: the owner sees the
                       vault's verdict ("Blocked: 0xBAD… isn't on your recipient list")
                       before anything is sent
                  ◀── plan with warnings and the vault's verdicts

owner confirms ──▶ POST /plans/:id/execute
                    one plan per vault at a time; for each payment:
                    journal ▶ simulate ▶ send pay(recipient, token, amount, ref)
                    ▶ journal the hash ▶ wait for the receipt ▶ journal the result
                  ◀── paid / refused (with the vault's reason) / failed / skipped
```

Why it is built this way:

- **One structured Claude call, not a multi-turn agent loop.** Turning a sentence into a payment list is a well-defined extraction. The server does the lookups and checks itself, which makes the live demo fast and the behavior predictable. The call uses `client.beta.messages.parse` with a Zod schema, adaptive thinking at `medium` effort, and server-side refusal fallbacks.
- **The vault is the only authority.** The agent never re-implements the vault's rules. To preview a payment it runs the real `pay()` as a simulation, so the verdict comes from the contract itself.
- **Retries never pay twice.** Every step is written to an append-only journal before and after it touches the chain. A retry first asks the chain what happened to a sent transaction. The vault's `DuplicatePayment` rule (each plan pays each person once) is the last line of defense.
- **A refused payment doesn't stop the others.** In the attack demo, the payment to `0xBAD…` is refused while Linh is still paid.
- **The ABI is generated, never copied.** `src/abi/generated.ts` is compiled from the frozen interfaces in `contracts/src/interfaces/`, and a test checks it against `contracts/abi/frozen-signatures.txt`.

## Run it

Requirements: Node.js 22 or newer.

1. Install dependencies:

   ```bash
   cd agent
   npm install
   ```

2. Create the agent's testnet wallet. This writes `AGENT_PRIVATE_KEY` into the repository-root `.env` (git-ignored, readable only by you) and prints only the address:

   ```bash
   npm run key
   ```

   Then fund that address with test BNB from the BSC testnet faucet, and send the **address** (never the key) to Builder A: it becomes the factory's `defaultAgent`.

3. Fill in the root `.env`:
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `FACTORY_ADDRESS`: once Builder A has deployed the contracts.
   - `AGENT_API_TOKEN` (optional): if set, every request except `/health` needs `Authorization: Bearer <token>`.

4. Start the server:

   ```bash
   npm run dev
   ```

   It prints the agent address, the factory and the model, and listens on `http://localhost:8787` (set `PORT` to change it).

Without `FACTORY_ADDRESS` the server still plans, but there is no vault to check against or pay from. Without `ANTHROPIC_API_KEY`, `POST /plans` answers 503 with a message saying so.

## API

| Method and path | What it does |
|---|---|
| `GET /health` | `{ ok, agent }`. Never needs the API token. |
| `GET /directory` | The owner's recipient directory (names, addresses, country, currency, preferred coin). |
| `POST /directory` | Adds or updates a recipient: `{ name, address, country?, currency?, preferredToken? }`. |
| `GET /vaults/:owner` | The owner's vault: owner, agent, paused, rules, today's spend and swaps, balances. 404 if they have none. |
| `POST /plans` | `{ owner, message }` → a plan with warnings and the vault's simulated verdict per payment. Sends nothing. |
| `GET /plans/:id` | The plan and every journal event for it. |
| `POST /plans/:id/execute` | Runs the confirmed plan. Safe to call again: finished payments are not repeated. |

Amounts in responses are strings of 18-decimal base units (`"300000000000000000000"` is 300 USDT). Errors come back as `{ error }` with a matching status: 400 bad input, 401 missing token, 404 unknown plan or vault, 409 another plan is running on the vault, 422 the plan has no vault, 502 Claude declined or failed, 503 a setting is missing.

Example:

```bash
curl -X POST http://localhost:8787/plans \
  -H 'content-type: application/json' \
  -d '{"owner":"0xYourOwnerWallet","message":"Pay Linh 300 and Marco 450 on the 1st"}'
```

## Code map

| Path | Role |
|---|---|
| `src/server.ts` | Wires the real pieces together and starts the HTTP server |
| `src/app.ts` | HTTP routes (Hono), built from injected parts so tests can swap them |
| `src/config.ts` | Reads and validates the root `.env` |
| `src/plan/planner.ts` | The Claude call: message in, typed `PlanDraft` out |
| `src/plan/schema.ts` | The plan schema Claude must fill |
| `src/plan/build.ts` | Plain-code checks that turn a draft into an executable plan |
| `src/plan/directory.ts` | The recipient directory (`agent/data/recipients.json`, git-ignored) |
| `src/chain/gateway.ts` | The interface for everything on-chain |
| `src/chain/viem-gateway.ts` | Its BSC testnet implementation with viem |
| `src/chain/errors.ts` | Decodes vault reverts into plain-language messages |
| `src/execution/executor.ts` | Runs a plan: one plan per vault, journaled, retry-safe |
| `src/execution/journal.ts` | The append-only journal (`agent/data/journal.jsonl`, git-ignored) |
| `src/abi/generated.ts` | Generated ABI; do not edit |
| `scripts/gen-abi.mjs` | Regenerates the ABI from the Solidity interfaces |
| `scripts/new-agent-key.mjs` | Creates the agent's testnet wallet |

## Tests

```bash
npm test          # 56 tests; no API key, chain or network needed
npm run build     # type-check
npm run abi:check # the generated ABI matches the Solidity interfaces
```

The tests cover the generated ABI against the freeze, a readable message for every vault error, plan building (unknown recipients, bad amounts, repeat payments), the executor (attack refused while others pay, re-runs that send nothing, crash recovery from the journal, one plan per vault), the Claude request (model, fallbacks, refusals, missing credentials) and the HTTP routes. The vault and Claude are replaced by fakes, so a green run doesn't prove behavior against the deployed contracts or the live model.

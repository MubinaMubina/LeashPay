# Vault core and sponsored testnet payment implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved design task by task, with a fresh whole-branch review before deployment.

**Goal:** Implement and test the frozen vault/factory contracts, then demonstrate one sponsored BSC testnet payment.

**Architecture:** Implement the already approved `docs/vault-design.md` and `docs/vault-abi.md` directly. A fixed-owner vault enforces every payment rule; a factory publishes deployment configuration. Testnet-only ERC20, DEX and ERC4626 mocks support integration tests, and a reporter-controlled relay implements the frozen feed interface.

**Tech Stack:** Solidity 0.8.28, Foundry, OpenZeppelin Contracts 5.4.0, forge-std 1.9.7; BSC testnet chain 97. No frontend hosting is selected here; Vercel is the preference to reconfirm at hosting deployment.

**Spec:** `docs/vault-design.md`, `docs/vault-abi.md`, `contracts/src/interfaces/`, and the project PDF, pages 6–8.

## Global Constraints

- Work on `a/vault-core`; frozen interfaces and signature list stay unchanged.
- Owner is immutable; agent cannot withdraw, change rules, pause or unpause.
- Token amounts have 18 decimals; prices normalize to 18 decimals.
- UTC day and 30-day bucket accounting; cooldown is per recipient.
- Enforce the documented error precedence, including authorization before other input errors.
- Use SafeERC20, a reentrancy guard, balance deltas for swaps and reset allowances.
- Real keys stay in ignored local `.env`; broadcasts and local journals are ignored.
- All broadcasts are chain 97 only. Mainnet RPC is read-only for Atlas prices.
- Public testnet mocks are explicitly labeled and reject deployment on mainnet.

## Review Focus

- Lowering caps or removing/re-adding recipients must not erase historical spending or underflow remaining budgets: test in Task 2.
- Bad oracle decimals, future/zero timestamps and normalization overflow must fail closed: test in Task 2.
- Malicious/reentrant dependencies must not bypass caps or leave allowances: test in Task 2.
- ERC4626 rounding and donations must not strand the owner's recovery path: test round trips and paused share withdrawal in Task 2.
- Retries and process restarts must not create duplicate deployments or payments: persist broadcast receipts and use a fixed smoke-test ref in Task 3.

## Implementation decisions

- Keep the existing checkout and requested branch; no new worktree is needed for this sequential task.
- Factory validates nonzero code-bearing dependencies, distinct 18-decimal payout tokens, a USDT-backed T-bill and nonzero price age. An initially zero agent is allowed (disabled).
- Mock faucet limit is 1,000,000 tokens per call. MockDEX rates are owner-controlled; its liquidity is pre-funded. MockTBill growth comes from explicit testnet donations, not fictitious unbacked yield.
- Reject feed decimals above 36, nonpositive/unnormalizable prices, and zero/future timestamps through existing frozen errors. Saturate remaining limits at zero after cap reductions.
- Direct deployments use ordinary `new`, not proxies. No ABI changes or upgrade controls.
- Real Atlas relay polling and hosting remain separate follow-up work; obtain and label the initial source of any smoke-test oracle price.

### Task 1: Reproducible toolchain and executable failing contract tests

**Files:** `contracts/foundry.toml`, `contracts/remappings.txt`, pinned dependencies, `contracts/test/LeashVault.t.sol`, `contracts/test/helpers/`.
**Interfaces:** Consumes frozen ILeashVault/Factory/IPriceFeed/IFaucetToken; produces behavioral tests and test fixtures for Task 2.

- [x] Install verified official Foundry binaries locally and pin dependencies; configure solc 0.8.28, Paris EVM and 256 fuzz runs.
- [x] Write the required tests named in `docs/vault-abi.md` plus the five review-focus cases. Use a deployable ABI-complete scaffold that fails behavior assertions, then remove all unimplemented branches as Task 2 lands.
- [x] Run `forge test --root contracts`; expected: behavioral failures proving the missing implementation, not missing imports/compiler errors.
- [x] Record RED evidence locally, then commit toolchain, tests and working core together (approved execution ruling: avoid a deliberately broken commit).

### Task 2: Vault, factory and testnet dependencies

**Files:** `contracts/src/LeashVault.sol`, `LeashVaultFactory.sol`, `AtlasRelayFeed.sol`, `mocks/MockToken.sol`, `mocks/MockDEX.sol`, `mocks/MockTBill.sol`, `interfaces/ILeashDEX.sol`, contract tests, `.github/workflows/ci.yml`.
**Interfaces:** Implements all four frozen interfaces. Internal DEX adapter is `swap(address tokenIn,address tokenOut,uint256 amountIn) returns(uint256)`; tokens move from/to msg.sender. Relay constructor takes reporter and feed decimals; reporter alone calls `update(int256 answer,uint256 updatedAt)`.

- [x] Implement fixtures and the factory, then owner controls, accounting/payment checks, oracle validation, swaps and treasury actions, following failing tests in that order.
- [x] Assert exact event payloads, error precedence, cross-token budget accounting, same-plan retries, first-payment cooldown, bucket boundaries, owner recovery and revoked-agent access.
- [x] Fuzz amount boundaries and repeated payment budgets; adversarial DEX/token tests assert rollback, real balance deltas and reentrancy protection.
- [x] Run `forge test --root contracts`; expected: all tests pass. Run formatting and build-size checks.
- [x] Run the existing ABI checker for vault, factory, relay and faucet; expected: all frozen signatures present. Wire the same checks into CI.
- [x] Commit implementation/tests and obtain an independent review; fix material findings with failing regression tests before the next task.

### Task 3: Testnet deployment and sponsored payment evidence

**Files:** `contracts/script/DeployTestnet.s.sol`, `scripts/testnet.py`, `scripts/check-testnet.py`, `scripts/verify-testnet.py`, `contracts/deployments/97.json`, `contracts/README.md`, local `.setup/` evidence; update root docs' implementation status.
**Interfaces:** Produces `FACTORY_ADDRESS`, compiled ABI artifacts and public deployment metadata consumed by Builder B. Uses private MegaFuel policy UUID from `.env` and documented testnet API.

- [x] Simulate deployment and smoke scenario locally; expected: factory creates the owner vault, funding and allowlist succeed, then exactly one payment transfers the expected mock tokens.
- [x] Verify chain ID, funded account and unchanged local key/address mapping; deploy only after tests and review pass, saving receipts before retries.
- [x] Record public addresses and set both factory variables locally. BscScan submission was blocked before execution by automatic approval review; publication awaits explicit user approval.
- [x] Send a sponsored agent payment using the official MegaFuel testnet procedure. Confirm receipt, recipient balance delta, Paid event and sponsorship evidence; do not call ordinary paid gas a sponsored success.
- [x] Check duplicate-ref and unauthorized-recipient refusals through read-only simulation. Save reproducible instructions and testnet-only limitations.
- [x] Run the final full suite, frozen ABI and diff checks; commit source/docs only, leaving secrets and broadcast journals ignored.

## Progress

Implementation started from commit `750eb57`. Core commit `bd2ea36` and review-fix/deployment tooling commit `79d227b` are on `a/vault-core`.

56 tests pass, including two 256-case fuzz properties. All 64 frozen signatures are unchanged. Seven contracts plus a factory-created demo vault are deployed on chain 97. The sponsored 1 mock USDT payment is recorded in `contracts/deployments/97-smoke.json`; receipt and refusal checks are in `97-checks.json`.

Pending external step: publish and verify the eight contract sources on BscScan after explicit authorization. The local verification command is ready; automatic approval review rejected its first invocation before it ran. Continuous relay hosting and LLM/UI integration remain later roadmap work.

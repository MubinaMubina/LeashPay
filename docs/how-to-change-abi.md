# How to change the frozen ABI

You'll make an agreed change to the vault interface without breaking the other builder. At the end, the interface, the frozen signature list and the docs all describe the same thing, and both builders have approved it.

## Prerequisites

- **Agreement first.** Builder A (contracts) and Builder B (agent and web app) both agree on the change before anyone edits code. Adding a function or error is safe for existing callers. Renaming, retyping or removing something breaks the other builder's code.
- Node.js 18 or newer, with `npx` (used to run solc-js without installing it).
- A clean checkout of `main`.

## Steps

1. Create a branch from `main`:

   ```bash
   git checkout main
   git pull
   git checkout -b shared/abi-<short-description>
   ```

2. Edit the interface in [`contracts/src/interfaces/`](../contracts/src/interfaces/), including its NatSpec comments.

3. Compile all four interfaces with solc-js:

   ```bash
   npx --yes -p solc@0.8.28 solcjs --abi --base-path . -o /tmp/leashpay-abi contracts/src/interfaces/*.sol
   ```

   A compile error stops here; fix it before continuing.

4. Regenerate the frozen signature list:

   ```bash
   A=/tmp/leashpay-abi/contracts_src_interfaces_
   node scripts/abi-signatures.mjs \
     ILeashVault=${A}ILeashVault_sol_ILeashVault.abi \
     ILeashVaultFactory=${A}ILeashVaultFactory_sol_ILeashVaultFactory.abi \
     IPriceFeed=${A}IPriceFeed_sol_IPriceFeed.abi \
     IFaucetToken=${A}IFaucetToken_sol_IFaucetToken.abi \
     > contracts/abi/frozen-signatures.txt
   ```

   The counts print on the terminal, for example `ILeashVault: 24 functions, 12 events, 20 errors`.

5. Update [vault-abi.md](vault-abi.md): the affected tables, the counts in "At a glance", and a new line in its Changelog. If the change alters a design decision, update [vault-design.md](vault-design.md) too.

6. Commit, push, and open a pull request into `main`. Both builders approve it, then squash-merge.

7. After the merge:
   - Builder A runs [the check](how-to-check-abi.md) against the implementation and fixes any `MISSING` lines.
   - Builder B regenerates the agent's and web app's TypeScript ABI from the new build.

## Verification

The diff of the frozen list shows exactly the lines you meant to change, and nothing else:

```bash
git diff contracts/abi/frozen-signatures.txt
```

A rename shows as one removed line and one added line. Any other changed line means something else moved; find out why before opening the PR.

## Troubleshooting

**`Error reading contracts/src/interfaces/ILeashVault.sol: Error: ENOENT: no such file or directory`**
You ran the command from another folder (for example `contracts/`). Go back to the repository root and run it again. Your shell may instead report that `contracts/src/interfaces/*.sol` matched no files; the fix is the same.

**The counts didn't change after your edit**
You edited a different file, or compiled into a different directory from the one step 4 reads. Delete `/tmp/leashpay-abi` and run steps 3 and 4 again.

**`frozen-signatures.txt` became empty**
Step 4 failed after the shell had already emptied the file through `>`. Read the error on the terminal (usually a wrong path), fix it and run step 4 again; git still has the previous version if you need it (`git checkout -- contracts/abi/frozen-signatures.txt`).

## Related

- [ABI reference](vault-abi.md)
- [How to check a contract against the frozen ABI](how-to-check-abi.md)
- [Why the vault looks the way it does](vault-design.md)

# How to check a contract against the frozen ABI

You'll confirm that a compiled contract contains every frozen function, event and error, with identical types, return types and `indexed` flags. If it passes, the agent and the web app can talk to it without changes.

## Prerequisites

- Node.js 18 or newer. The checker, [`scripts/abi-signatures.mjs`](../scripts/abi-signatures.mjs), uses only built-in modules, so there is nothing to install.
- A compiled ABI of the contract you want to check. Either:
  - a Foundry artifact, such as `contracts/out/LeashVault.sol/LeashVault.json` (the checker reads its `abi` field), or
  - a bare ABI array from `solc --abi` or `solcjs --abi`.
- Commands run from the repository root.

## Steps

1. Build the contracts. In Foundry, from `contracts/`:

   ```bash
   forge build
   ```

   With the default Foundry layout, the artifact for `src/LeashVault.sol` lands at `out/LeashVault.sol/LeashVault.json`.

2. Run the check from the repository root, pairing each frozen section with the artifact that implements it:

   ```bash
   node scripts/abi-signatures.mjs --check contracts/abi/frozen-signatures.txt \
     ILeashVault=contracts/out/LeashVault.sol/LeashVault.json \
     ILeashVaultFactory=contracts/out/LeashVaultFactory.sol/LeashVaultFactory.json
   ```

   Expected output:

   ```
   OK ILeashVault: all 56 frozen signatures present
   OK ILeashVaultFactory: all 5 frozen signatures present
   ```

   The other two sections work the same way: `IPriceFeed=<relay artifact>` and `IFaucetToken=<mock token artifact>`. Sections you don't name are skipped.

3. Extra functions in your contract are fine. The check only asks that nothing frozen is missing or changed.

## Verification

The command exits with code `0` and prints one `OK` line per section:

```bash
echo $?   # 0 = matches the freeze, 1 = something is missing or changed, 2 = usage or file error
```

You can try the checker before any implementation exists by checking the interfaces against themselves:

```bash
npx --yes -p solc@0.8.28 solcjs --abi --base-path . -o /tmp/leashpay-abi contracts/src/interfaces/*.sol
node scripts/abi-signatures.mjs --check contracts/abi/frozen-signatures.txt \
  ILeashVault=/tmp/leashpay-abi/contracts_src_interfaces_ILeashVault_sol_ILeashVault.abi \
  ILeashVaultFactory=/tmp/leashpay-abi/contracts_src_interfaces_ILeashVaultFactory_sol_ILeashVaultFactory.abi
```

## Troubleshooting

**`MISSING in ILeashVault (...): <signature>`**
Your contract lacks that exact signature. Common causes:

| Missing line looks like | Cause | Fix |
|---|---|---|
| `function rules() view returns ((uint256,uint256,uint256,uint256,uint256,uint256))` | `rules` is a `public` struct variable; its auto-getter returns six separate values, not one struct | Write an explicit `function rules() external view returns (Rules memory)` |
| `function tbill() view returns (address)` | `tbill` is declared as `IERC4626 public` | Declare it as `address public immutable tbill` |
| `event Paid(address indexed,address indexed,uint256,bytes32 indexed)` | An `indexed` keyword was dropped or added | Match the interface exactly |
| `function pay(address,address,uint256,bytes32) nonpayable` | A parameter type changed (for example `uint128` instead of `uint256`) | Match the interface types |
| `error VaultPaused()` | The contract reverts with another error, such as OpenZeppelin's `EnforcedPause()` | Use the interface's own errors |

If you inherit the interface (`contract LeashVault is ILeashVault`), the compiler already enforces the functions. The check still catches events, errors and `indexed` flags, which inheritance does not enforce.

**`section "X" not found in contracts/abi/frozen-signatures.txt`**
The name before `=` must match a `# ` heading in the frozen file exactly: `ILeashVault`, `ILeashVaultFactory`, `IPriceFeed` or `IFaucetToken`.

**`<path>: file not found`**
The artifact doesn't exist yet or the path is wrong. Run `forge build` first and check the path under `contracts/out/`.

**`<path>: not a JSON ABI (pass the compiled .json or .abi file, not the .sol source)`**
You pointed at a source file. Point at the compiled `.json` artifact under `out/` (or a `.abi` file from solc-js).

**`<path>: no ABI array found`**
The file is JSON but holds no ABI, for example a build-info file. Use the per-contract artifact `out/<File>.sol/<Contract>.json`.

**`expected Section=path, got "..."`**
Each argument after the frozen file must be `Section=path` with no spaces around `=`.

## Related

- [ABI reference](vault-abi.md)
- [How to change the frozen ABI](how-to-change-abi.md)
- [Why the vault looks the way it does](vault-design.md)

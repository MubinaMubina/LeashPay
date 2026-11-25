// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILeashVault as IV} from "../src/interfaces/ILeashVault.sol";
import {ILeashVaultFactory as IF} from "../src/interfaces/ILeashVaultFactory.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashVaultFactory} from "../src/LeashVaultFactory.sol";
import {TestToken, TestFeed, TestTBill, TestDex} from "./helpers/Fixtures.sol";

contract LeashVaultTest is Test {
    TestToken internal usdt;
    TestToken internal usdc;
    TestFeed internal feedT;
    TestFeed internal feedC;
    TestTBill internal bill;
    TestDex internal dex;
    LeashVault internal vault;
    LeashVaultFactory internal factory;
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E17);
    address internal constant LINH = address(0x1111);
    address internal constant MARCO = address(0x2222);
    bytes32 internal constant REF = keccak256("payroll-1");

    function baseRules() internal pure returns (IV.Rules memory) {
        return IV.Rules(500e18, 1000e18, 60, 200, 1000e18, 0.98e18);
    }

    function config() internal view returns (IF.Config memory) {
        return IF.Config(
            address(usdt), address(usdc), address(feedT), address(feedC), 3600, address(bill), address(dex), AGENT
        );
    }

    function setUp() public {
        vm.warp(100 days + 1 hours);
        usdt = new TestToken();
        usdc = new TestToken();
        feedT = new TestFeed();
        feedC = new TestFeed();
        bill = new TestTBill(IERC20(address(usdt)));
        dex = new TestDex();
        factory = new LeashVaultFactory(config());
        vm.prank(OWNER);
        vault = LeashVault(factory.createVault(baseRules()));
    }

    function ready() internal {
        vm.startPrank(OWNER);
        vault.setRecipient(LINH, true, 700e18);
        vault.setRecipient(MARCO, true, 700e18);
        vm.stopPrank();
        usdt.mint(address(vault), 10_000e18);
        usdc.mint(address(vault), 10_000e18);
        usdt.mint(address(dex), 10_000e18);
        usdc.mint(address(dex), 10_000e18);
    }

    function pay(address to, address token, uint256 amount, bytes32 ref) internal {
        vm.prank(AGENT);
        vault.pay(to, token, amount, ref);
    }

    function ownerRules(IV.Rules memory r) internal {
        vm.prank(OWNER);
        vault.setRules(r);
    }

    function refresh() internal {
        feedT.set(1e8, block.timestamp, 8);
        feedC.set(1e8, block.timestamp, 8);
    }

    function expectPay(bytes memory error, address to, address token, uint256 amount, bytes32 ref) internal {
        vm.expectRevert(error);
        pay(to, token, amount, ref);
    }

    function test_factory_wiresOwnerAgentTokensAndConfig() public view {
        assertEq(vault.owner(), OWNER);
        assertEq(vault.agent(), AGENT);
        assertEq(factory.vaultOf(OWNER), address(vault));
        assertTrue(vault.isTokenAllowed(address(usdt)));
        assertTrue(vault.isTokenAllowed(address(usdc)));
        assertEq(factory.config().tbill, address(bill));
        assertEq(vault.rules().cooldown, 60);
        (address f, uint256 age) = vault.priceFeed(address(usdt));
        assertEq(f, address(feedT));
        assertEq(age, 3600);
    }

    function test_factory_secondVaultReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IF.VaultAlreadyExists.selector, OWNER, address(vault)));
        vm.prank(OWNER);
        factory.createVault(baseRules());
    }

    function test_factory_invalidRulesDontReserveOwner() public {
        IV.Rules memory r = baseRules();
        r.dailyCap = 0;
        vm.expectRevert(IV.InvalidRules.selector);
        factory.createVault(r);
        assertEq(factory.vaultOf(address(this)), address(0));
    }

    function test_pay_transfersAndEmitsAndAccounts() public {
        ready();
        vm.expectEmit(true, true, true, true);
        emit IV.Paid(LINH, address(usdt), 300e18, REF);
        pay(LINH, address(usdt), 300e18, REF);
        assertEq(usdt.balanceOf(LINH), 300e18);
        assertEq(vault.spentToday(), 300e18);
        (bool allowed, uint256 cap, uint256 spent, uint256 last) = vault.recipientInfo(LINH);
        assertTrue(allowed);
        assertEq(cap, 700e18);
        assertEq(spent, 300e18);
        assertEq(last, block.timestamp);
    }

    function test_pay_revertsWhenCallerIsNotAgent() public {
        vm.expectRevert(abi.encodeWithSelector(IV.Unauthorized.selector, OWNER));
        vm.prank(OWNER);
        vault.pay(LINH, address(usdt), 0, bytes32(0));
    }

    function test_pay_revertsWhenPaused() public {
        vm.prank(OWNER);
        vault.pause();
        expectPay(abi.encodeWithSelector(IV.VaultPaused.selector), LINH, address(usdt), 0, bytes32(0));
    }

    function test_pay_zeroAmountAndInvalidRefPrecedence() public {
        expectPay(abi.encodeWithSelector(IV.ZeroAmount.selector), LINH, address(0), 0, bytes32(0));
        expectPay(abi.encodeWithSelector(IV.InvalidRef.selector), LINH, address(0), 1, bytes32(0));
    }

    function test_pay_revertsForUnknownRecipient() public {
        expectPay(abi.encodeWithSelector(IV.RecipientNotAllowed.selector, LINH), LINH, address(usdt), 1, REF);
    }

    function test_pay_revertsOnDuplicateRef() public {
        ready();
        pay(LINH, address(usdt), 100e18, REF);
        expectPay(abi.encodeWithSelector(IV.DuplicatePayment.selector, REF, LINH), LINH, address(usdc), 100e18, REF);
        pay(MARCO, address(usdc), 100e18, REF);
        assertEq(usdc.balanceOf(MARCO), 100e18);
    }

    function test_pay_revertsAbovePerPaymentCap() public {
        ready();
        expectPay(
            abi.encodeWithSelector(IV.ExceedsPaymentCap.selector, 501e18, 500e18), LINH, address(usdt), 501e18, REF
        );
    }

    function test_pay_cooldownBlocksSameRecipient() public {
        ready();
        pay(LINH, address(usdt), 1e18, REF);
        vm.warp(block.timestamp + 59);
        expectPay(
            abi.encodeWithSelector(IV.CooldownActive.selector, LINH, 100 days + 1 hours + 60),
            LINH,
            address(usdt),
            1e18,
            bytes32(uint256(2))
        );
        vm.warp(block.timestamp + 1);
        pay(LINH, address(usdt), 1e18, bytes32(uint256(2)));
    }

    function test_pay_cooldownAllowsOtherRecipients() public {
        ready();
        pay(LINH, address(usdt), 300e18, REF);
        pay(MARCO, address(usdt), 450e18, REF);
        assertEq(vault.spentToday(), 750e18);
    }

    function test_pay_firstPaymentIgnoresLongCooldown() public {
        ready();
        IV.Rules memory r = baseRules();
        r.cooldown = type(uint256).max;
        ownerRules(r);
        pay(LINH, address(usdt), 1e18, REF);
        assertEq(usdt.balanceOf(LINH), 1e18);
    }

    function test_pay_revertsAboveDailyCap() public {
        ready();
        pay(LINH, address(usdt), 500e18, REF);
        pay(MARCO, address(usdc), 500e18, REF);
        vm.warp(block.timestamp + 60);
        expectPay(
            abi.encodeWithSelector(IV.ExceedsDailyCap.selector, 1, 0), LINH, address(usdt), 1, bytes32(uint256(2))
        );
    }

    function test_pay_dailyCapResetsNextUtcDay() public {
        ready();
        pay(LINH, address(usdt), 500e18, REF);
        pay(MARCO, address(usdt), 500e18, REF);
        vm.warp(101 days);
        refresh();
        assertEq(vault.spentToday(), 0);
        pay(LINH, address(usdt), 200e18, bytes32(uint256(2)));
        assertEq(vault.spentToday(), 200e18);
    }

    function test_pay_revertsAboveMonthlyCap() public {
        ready();
        pay(LINH, address(usdt), 500e18, REF);
        vm.warp(block.timestamp + 60);
        expectPay(
            abi.encodeWithSelector(IV.ExceedsMonthlyCap.selector, LINH, 201e18, 200e18),
            LINH,
            address(usdc),
            201e18,
            bytes32(uint256(2))
        );
    }

    function test_pay_monthlyCapResetsNextBucket() public {
        ready();
        pay(LINH, address(usdt), 500e18, REF);
        vm.warp(120 days);
        refresh();
        (,, uint256 spent,) = vault.recipientInfo(LINH);
        assertEq(spent, 0);
        pay(LINH, address(usdt), 500e18, bytes32(uint256(2)));
    }

    function test_capsLoweredAndRecipientReaddedKeepSpending() public {
        ready();
        pay(LINH, address(usdt), 300e18, REF);
        vm.warp(block.timestamp + 60);
        vm.startPrank(OWNER);
        vault.setRecipient(LINH, false, 0);
        vault.setRecipient(LINH, true, 100e18);
        vm.stopPrank();
        expectPay(
            abi.encodeWithSelector(IV.ExceedsMonthlyCap.selector, LINH, 1, 0),
            LINH,
            address(usdt),
            1,
            bytes32(uint256(2))
        );
        IV.Rules memory r = baseRules();
        r.dailyCap = 100e18;
        r.perPaymentCap = 100e18;
        ownerRules(r);
        expectPay(abi.encodeWithSelector(IV.ExceedsDailyCap.selector, 1, 0), MARCO, address(usdt), 1, REF);
    }

    function test_pay_revertsBelowPriceFloor() public {
        ready();
        feedT.set(97e6, block.timestamp, 8);
        expectPay(
            abi.encodeWithSelector(IV.PriceBelowFloor.selector, address(usdt), 0.97e18, 0.98e18),
            LINH,
            address(usdt),
            1e18,
            REF
        );
    }

    function test_pay_floorZeroSkipsOracle() public {
        ready();
        feedT.set(0, 0, 8);
        IV.Rules memory r = baseRules();
        r.minTokenPrice = 0;
        ownerRules(r);
        pay(LINH, address(usdt), 1e18, REF);
        assertEq(usdt.balanceOf(LINH), 1e18);
    }

    function test_pay_revertsForOtherToken() public {
        expectPay(abi.encodeWithSelector(IV.TokenNotAllowed.selector, address(123)), LINH, address(123), 1, REF);
    }

    function test_pay_disabledTokenAndInsufficientBalance() public {
        vm.startPrank(OWNER);
        vault.setRecipient(LINH, true, 1e18);
        vault.setTokenAllowed(address(usdt), false);
        vm.stopPrank();
        expectPay(abi.encodeWithSelector(IV.TokenNotAllowed.selector, address(usdt)), LINH, address(usdt), 1, REF);
        vm.prank(OWNER);
        vault.setTokenAllowed(address(usdt), true);
        expectPay(
            abi.encodeWithSelector(IV.InsufficientBalance.selector, address(usdt), 0, 1), LINH, address(usdt), 1, REF
        );
    }

    function test_failedTransferRollsBackRefAndBudgets() public {
        ready();
        usdt.setFail(true);
        expectPay(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdt)),
            LINH,
            address(usdt),
            100e18,
            REF
        );
        assertEq(vault.spentToday(), 0);
        usdt.setFail(false);
        pay(LINH, address(usdt), 100e18, REF);
    }

    function test_setTokenAllowed_rejectsOtherToken() public {
        vm.expectRevert(abi.encodeWithSelector(IV.TokenNotAllowed.selector, address(123)));
        vm.prank(OWNER);
        vault.setTokenAllowed(address(123), true);
    }

    function test_setRules_rejectsInconsistentRules() public {
        for (uint256 i; i < 4; i++) {
            IV.Rules memory r = baseRules();
            if (i == 0) r.dailyCap = 0;
            if (i == 1) r.perPaymentCap = 1001e18;
            if (i == 2) r.maxSlippageBps = 201;
            if (i == 3) r.minTokenPrice = 1e18 + 1;
            vm.expectRevert(IV.InvalidRules.selector);
            ownerRules(r);
        }
    }

    function test_setAgent_zeroRevokesOldAgent() public {
        vm.prank(OWNER);
        vault.setAgent(address(0));
        expectPay(abi.encodeWithSelector(IV.Unauthorized.selector, AGENT), LINH, address(usdt), 1, REF);
    }

    function test_ownerFunctions_rejectOtherCallers() public {
        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeCall(IV.setRules, (baseRules()));
        calls[1] = abi.encodeCall(IV.setRecipient, (LINH, true, 1e18));
        calls[2] = abi.encodeCall(IV.setTokenAllowed, (address(usdt), false));
        calls[3] = abi.encodeCall(IV.setPriceFeed, (address(usdt), address(feedT), 3600));
        calls[4] = abi.encodeCall(IV.setAgent, (OWNER));
        calls[5] = abi.encodeCall(IV.pause, ());
        calls[6] = abi.encodeCall(IV.unpause, ());
        calls[7] = abi.encodeCall(IV.withdraw, (address(usdt), 1, AGENT));
        for (uint256 i; i < calls.length; i++) {
            vm.prank(AGENT);
            (bool ok, bytes memory result) = address(vault).call(calls[i]);
            assertFalse(ok);
            assertEq(result, abi.encodeWithSelector(IV.Unauthorized.selector, AGENT));
        }
    }

    function test_ownerInputValidation() public {
        vm.startPrank(OWNER);
        vm.expectRevert(IV.ZeroAddress.selector);
        vault.setRecipient(address(0), true, 1);
        vm.expectRevert(IV.ZeroAddress.selector);
        vault.setPriceFeed(address(usdt), address(0), 1);
        vm.expectRevert(IV.ZeroAmount.selector);
        vault.setPriceFeed(address(usdt), address(feedT), 0);
        vm.expectRevert(IV.ZeroAddress.selector);
        vault.withdraw(address(usdt), 1, address(0));
        vm.expectRevert(IV.ZeroAmount.selector);
        vault.withdraw(address(usdt), 0, OWNER);
        vm.stopPrank();
    }

    function test_withdraw_worksWhilePaused() public {
        ready();
        vm.startPrank(OWNER);
        vault.pause();
        vault.pause();
        vault.withdraw(address(usdt), 10e18, OWNER);
        vault.unpause();
        vault.unpause();
        vm.stopPrank();
        assertEq(usdt.balanceOf(OWNER), 10e18);
        assertFalse(vault.paused());
    }

    function test_swap_revertsOnStalePrice() public {
        ready();
        feedT.set(1e8, block.timestamp - 3601, 8);
        vm.expectRevert(abi.encodeWithSelector(IV.StalePrice.selector, address(usdt), block.timestamp - 3601, 3600));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), 100e18);
    }

    function test_swap_revertsOnNonPositivePrice() public {
        ready();
        feedT.set(-1, block.timestamp, 8);
        vm.expectRevert(abi.encodeWithSelector(IV.InvalidPrice.selector, address(usdt), int256(-1)));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), 100e18);
    }

    function test_swap_revertsWithoutFeed() public {
        vm.expectRevert(abi.encodeWithSelector(IV.PriceFeedNotSet.selector, address(123)));
        vault.getPrice(address(123));
    }

    function test_oracle_normalizesAndRejectsMalformedValues() public {
        feedT.set(123456789, block.timestamp, 8);
        (uint256 p,) = vault.getPrice(address(usdt));
        assertEq(p, 1.23456789e18);
        feedT.set(1e20, block.timestamp, 20);
        (p,) = vault.getPrice(address(usdt));
        assertEq(p, 1e18);
        feedT.set(1, block.timestamp, 36);
        vm.expectRevert(abi.encodeWithSelector(IV.InvalidPrice.selector, address(usdt), int256(1)));
        vault.getPrice(address(usdt));
        feedT.set(1, block.timestamp, 77);
        vm.expectRevert(abi.encodeWithSelector(IV.InvalidPrice.selector, address(usdt), int256(1)));
        vault.getPrice(address(usdt));
        feedT.set(type(int256).max, block.timestamp, 0);
        vm.expectRevert(abi.encodeWithSelector(IV.InvalidPrice.selector, address(usdt), type(int256).max));
        vault.getPrice(address(usdt));
    }

    function test_oracle_zeroFutureAndBoundaryTimestamps() public {
        feedT.set(1e8, 0, 8);
        vm.expectRevert(abi.encodeWithSelector(IV.StalePrice.selector, address(usdt), 0, 3600));
        vault.getPrice(address(usdt));
        feedT.set(1e8, block.timestamp + 1, 8);
        vm.expectRevert(abi.encodeWithSelector(IV.StalePrice.selector, address(usdt), block.timestamp + 1, 3600));
        vault.getPrice(address(usdt));
        feedT.set(1e8, block.timestamp - 3600, 8);
        (uint256 p,) = vault.getPrice(address(usdt));
        assertEq(p, 1e18);
    }

    function test_swap_revertsOnRiggedDexRate() public {
        ready();
        dex.configure(0.97e18, 999e18, false);
        vm.expectRevert(abi.encodeWithSelector(IV.SlippageTooHigh.selector, 98e18, 97e18));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), 100e18);
        assertEq(vault.swappedToday(), 0);
        assertEq(usdt.balanceOf(address(vault)), 10_000e18);
    }

    function test_swap_leavesZeroAllowance() public {
        ready();
        dex.configure(0.98e18, 999e18, true);
        vm.expectEmit(true, true, false, true);
        emit IV.Swapped(address(usdt), address(usdc), 100e18, 98e18, 98e18);
        vm.prank(AGENT);
        uint256 out = vault.swap(address(usdt), address(usdc), 100e18);
        assertEq(out, 98e18);
        assertEq(usdt.allowance(address(vault), address(dex)), 0);
        assertEq(vault.swappedToday(), 100e18);
    }

    function test_swap_revertsAboveDailySwapCap() public {
        ready();
        vm.startPrank(AGENT);
        vault.swap(address(usdt), address(usdc), 1000e18);
        vm.expectRevert(abi.encodeWithSelector(IV.ExceedsSwapCap.selector, 1, 0));
        vault.swap(address(usdc), address(usdt), 1);
        vm.stopPrank();
        vm.warp(101 days);
        refresh();
        assertEq(vault.swappedToday(), 0);
        IV.Rules memory r = baseRules();
        r.dailySwapCap = 0;
        ownerRules(r);
        vm.expectRevert(abi.encodeWithSelector(IV.ExceedsSwapCap.selector, 1, 0));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), 1);
    }

    function test_reentrantAgentCannotPayDuringSwap() public {
        ready();
        vm.prank(OWNER);
        vault.setAgent(address(dex));
        dex.setCallback(address(vault), abi.encodeCall(IV.pay, (LINH, address(usdt), 1e18, REF)));
        vm.prank(OWNER);
        vault.swap(address(usdt), address(usdc), 100e18);
        assertFalse(dex.callbackSucceeded());
        assertEq(dex.callbackResult(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(usdt.balanceOf(LINH), 0);
    }

    function test_tbill_sweepRedeemRoundTripGrowsValue() public {
        ready();
        vm.prank(AGENT);
        uint256 shares = vault.sweepToTBill(100e18);
        assertEq(shares, 100e18);
        assertEq(usdt.allowance(address(vault), address(bill)), 0);
        usdt.mint(address(bill), 10e18);
        assertGt(vault.tbillValue(), 109e18);
        vm.prank(AGENT);
        vault.redeemFromTBill(109e18);
        assertEq(usdt.balanceOf(address(vault)), 10_009e18);
        assertEq(vault.spentToday(), 0);
    }

    function test_tbill_insufficientAssetsAndPausedRecovery() public {
        ready();
        vm.expectRevert(abi.encodeWithSelector(IV.InsufficientBalance.selector, address(bill), 0, 1));
        vm.prank(AGENT);
        vault.redeemFromTBill(1);
        vm.prank(OWNER);
        vault.sweepToTBill(100e18);
        vm.startPrank(OWNER);
        vault.pause();
        vault.withdraw(address(bill), bill.balanceOf(address(vault)), OWNER);
        vm.stopPrank();
        assertEq(bill.balanceOf(OWNER), 100e18);
    }

    function test_tbill_redeemUnlocksPaymentWhenAllUSDTIsInvested() public {
        uint256 amount = 5e18;
        vm.prank(OWNER);
        vault.setRecipient(LINH, true, amount);
        usdt.mint(address(vault), amount);

        vm.prank(AGENT);
        vault.sweepToTBill(amount);
        expectPay(
            abi.encodeWithSelector(IV.InsufficientBalance.selector, address(usdt), 0, amount),
            LINH,
            address(usdt),
            amount,
            REF
        );
        assertEq(vault.spentToday(), 0);

        vm.prank(AGENT);
        vault.redeemFromTBill(amount);
        assertEq(bill.balanceOf(address(vault)), 0);
        pay(LINH, address(usdt), amount, REF);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(usdt.balanceOf(LINH), amount);
        assertEq(vault.spentToday(), amount);
    }

    function test_allTreasuryActionsAuthorizeThenPauseThenZero() public {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IV.swap, (address(usdt), address(usdc), 0));
        calls[1] = abi.encodeCall(IV.sweepToTBill, (0));
        calls[2] = abi.encodeCall(IV.redeemFromTBill, (0));
        for (uint256 i; i < 3; i++) {
            (bool ok, bytes memory result) = address(vault).call(calls[i]);
            assertFalse(ok);
            assertEq(result, abi.encodeWithSelector(IV.Unauthorized.selector, address(this)));
            vm.prank(AGENT);
            (ok, result) = address(vault).call(calls[i]);
            assertFalse(ok);
            assertEq(result, abi.encodeWithSelector(IV.ZeroAmount.selector));
        }
        vm.prank(OWNER);
        vault.pause();
        for (uint256 i; i < 3; i++) {
            vm.prank(AGENT);
            (bool ok, bytes memory result) = address(vault).call(calls[i]);
            assertFalse(ok);
            assertEq(result, abi.encodeWithSelector(IV.VaultPaused.selector));
        }
    }

    function testFuzz_paymentAmountEnforcesCapWithoutPartialState(uint256 amount) public {
        ready();
        amount = bound(amount, 1, 1000e18);
        if (amount > 500e18) {
            expectPay(
                abi.encodeWithSelector(IV.ExceedsPaymentCap.selector, amount, 500e18), LINH, address(usdt), amount, REF
            );
            assertEq(vault.spentToday(), 0);
            assertEq(usdt.balanceOf(LINH), 0);
        } else {
            pay(LINH, address(usdt), amount, REF);
            assertEq(usdt.balanceOf(LINH), amount);
            assertEq(vault.spentToday(), amount);
        }
    }

    function test_swapUsesBothPricesAndRejectsDisabledOrIdenticalTokens() public {
        ready();
        feedT.set(1e8, block.timestamp, 8);
        feedC.set(2e8, block.timestamp, 8);
        dex.configure(0.49e18, 0, false);
        vm.prank(OWNER);
        assertEq(vault.swap(address(usdt), address(usdc), 100e18), 49e18);
        vm.expectRevert(abi.encodeWithSelector(IV.TokenNotAllowed.selector, address(usdt)));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdt), 1);
        vm.prank(OWNER);
        vault.setTokenAllowed(address(usdc), false);
        vm.expectRevert(abi.encodeWithSelector(IV.TokenNotAllowed.selector, address(usdc)));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), 1);
    }

    function test_tbillZeroShareDepositRollsBack() public {
        ready();
        usdt.mint(address(bill), 1_000_000e18);
        vm.expectRevert(IV.ZeroAmount.selector);
        vm.prank(AGENT);
        vault.sweepToTBill(1);
        assertEq(usdt.balanceOf(address(vault)), 10_000e18);
        assertEq(usdt.allowance(address(vault), address(bill)), 0);
    }

    function test_factoryRejectsInvalidDependencies() public {
        IF.Config memory c = config();
        c.usdc = c.usdt;
        vm.expectRevert(IV.InvalidRules.selector);
        new LeashVaultFactory(c);
        c = config();
        c.tbill = address(0);
        vm.expectRevert(IV.ZeroAddress.selector);
        new LeashVaultFactory(c);
        c = config();
        c.maxPriceAge = 0;
        vm.expectRevert(IV.ZeroAmount.selector);
        new LeashVaultFactory(c);
    }

    function testFuzz_sequenceNeverExceedsCombinedDailyBudget(uint256 seed) public {
        ready();
        IV.Rules memory r = baseRules();
        r.cooldown = 0;
        ownerRules(r);
        vm.prank(OWNER);
        vault.setRecipient(LINH, true, type(uint256).max);
        uint256 paid;
        for (uint256 i; i < 12; ++i) {
            uint256 amount = uint256(keccak256(abi.encode(seed, i))) % 500e18 + 1;
            address token = i % 2 == 0 ? address(usdt) : address(usdc);
            bytes32 ref = bytes32(i + 1);
            if (amount > 1000e18 - paid) {
                expectPay(
                    abi.encodeWithSelector(IV.ExceedsDailyCap.selector, amount, 1000e18 - paid),
                    LINH,
                    token,
                    amount,
                    ref
                );
            } else {
                pay(LINH, token, amount, ref);
                paid += amount;
            }
            assertEq(vault.spentToday(), paid);
            assertEq(usdt.balanceOf(LINH) + usdc.balanceOf(LINH), paid);
            assertLe(paid, 1000e18);
        }
    }

    function test_tbillRejectsNonzeroShareDepositThatLosesAssets() public {
        ready();
        usdt.mint(address(bill), 10e18);
        vm.expectRevert(abi.encodeWithSelector(IV.SlippageTooHigh.selector, 10_000e18 - 1, 9997.5e18));
        vm.prank(AGENT);
        vault.sweepToTBill(15e18);
        assertEq(usdt.balanceOf(address(vault)), 10_000e18);
        assertEq(bill.balanceOf(address(vault)), 0);
    }

    function test_tbillRejectsRoundedWithdrawalThatDestroysValue() public {
        ready();
        vm.prank(AGENT);
        vault.sweepToTBill(1);
        usdt.mint(address(bill), 9e18);
        vm.expectRevert(abi.encodeWithSelector(IV.SlippageTooHigh.selector, 10004.5e18 - 1, 10_000e18));
        vm.prank(AGENT);
        vault.redeemFromTBill(1);
        assertEq(bill.balanceOf(address(vault)), 1);
        vm.startPrank(OWNER);
        vault.pause();
        vault.withdraw(address(bill), 1, OWNER);
        vm.stopPrank();
        assertEq(bill.balanceOf(OWNER), 1);
    }

    function test_factoryEmitsAllInitialConfigurationEvents() public {
        vm.recordLogs();
        address created = factory.createVault(baseRules());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 5);
        assertEq(logs[0].emitter, created);
        assertEq(logs[0].topics[0], keccak256("RulesUpdated((uint256,uint256,uint256,uint256,uint256,uint256))"));
        assertEq(logs[0].data, abi.encode(baseRules()));
        for (uint256 i = 1; i <= 2; i++) {
            assertEq(logs[i].emitter, created);
            assertEq(logs[i].topics[0], keccak256("PriceFeedUpdated(address,address,uint256)"));
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(i == 1 ? address(usdt) : address(usdc)))));
            assertEq(logs[i].data, abi.encode(i == 1 ? address(feedT) : address(feedC), uint256(3600)));
        }
        assertEq(logs[3].emitter, created);
        assertEq(logs[3].topics[0], keccak256("AgentUpdated(address,address)"));
        assertEq(logs[3].topics[1], bytes32(0));
        assertEq(logs[3].topics[2], bytes32(uint256(uint160(AGENT))));
        assertEq(logs[4].emitter, address(factory));
        assertEq(logs[4].topics[0], keccak256("VaultCreated(address,address,address)"));
        assertEq(logs[4].topics[1], bytes32(uint256(uint160(address(this)))));
        assertEq(logs[4].topics[2], bytes32(uint256(uint160(created))));
        assertEq(logs[4].topics[3], bytes32(uint256(uint160(AGENT))));
    }

    function test_swapHugeUnfundedInputReturnsBalanceError() public {
        IV.Rules memory r = baseRules();
        r.dailySwapCap = type(uint256).max;
        ownerRules(r);
        feedT.set(101e6, block.timestamp, 8);
        vm.expectRevert(abi.encodeWithSelector(IV.InsufficientBalance.selector, address(usdt), 0, type(uint256).max));
        vm.prank(AGENT);
        vault.swap(address(usdt), address(usdc), type(uint256).max);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1271WalletMock} from "@openzeppelin/contracts/mocks/ERC1271WalletMock.sol";
import {SponsoredLeashVaultFactory} from "../src/SponsoredLeashVaultFactory.sol";
import {ILeashVault} from "../src/interfaces/ILeashVault.sol";
import {ILeashVaultFactory} from "../src/interfaces/ILeashVaultFactory.sol";
import {ISponsoredLeashVault as Vault} from "../src/interfaces/ISponsoredLeashVault.sol";
import {ISponsoredLeashVaultFactory as Factory} from "../src/interfaces/ISponsoredLeashVaultFactory.sol";
import {TestToken, TestFeed, TestTBill, TestDex} from "./helpers/Fixtures.sol";

contract SponsoredLeashVaultTest is Test {
    address private constant AGENT = address(0xA6E17);
    address private constant SPONSOR = address(0x5555);
    address private constant TREASURY = address(0x7777);
    address private constant ALICE = address(0x1111);
    address private constant BOB = address(0x2222);
    uint256 private constant OWNER_KEY = 0x012345;
    uint256 private constant FEE = 0.01 ether;
    bytes32 private constant REF = keccak256("payroll");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ACTIVATE_TYPEHASH =
        keccak256("ActivateVault(address owner,bytes32 rulesHash,uint256 deadline)");
    bytes32 private constant ADD_TYPEHASH =
        keccak256("AddRecipient(address recipient,uint256 monthlyCap,uint256 nonce,uint256 deadline)");
    bytes4 private constant BAD_SIGNATURE = bytes4(keccak256("InvalidOwnerSignature()"));
    bytes4 private constant EXPIRED = bytes4(keccak256("AuthorizationExpired(uint256)"));

    Factory private factory;
    TestToken private usdt;
    TestToken private usdc;
    TestFeed private usdtFeed;
    TestTBill private bill;
    ILeashVaultFactory.Config private cfg;
    address private owner;
    uint256 private deadline;

    function setUp() public {
        vm.warp(100 days);
        deadline = block.timestamp + 10 minutes;
        owner = vm.addr(OWNER_KEY);
        usdt = new TestToken();
        usdc = new TestToken();
        usdtFeed = new TestFeed();
        bill = new TestTBill(IERC20(address(usdt)));
        cfg = ILeashVaultFactory.Config(
            address(usdt),
            address(usdc),
            address(usdtFeed),
            address(new TestFeed()),
            3600,
            address(bill),
            address(new TestDex()),
            AGENT
        );
        factory = new SponsoredLeashVaultFactory(cfg, TREASURY);
    }

    function initialRules() private pure returns (ILeashVault.Rules memory) {
        return ILeashVault.Rules(10 ether, 20 ether, 60, 200, 10 ether, 0.98 ether);
    }

    function sign(address verifier, bytes32 structHash) private view returns (bytes memory) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("LeashPay"), keccak256("2"), block.chainid, verifier));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function activation(address verifier, address account) private view returns (bytes memory) {
        return sign(
            verifier, keccak256(abi.encode(ACTIVATE_TYPEHASH, account, keccak256(abi.encode(initialRules())), deadline))
        );
    }

    function addition(address verifier, address recipient, uint256 cap, uint256 nonce)
        private
        view
        returns (bytes memory)
    {
        return sign(verifier, keccak256(abi.encode(ADD_TYPEHASH, recipient, cap, nonce, deadline)));
    }

    function createDirect() private returns (Vault vault) {
        vm.prank(owner);
        return Vault(factory.createVault(initialRules()));
    }

    function allow(Vault vault, address recipient, uint256 cap) private {
        vm.prank(owner);
        vault.setRecipient(recipient, true, cap);
    }

    function pay(Vault vault, address recipient, address token, uint256 amount, bytes32 ref) private {
        vm.prank(AGENT);
        ILeashVault(address(vault)).pay(recipient, token, amount, ref);
    }

    function test_sponsorActivatesAndAddsForZeroNativeBalanceOwner() public {
        vm.deal(owner, 0);
        bytes memory signed = activation(address(factory), owner);
        vm.prank(SPONSOR);
        Vault vault = Vault(factory.createVaultFor(owner, initialRules(), deadline, signed));
        assertEq(factory.vaultOf(owner), address(vault));
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), AGENT);
        assertEq(keccak256(abi.encode(vault.rules())), keccak256(abi.encode(initialRules())));
        assertEq(factory.vaultOf(SPONSOR), address(0));
        bytes memory auth = addition(address(vault), ALICE, 5 ether, 0);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ILeashVault.RecipientUpdated(ALICE, true, 5 ether);
        vm.prank(SPONSOR);
        vault.addRecipientFor(ALICE, 5 ether, 0, deadline, auth);
        (bool allowed, uint256 cap,,) = vault.recipientInfo(ALICE);
        assertTrue(allowed);
        assertEq(cap, 5 ether);
        assertEq(vault.recipientNonce(ALICE), 1);
        assertEq(vault.recipientNonce(BOB), 0);
        assertEq(owner.balance, 0);
        assertEq(usdt.balanceOf(TREASURY), 0);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.Unauthorized.selector, SPONSOR));
        vm.prank(SPONSOR);
        vault.setAgent(SPONSOR);
        vm.expectRevert(abi.encodeWithSelector(ILeashVaultFactory.VaultAlreadyExists.selector, owner, address(vault)));
        factory.createVaultFor(owner, initialRules(), deadline, signed);
        vm.expectRevert(abi.encodeWithSelector(ILeashVaultFactory.VaultAlreadyExists.selector, owner, address(vault)));
        createDirect();
    }

    function test_signaturesBindConfigurationOwnerContractChainAndExpiry() public {
        bytes memory signed = activation(address(factory), owner);
        ILeashVault.Rules memory changed = initialRules();
        changed.cooldown++;
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(owner, changed, deadline, signed);
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(ALICE, initialRules(), deadline, signed);
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(owner, initialRules(), deadline + 1, signed);
        bytes memory wrongVerifier = activation(SPONSOR, owner);
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(owner, initialRules(), deadline, wrongVerifier);
        assertEq(factory.vaultOf(owner), address(0));

        uint256 originalChain = block.chainid;
        vm.chainId(originalChain + 1);
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(owner, initialRules(), deadline, signed);
        vm.chainId(originalChain);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, deadline));
        factory.createVaultFor(owner, initialRules(), deadline, signed);
    }

    function test_signedInvalidRulesAndEmptySignaturesCannotReserveAnOwner() public {
        vm.expectRevert(ILeashVault.ZeroAddress.selector);
        factory.createVaultFor(address(0), initialRules(), deadline, "");
        vm.expectRevert(BAD_SIGNATURE);
        factory.createVaultFor(owner, initialRules(), deadline, "");
        ILeashVault.Rules memory rules = initialRules();
        rules.perPaymentCap = rules.dailyCap + 1;
        bytes memory signed = sign(
            address(factory), keccak256(abi.encode(ACTIVATE_TYPEHASH, owner, keccak256(abi.encode(rules)), deadline))
        );
        vm.expectRevert(ILeashVault.InvalidRules.selector);
        factory.createVaultFor(owner, rules, deadline, signed);
        assertEq(factory.vaultOf(owner), address(0));
        bytes memory valid = activation(address(factory), owner);
        vm.warp(deadline);
        Vault vault = Vault(factory.createVaultFor(owner, initialRules(), deadline, valid));
        assertEq(vault.owner(), owner);
    }

    function test_deploymentRequiresAnActualTreasury() public {
        vm.expectRevert(ILeashVault.ZeroAddress.selector);
        new SponsoredLeashVaultFactory(cfg, address(0));
    }

    function test_recipientSignatureBindsVaultAddressCapAndDeadline() public {
        Vault vault = createDirect();
        bytes memory auth = addition(address(vault), ALICE, 5 ether, 0);
        vm.expectRevert(BAD_SIGNATURE);
        vault.addRecipientFor(BOB, 5 ether, 0, deadline, auth);
        vm.expectRevert(BAD_SIGNATURE);
        vault.addRecipientFor(ALICE, 6 ether, 0, deadline, auth);
        vm.expectRevert(BAD_SIGNATURE);
        vault.addRecipientFor(ALICE, 5 ether, 0, deadline + 1, auth);
        bytes memory wrongVerifier = addition(address(factory), ALICE, 5 ether, 0);
        vm.expectRevert(BAD_SIGNATURE);
        vault.addRecipientFor(ALICE, 5 ether, 0, deadline, wrongVerifier);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(EXPIRED, deadline));
        vault.addRecipientFor(ALICE, 5 ether, 0, deadline, auth);
        assertEq(vault.recipientNonce(ALICE), 0);
    }

    function test_ownerChangesInvalidateOutstandingAddsAndPreserveSpentAcrossRemoval() public {
        Vault vault = createDirect();
        bytes memory first = addition(address(vault), ALICE, 5 ether, 0);
        vm.prank(owner);
        vault.setRecipient(ALICE, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Vault.InvalidRecipientNonce.selector, ALICE, 1, 0));
        vault.addRecipientFor(ALICE, 5 ether, 0, deadline, first);
        bytes memory current = addition(address(vault), ALICE, 5 ether, 1);
        vault.addRecipientFor(ALICE, 5 ether, 1, deadline, current);
        vm.expectRevert(abi.encodeWithSelector(Vault.InvalidRecipientNonce.selector, ALICE, 2, 1));
        vault.addRecipientFor(ALICE, 5 ether, 1, deadline, current);

        allow(vault, ALICE, 3 ether);
        bytes memory edit = addition(address(vault), ALICE, 9 ether, 3);
        vm.expectRevert(abi.encodeWithSelector(Vault.RecipientAlreadyAllowed.selector, ALICE));
        vault.addRecipientFor(ALICE, 9 ether, 3, deadline, edit);
        usdt.mint(address(vault), 1.01 ether);
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        vm.prank(owner);
        vault.setRecipient(ALICE, false, 0);
        vm.expectRevert(abi.encodeWithSelector(Vault.InvalidRecipientNonce.selector, ALICE, 4, 3));
        vault.addRecipientFor(ALICE, 9 ether, 3, deadline, edit);
        bytes memory readd = addition(address(vault), ALICE, 3 ether, 4);
        vault.addRecipientFor(ALICE, 3 ether, 4, deadline, readd);
        (bool allowed, uint256 cap, uint256 spent, uint256 lastPaid) = vault.recipientInfo(ALICE);
        assertTrue(allowed);
        assertEq(cap, 3 ether);
        assertEq(spent, 1.01 ether);
        assertEq(lastPaid, block.timestamp);
    }

    function test_ownerCanBeAnERC1271Wallet() public {
        address wallet = address(new ERC1271WalletMock(owner));
        bytes memory signed = activation(address(factory), wallet);
        vm.prank(SPONSOR);
        Vault vault = Vault(factory.createVaultFor(wallet, initialRules(), deadline, signed));
        assertEq(vault.owner(), wallet);
        bytes memory auth = addition(address(vault), BOB, 1 ether, 0);
        vm.prank(SPONSOR);
        vault.addRecipientFor(BOB, 1 ether, 0, deadline, auth);
        (bool allowed,,,) = vault.recipientInfo(BOB);
        assertTrue(allowed);
    }

    function test_advertisesTypedDomainsAndActualPaymentTerms() public {
        Vault vault = createDirect();
        checkDomain(address(factory));
        checkDomain(address(vault));
        (address token, address recipient, uint256 fee) = vault.paymentTerms();
        assertEq(token, address(usdt));
        assertEq(recipient, TREASURY);
        assertEq(fee, FEE);
    }

    function checkDomain(address contractAddress) private view {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifier,,) =
            IERC5267(contractAddress).eip712Domain();
        assertEq(fields, bytes1(0x0f));
        assertEq(name, "LeashPay");
        assertEq(version, "2");
        assertEq(chainId, block.chainid);
        assertEq(verifier, contractAddress);
    }

    function test_paymentChargesOneFeePerSuccessfulRecipientEvenWithSameRef() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 10 ether);
        allow(vault, BOB, 10 ether);
        usdt.mint(address(vault), 1.02 ether);
        usdc.mint(address(vault), 2 ether);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ILeashVault.Paid(ALICE, address(usdt), 1 ether, REF);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Vault.PaymentFeeCharged(ALICE, address(usdt), FEE, REF);
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ILeashVault.Paid(BOB, address(usdc), 2 ether, REF);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Vault.PaymentFeeCharged(BOB, address(usdt), FEE, REF);
        pay(vault, BOB, address(usdc), 2 ether, REF);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.DuplicatePayment.selector, REF, BOB));
        pay(vault, BOB, address(usdt), 1, REF);
        assertEq(usdt.balanceOf(ALICE), 1 ether);
        assertEq(usdc.balanceOf(BOB), 2 ether);
        assertEq(usdt.balanceOf(TREASURY), 0.02 ether);
        assertEq(usdc.balanceOf(TREASURY), 0);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.spentToday(), 3.02 ether);
        (,, uint256 spent,) = vault.recipientInfo(BOB);
        assertEq(spent, 2.01 ether);
    }

    function test_netPlusFeeMustFitAllThreeCaps() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 1 ether);
        allow(vault, BOB, 20 ether);
        usdt.mint(address(vault), 10 ether);
        ILeashVault.Rules memory rules = initialRules();
        rules.perPaymentCap = 1 ether;
        rules.dailyCap = 1.99 ether;
        vm.prank(owner);
        vault.setRules(rules);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.ExceedsPaymentCap.selector, 1.01 ether, 1 ether));
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        rules.perPaymentCap = 1.01 ether;
        vm.prank(owner);
        vault.setRules(rules);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.ExceedsMonthlyCap.selector, ALICE, 1.01 ether, 1 ether));
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        pay(vault, ALICE, address(usdt), 0.99 ether, REF);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.ExceedsDailyCap.selector, 1 ether, 0.99 ether));
        pay(vault, BOB, address(usdt), 0.99 ether, REF);
        assertEq(vault.spentToday(), 1 ether);
        assertEq(usdt.balanceOf(TREASURY), FEE);
    }

    function test_insufficientFeeForEitherTokenPreventsAnyDebit() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 10 ether);
        usdc.mint(address(vault), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.InsufficientBalance.selector, address(usdt), 0, FEE));
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        usdt.mint(address(vault), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(ILeashVault.InsufficientBalance.selector, address(usdt), 1 ether, 1.01 ether)
        );
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        assertEq(usdc.balanceOf(ALICE), 0);
        assertEq(usdt.balanceOf(ALICE), 0);
        assertEq(vault.spentToday(), 0);
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        assertEq(usdt.balanceOf(TREASURY), FEE);
    }

    function test_failedUSDTTransferRollsBackUSDCPayoutAndAllowsRetry() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 10 ether);
        usdt.mint(address(vault), FEE);
        usdc.mint(address(vault), 1 ether);
        usdt.setFail(true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdt)));
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        assertEq(usdc.balanceOf(ALICE), 0);
        assertEq(usdt.balanceOf(TREASURY), 0);
        (,, uint256 spent, uint256 lastPaid) = vault.recipientInfo(ALICE);
        assertEq(spent, 0);
        assertEq(lastPaid, 0);
        assertEq(vault.spentToday(), 0);
        usdt.setFail(false);
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        assertEq(usdc.balanceOf(ALICE), 1 ether);
        assertEq(usdt.balanceOf(TREASURY), FEE);
    }

    function test_feeTokenMustBeEnabledAndMeetPriceFloorEvenForUSDC() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 10 ether);
        usdt.mint(address(vault), FEE);
        usdc.mint(address(vault), 1 ether);
        vm.prank(owner);
        vault.setTokenAllowed(address(usdt), false);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.TokenNotAllowed.selector, address(usdt)));
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        vm.prank(owner);
        vault.setTokenAllowed(address(usdt), true);
        usdtFeed.set(97e6, block.timestamp, 8);
        vm.expectRevert(
            abi.encodeWithSelector(ILeashVault.PriceBelowFloor.selector, address(usdt), 0.97 ether, 0.98 ether)
        );
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        usdtFeed.set(1e8, block.timestamp - 3601, 8);
        vm.expectRevert(
            abi.encodeWithSelector(ILeashVault.StalePrice.selector, address(usdt), block.timestamp - 3601, 3600)
        );
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        assertEq(vault.spentToday(), 0);
    }

    function test_tbillRedemptionFreesUSDTForFeeWithoutChargingSetupOrTreasuryActions() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 3 ether);
        usdt.mint(address(vault), 1 ether);
        usdc.mint(address(vault), 1 ether);
        vm.prank(AGENT);
        vault.sweepToTBill(1 ether);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.InsufficientBalance.selector, address(usdt), 0, FEE));
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        vm.prank(AGENT);
        vault.redeemFromTBill(FEE);
        assertEq(vault.tbillValue(), 0.99 ether);
        assertEq(vault.spentToday(), 0);
        assertEq(usdt.balanceOf(TREASURY), 0);
        pay(vault, ALICE, address(usdc), 1 ether, REF);
        assertEq(usdc.balanceOf(ALICE), 1 ether);
        assertEq(usdt.balanceOf(TREASURY), FEE);
        assertEq(vault.spentToday(), 1.01 ether);
    }

    function test_paymentRequiresActiveAgentAndHonorsCooldownOnBothTokens() public {
        Vault vault = createDirect();
        allow(vault, ALICE, 3 ether);
        usdt.mint(address(vault), 1.02 ether);
        usdc.mint(address(vault), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.Unauthorized.selector, SPONSOR));
        vm.prank(SPONSOR);
        vault.pay(ALICE, address(usdt), 1 ether, REF);
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(ILeashVault.VaultPaused.selector);
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        assertEq(usdt.balanceOf(TREASURY), 0);
        vm.prank(owner);
        vault.unpause();
        pay(vault, ALICE, address(usdt), 1 ether, REF);
        bytes32 second = bytes32(uint256(2));
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.CooldownActive.selector, ALICE, block.timestamp + 60));
        pay(vault, ALICE, address(usdc), 1 ether, second);
        assertEq(usdt.balanceOf(TREASURY), FEE);
        vm.warp(block.timestamp + 60);
        pay(vault, ALICE, address(usdc), 1 ether, second);
        assertEq(usdt.balanceOf(TREASURY), 2 * FEE);
    }

    function testFuzz_feeIsFixedAcrossPayoutAmountsAndTokens(uint256 amount, bool inUSDC) public {
        amount = bound(amount, 1, 10 ether - FEE);
        Vault vault = createDirect();
        allow(vault, BOB, 10 ether);
        TestToken payout = inUSDC ? usdc : usdt;
        payout.mint(address(vault), amount);
        usdt.mint(address(vault), FEE);
        pay(vault, BOB, address(payout), amount, REF);
        assertEq(payout.balanceOf(BOB), amount);
        assertEq(usdt.balanceOf(TREASURY), FEE);
        assertEq(vault.spentToday(), amount + FEE);
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }
}

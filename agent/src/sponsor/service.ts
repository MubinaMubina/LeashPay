import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { DEMO_ATTACK_ADDRESS } from "../config";
import { SponsorError, sponsorTypedData, type SponsorAction, type SponsorExecute, type SponsorTypedData } from "./authorization";
import { SponsorLedger } from "./ledger";

export class SponsorReverted extends SponsorError {
  constructor() { super(409, "The sponsored transaction reverted on-chain. Review and approve a fresh request."); }
}

export interface SponsorChain {
  factory: Address;
  relayer: Address;
  /** Check the live network and factory deployment, then return the latest block timestamp. */
  checkedTime(): Promise<bigint>;
  vaultOf(owner: Address, block?: bigint): Promise<Address | null>;
  recipient(vault: Address, recipient: Address, block?: bigint): Promise<{
    owner: Address; agent: Address; nonce: bigint; allowed: boolean; monthlyCap: bigint;
  }>;
  verify(owner: Address, data: SponsorTypedData, signature: Hex): Promise<boolean>;
  quote(request: SponsorExecute, target: Address): Promise<{ maxCost: bigint; sign(): Promise<Hex> }>;
  discardNonce(): void;
  submit(raw: Hex): Promise<{ hash: Hex; block: bigint }>;
}

interface Scope {
  target: Address;
  vault: Address | null;
  nonce: bigint;
  activeCap: bigint | null;
}

const authorizationTtl = 600n;

export class SponsorshipService {
  private readonly ledger: SponsorLedger;
  private busy = false;

  constructor(private readonly chain: SponsorChain, ledgerPath: string) {
    this.ledger = new SponsorLedger(ledgerPath);
  }

  private async scope(request: SponsorAction, block?: bigint): Promise<Scope> {
    if (request.owner === zeroAddress) throw new SponsorError(400, "The zero address cannot own a vault.");
    const vault = await this.chain.vaultOf(request.owner, block);
    if (request.action === "activate") return { vault, target: this.chain.factory, nonce: 0n, activeCap: null };
    if (!vault) throw new SponsorError(409, "Activate your vault before adding a recipient.");
    const recipient = await this.chain.recipient(vault, request.recipient, block);
    if (!isAddressEqual(recipient.owner, request.owner)) throw new SponsorError(409, "The vault owner does not match this approval.");
    if ([zeroAddress, request.owner, vault, recipient.agent, this.chain.relayer, DEMO_ATTACK_ADDRESS].some(a => isAddressEqual(a, request.recipient))) {
      throw new SponsorError(400, "This address is reserved and cannot become a recipient.");
    }
    return { vault, target: vault, nonce: recipient.nonce, activeCap: recipient.allowed ? recipient.monthlyCap : null };
  }

  async prepare(request: SponsorAction) {
    const now = await this.chain.checkedTime();
    const scope = await this.scope(request);
    if (request.action === "addRecipient" && scope.activeCap !== null && scope.activeCap !== request.monthlyCap) {
      throw new SponsorError(409, "This recipient already has a different monthly cap. Review the existing recipient.");
    }
    const deadline = now + authorizationTtl;
    const typedData = sponsorTypedData(request, scope.target, deadline, scope.nonce);
    return { typedData, deadline, ...(request.action === "addRecipient" ? { nonce: scope.nonce } : {}) };
  }

  async execute(request: SponsorExecute, reserveWallet?: () => () => void): Promise<{ vault: Address; hash?: Hex }> {
    if (this.busy) throw new SponsorError(409, "The sponsor is confirming another transaction. Try again in a moment.");
    this.busy = true;
    let release: (() => void) | undefined;
    try {
      const now = await this.chain.checkedTime();
      if (request.deadline > now + authorizationTtl) throw new SponsorError(409, "This approval's deadline is too far ahead. Prepare a fresh approval.");
      const scope = await this.scope(request);
      const nonce = request.action === "addRecipient" ? request.nonce : 0n;
      const data = sponsorTypedData(request, scope.target, request.deadline, nonce);
      if (!(await this.chain.verify(request.owner, data, request.signature))) {
        throw new SponsorError(403, "The wallet signature does not authorize this action.");
      }
      if (request.action === "activate" && scope.vault) return { vault: scope.vault };
      let slot = [this.chain.factory, request.owner, request.action].join("/");
      let cap: string | null = null;
      if (request.action === "addRecipient") {
        if (scope.activeCap === request.monthlyCap && (scope.nonce === nonce || scope.nonce === nonce + 1n)) return { vault: scope.target };
        if (scope.activeCap !== null || scope.nonce !== nonce) throw new SponsorError(409, "The recipient authorization changed. Review it again.");
        slot += "/" + request.recipient + "/" + nonce;
        cap = String(request.monthlyCap);
      }
      // A retry can reconcile an already completed action after expiry. Every submission needs a live signature.
      if (request.deadline <= now) throw new SponsorError(409, "This approval has expired. Prepare a fresh approval.");
      // Invalid signatures and already-completed actions never occupy the payment executor's signer.
      release = reserveWallet?.();
      let attempt = this.ledger.pending(slot, cap, now, request.deadline);
      if (!attempt) {
        const quote = await this.chain.quote(request, scope.target);
        this.ledger.checkBudget(request.owner, now, quote.maxCost);
        const raw = await quote.sign();
        try {
          attempt = this.ledger.record(request.owner, now, slot, cap, request.deadline, quote.maxCost, raw);
        } catch (err) {
          this.chain.discardNonce(); // the signed transaction was never broadcast
          throw err;
        }
      }
      let receipt;
      try {
        receipt = await this.chain.submit(attempt.raw);
      } catch (err) {
        if (err instanceof SponsorReverted) this.ledger.failed(attempt);
        throw err;
      }
      const confirmed = await this.scope(request, receipt.block);
      if (!confirmed.vault || (request.action === "addRecipient" && (confirmed.activeCap !== request.monthlyCap || confirmed.nonce !== nonce + 1n))) {
        throw new SponsorError(409, "The receipt did not confirm this vault action. Check your vault again.");
      }
      return { vault: confirmed.vault, hash: receipt.hash };
    } finally {
      release?.();
      this.busy = false;
    }
  }
}

import { createHash, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BaseError, formatUnits, keccak256, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { CHAT_MESSAGE_LIMIT, type ChatDecision, type ChatInput } from "./chat";
import type { DeploymentConfig, VaultGateway, VaultSnapshot } from "./chain/gateway";
import { ConfigurationError, DEMO_ATTACK_ADDRESS } from "./config";
import { DEFAULT_THRESHOLD_PERCENT, percent, type DepegDecision, type DepegGuard } from "./depeg/guard";
import { attachLocalAmounts, currenciesFor, type FxService } from "./fx/rates";
import { noteForRecipient, notesForAttack, notesForRun, type Memory } from "./memory/memory";
import { APPROVAL_TTL_MS, approvalMessage, signedByOwner } from "./execution/approval";
import { AgentBusyError, AttackRefusedError, type Executor } from "./execution/executor";
import type { Journal } from "./execution/journal";
import { toJson, type PlanJson } from "./json";
import { buildPlan, isDue, isExecutable, planLimitNotes, type Plan } from "./plan/build";
import { DataFileError, DirectoryRuleError, RecipientEntrySchema, type RecipientDirectory } from "./plan/directory";
import { PlannerError, type PlannerInput } from "./plan/planner";
import type { PlanDraft } from "./plan/schema";
import { AddressSchema } from "./validation";

export interface AppDeps {
  gateway: VaultGateway;
  planner: (input: PlannerInput) => Promise<PlanDraft>;
  chat?: (input: ChatInput) => Promise<ChatDecision>;
  directory: RecipientDirectory;
  journal: Journal;
  executor: Executor;
  /** When set, every route except /health needs `Authorization: Bearer <token>`. */
  apiToken?: string;
  /**
   * Host headers to accept, such as "localhost:8787". Set when the server listens on
   * this machine only, so a web page can't reach it through a DNS name that points here.
   */
  allowedHosts?: string[];
  /** The depeg guard (Cournot). Without it, plans keep the coins they were planned with. */
  depeg?: DepegGuard;
  /** Local-currency amounts (CoinMarketCap). Without it, plans show amounts in dollars only. */
  fx?: FxService;
  /** The agent's memory (Living Brain). Without it, plans recall nothing and nothing is saved. */
  memory?: Memory;
  /** Turns on POST /plans/:id/demo-attack (AGENT_DEMO_ATTACK=1). Off by default: the route answers 404. */
  demoAttack?: boolean;
  now?: () => Date;
  newId?: () => string;
}

/** The caller's request is wrong; the message says how. */
class BadRequestError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadRequestError("The request body is not valid JSON.");
  }
}

/** Validates caller input. Only these failures are the caller's 400; anything else is the server's. */
function input<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError("Invalid request.", z.flattenError(result.error));
  return result.data;
}

/**
 * The depeg guard's sentence on the plan. It becomes part of the text the owner signs, so it
 * carries the reading's time: an old reading is visible before signing.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function depegNote(decision: DepegDecision, plan: Plan): string {
  if (!decision.available) return `Depeg guard: ${decision.reason} The plan keeps its coins; the vault's price floor still applies.`;
  const side = decision.chosenToken === "USDT" ? "above" : "within";
  const read = new Date(decision.fetchedAt);
  const at = `${read.getUTCDate()} ${MONTHS[read.getUTCMonth()]} ${decision.fetchedAt.slice(11, 16)}`;
  const all = plan.payments.filter(isExecutable).every((p) => p.token === decision.chosenToken);
  const coins = all ? `every payment is in ${decision.chosenToken}` : `payments are in ${decision.chosenToken} unless you named another coin`;
  return `Depeg guard: Cournot puts USDC's depeg risk at ${percent(decision.probability)} (reading from ${at} UTC), ${side} your ${decision.threshold}% limit, so ${coins}.`;
}

const OwnerMessage = z.string().trim().min(1).max(CHAT_MESSAGE_LIMIT);
const ChatBody = z.strictObject({
  owner: AddressSchema,
  message: OwnerMessage,
  context: z.array(OwnerMessage).max(6).default([]),
});

const CreatePlanBody = z.object({
  owner: AddressSchema,
  message: OwnerMessage,
  /** The owner's depeg limit in percent: above it, the guard pays in USDT instead of USDC. */
  depegThreshold: z.number().min(0).max(100).optional(),
});

const DirectoryBody = RecipientEntrySchema.extend({
  owner: AddressSchema,
  createOnly: z.boolean().optional(),
  expectedDetails: RecipientEntrySchema.pick({ country: true, currency: true }).strict().optional(),
});

const RenameBody = DirectoryBody.pick({ owner: true, address: true, name: true })
  .extend({ expectedName: RecipientEntrySchema.shape.name }).strict();

/** The owner's signed approval, from GET /plans/:id/approval and the owner's wallet. */
const ExecuteBody = z.object({
  expires: z.iso.datetime(),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "must be a 0x hex signature")
    .transform((value) => value as Hex),
  payEarly: z.boolean().default(false),
});

/** Allowed drift between the server's clock and the one that set `expires`. */
const CLOCK_SKEW_MS = 60_000;

const PREVIEW_UNAVAILABLE =
  "The vault couldn't be asked about these payments just now (the BSC node didn't answer). They are checked again when the plan runs.";

// Hashing both sides gives equal-length inputs, so timingSafeEqual can compare them in constant time.
const digest = (value: string) => createHash("sha256").update(value).digest();

/** The owner's vault, or null when there is none or no factory is configured yet. */
async function findVault(gateway: VaultGateway, owner: Address): Promise<Address | null> {
  try {
    return await gateway.vaultOf(owner);
  } catch (err) {
    if (err instanceof ConfigurationError) return null;
    throw err;
  }
}

/**
 * Simulates every payment of the plan at once, so the owner sees the vault's own
 * verdict on each, then notes when the accepted ones can't all go through
 * together. A node that doesn't answer leaves a warning, never a lost plan.
 */
async function preview(gateway: VaultGateway, vault: Address, snapshot: VaultSnapshot, plan: Plan): Promise<void> {
  let tokens: DeploymentConfig;
  try {
    tokens = await gateway.deployment();
  } catch (err) {
    console.error(`plan ${plan.id}: couldn't read the deployment for previews`, err);
    plan.notes.push(PREVIEW_UNAVAILABLE);
    return;
  }
  await Promise.all(
    plan.payments.filter(isExecutable).map(async (payment) => {
      const step = {
        recipient: payment.recipient,
        token: payment.token === "USDC" ? tokens.usdc : tokens.usdt,
        amount: payment.amount,
        ref: plan.ref,
      };
      try {
        payment.preview = await gateway.previewPay(vault, step, snapshot.agent);
      } catch (err) {
        console.error(`plan ${plan.id}: preview failed for ${payment.recipient}`, err);
        payment.warnings.push(
          "The vault couldn't be asked about this payment just now (the BSC node didn't answer). It is checked again when the plan runs.",
        );
      }
    }),
  );
  plan.notes.push(...planLimitNotes(plan, snapshot));
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const expectedAuth = deps.apiToken ? digest(`Bearer ${deps.apiToken}`) : null;
  const app = new Hono();

  app.use("*", async (c, next) => {
    // DNS rebinding: a page on evil.example whose name points at 127.0.0.1 still sends "Host: evil.example".
    if (deps.allowedHosts && !deps.allowedHosts.includes((c.req.header("host") ?? "").toLowerCase())) {
      return c.json({ error: "This agent only answers requests addressed to this machine." }, 403);
    }
    if (expectedAuth && c.req.path !== "/health" && !timingSafeEqual(digest(c.req.header("authorization") ?? ""), expectedAuth)) {
      return c.json({ error: "Missing or wrong API token." }, 401);
    }
    // Any web page can post text/plain to localhost without asking. A JSON post needs a
    // CORS preflight first, and this server never grants one.
    if (c.req.method === "POST" && !(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "Send the body as JSON, with content-type: application/json." }, 415);
    }
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "The request body is too large." }, 413) }));

  app.get("/health", (c) => c.json({ ok: true, agent: deps.gateway.agentAddress }));

  app.get("/directory", (c) => {
    const owner = input(AddressSchema, c.req.query("owner"));
    return c.json(deps.directory.list(owner));
  });

  app.post("/directory", async (c) => {
    const { owner, createOnly, expectedDetails, ...entry } = input(DirectoryBody, await readJson(c));
    // The server holds a process lock on its data directory. Keep this check and upsert synchronous.
    if (createOnly || expectedDetails) {
      const entries = deps.directory.list(owner);
      const current = entries.find((recipient) => recipient.address === entry.address);
      if (current) {
        if (current.name.toLowerCase() !== entry.name.toLowerCase()) {
          throw new DirectoryRuleError(`This address was already saved as ${current.name}. Review the recipients list.`);
        }
        if (current.country === entry.country && current.currency === entry.currency) return c.json(entries);
        if (!expectedDetails || current.country !== expectedDetails.country || current.currency !== expectedDetails.currency) {
          throw new DirectoryRuleError("Contact details changed. Review the current details before saving.");
        }
        entry.preferredToken = current.preferredToken;
      } else if (expectedDetails) {
        throw new DirectoryRuleError("This contact is no longer in your directory. Review it again.");
      }
    }
    const saved = deps.directory.upsert(owner, entry);
    void deps.memory?.remember(noteForRecipient(owner, entry));
    return c.json(saved, 201);
  });

  app.post("/directory/rename", async (c) => {
    const { owner, address, name, expectedName } = input(RenameBody, await readJson(c));
    // No await between the comparison and the write. A stale tab cannot undo a removal or a newer rename.
    const entries = deps.directory.list(owner);
    const current = entries.find(entry => entry.address === address);
    if (!current) throw new DirectoryRuleError("This recipient is no longer in your directory.");
    if (current.name === name) return c.json(entries);
    if (current.name !== expectedName) throw new DirectoryRuleError("The recipient’s name changed. Reopen the contact to edit the current name.");
    const renamed = { ...current, name };
    const saved = deps.directory.upsert(owner, renamed);
    void deps.memory?.remember(noteForRecipient(owner, renamed));
    return c.json(saved);
  });

  app.post("/directory/remove", async (c) => {
    const { owner, address } = input(DirectoryBody.pick({ owner: true, address: true }), await readJson(c));
    const vault = await deps.gateway.vaultOf(owner);
    if (!vault) return c.json({ error: "This owner has no vault." }, 404);
    if (await deps.gateway.isAllowed(vault, address)) {
      return c.json({ error: "The vault still allows this recipient. Confirm removal in your wallet first." }, 409);
    }
    return c.json(deps.directory.remove(owner, address));
  });

  app.get("/vaults/:owner", async (c) => {
    const owner = input(AddressSchema, c.req.param("owner"));
    const vault = await deps.gateway.vaultOf(owner);
    if (!vault) return c.json({ error: "This owner has no vault yet.", owner }, 404);
    return c.json(toJson(await deps.gateway.snapshot(vault)));
  });

  app.post("/chat", async (c) => {
    const { owner, message, context } = input(ChatBody, await readJson(c));
    if (!deps.chat) throw new ConfigurationError("Chat is unavailable in this agent.");
    let recipientNames: string[] | null = null;
    try {
      recipientNames = deps.directory.list(owner).map(({ name }) => name);
    } catch (err) {
      // Help and balance still work when the directory is unavailable. Its reader reports the failure on its card.
      if (!(err instanceof DataFileError)) throw err;
    }
    return c.json(await deps.chat({ message, context, recipientNames }));
  });

  // Owner's message in, reviewed plan out. Nothing is sent on-chain here: each
  // payment is only simulated against the vault, so the owner sees its verdict.
  app.post("/plans", async (c) => {
    const body = input(CreatePlanBody, await readJson(c));
    // Recalled while the vault is read: memory is only context for Claude, so it never holds up the chain reads.
    const recalling = deps.memory?.recall(body.owner, body.message);
    const vault = await findVault(deps.gateway, body.owner);
    const snapshot = vault ? await deps.gateway.snapshot(vault) : null;
    const directory = deps.directory.list(body.owner);
    const at = now();
    const recalled = recalling ? await recalling : undefined;

    const draft = await deps.planner({
      message: body.message,
      memory: recalled?.available ? recalled.notes.map((n) => n.text) : undefined,
      directory,
      today: at.toISOString().slice(0, 10),
      balances: snapshot
        ? {
            USDT: formatUnits(snapshot.balances.USDT, 18),
            USDC: formatUnits(snapshot.balances.USDC, 18),
            tbill: formatUnits(snapshot.balances.tbillValue, 18),
          }
        : undefined,
    });
    const context = { id: newId(), owner: body.owner, vault, message: body.message, directory, now: at };
    let plan = buildPlan(draft, context);
    // Asked while the depeg guard runs; each quote has both coins, so the guard's choice doesn't matter yet.
    const fxCurrencies = plan.kind === "payment" && deps.fx ? currenciesFor(plan, directory) : [];
    const fxQuotes = fxCurrencies.length > 0 ? deps.fx!.quotes(fxCurrencies) : null;
    // The guard runs only for a plan that can run (a vault) and pays someone, to save Cournot quota.
    // Its coin is applied by building again, so merging lines sees the final coin.
    if (deps.depeg && vault && plan.kind === "payment" && plan.payments.some(isExecutable)) {
      // The slider's precision: 0.01%.
      const threshold = Math.round((body.depegThreshold ?? DEFAULT_THRESHOLD_PERCENT) * 100) / 100;
      const decision = await deps.depeg.decide(threshold);
      if (decision.available) plan = buildPlan(draft, { ...context, coin: decision.chosenToken });
      const note = depegNote(decision, plan);
      plan.depeg = { ...decision, note };
      plan.notes.push(note);
    }
    if (fxQuotes) attachLocalAmounts(plan, directory, await fxQuotes);
    if (recalled) plan.memory = recalled;
    if (vault && snapshot) await preview(deps.gateway, vault, snapshot, plan);

    deps.journal.append({ type: "plan_created", planId: plan.id, plan: toJson(plan) as PlanJson });
    return c.json(toJson(plan), 201);
  });

  app.get("/plans/:id", (c) => {
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    return c.json(toJson({ plan, events: deps.journal.eventsFor(plan.id) }));
  });

  /** Why a plan can't be run at all, if it can't. */
  const notRunnable = (c: Context, plan: Plan) => {
    if (!plan.vault) {
      return c.json({ error: "This plan has no vault: the owner had no vault (or no factory was configured) when it was made." }, 422);
    }
    if (plan.kind !== "payment") return c.json({ error: "This message wasn't a payment request, so there is nothing to run." }, 422);
    return null;
  };

  // The text the owner's wallet signs to run the plan, valid for APPROVAL_TTL_MS and usable once.
  app.get("/plans/:id/approval", (c) => {
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    const refusal = notRunnable(c, plan);
    if (refusal) return refusal;
    const payEarly = c.req.query("payEarly") === "true";
    const expires = new Date(now().getTime() + APPROVAL_TTL_MS).toISOString();
    return c.json({ message: approvalMessage(plan, { expires, payEarly }), expires, payEarly });
  });

  // The owner approved the plan with their wallet: run it. Safe to call again with a
  // fresh approval; payments that went through are never repeated.
  app.post("/plans/:id/execute", async (c) => {
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    const refusal = notRunnable(c, plan);
    if (refusal) return refusal;

    const approval = input(ExecuteBody, await readJson(c));
    const at = now();
    const expires = Date.parse(approval.expires);
    if (expires <= at.getTime()) return c.json({ error: "This approval has expired. Sign the plan again." }, 401);
    if (expires - at.getTime() > APPROVAL_TTL_MS + CLOCK_SKEW_MS) {
      return c.json(
        { error: `An approval can be valid for at most ${APPROVAL_TTL_MS / 60_000} minutes. Get a new one from /approval.` },
        400,
      );
    }
    const message = approvalMessage(plan, approval);
    if (!(await signedByOwner(plan.owner, message, approval.signature))) {
      return c.json({ error: "This approval isn't signed by the plan's owner." }, 401);
    }
    if (!approval.payEarly && !isDue(plan, at)) {
      return c.json(
        { error: `This plan is scheduled for ${plan.scheduledFor} (UTC). Run it on that day, or approve paying early.` },
        409,
      );
    }
    // Each approval runs its plan once, so replaying it later in its window can't push through
    // a payment the vault refused when the owner signed. It is keyed on the signed text, not the
    // signature bytes, so a reshaped signature over the same text is the same approval.
    const approvalId = keccak256(toHex(message));
    if (deps.journal.eventsFor(plan.id).some((e) => e.type === "approval_used" && e.approval === approvalId)) {
      return c.json({ error: "This approval was already used. Sign the plan again to run it again." }, 401);
    }
    deps.journal.append({ type: "approval_used", planId: plan.id, approval: approvalId });

    const results = await deps.executor.execute(plan);
    if (deps.memory) for (const note of notesForRun(plan, results, now())) void deps.memory.remember(note);
    return c.json(toJson({ planId: plan.id, results }));
  });

  // The live demo's attack: a payment the vault must refuse, sent without the owner's
  // signature to play a compromised agent. It can only target DEMO_ATTACK_ADDRESS
  // (see Executor.demoAttack), so it can never move money.
  app.post("/plans/:id/demo-attack", async (c) => {
    if (!deps.demoAttack) return c.json({ error: "Not found." }, 404);
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    const refusal = notRunnable(c, plan);
    if (refusal) return refusal;
    const results = await deps.executor.demoAttack(plan, DEMO_ATTACK_ADDRESS);
    if (deps.memory) for (const note of notesForAttack(plan, results, now())) void deps.memory.remember(note);
    return c.json(toJson({ planId: plan.id, results }));
  });

  app.onError((err, c) => {
    if (err instanceof BadRequestError) {
      return c.json({ error: err.message, ...(err.details === undefined ? {} : { details: err.details }) }, 400);
    }
    if (err instanceof DirectoryRuleError || err instanceof AgentBusyError || err instanceof AttackRefusedError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof ConfigurationError) return c.json({ error: err.message }, 503);
    if (err instanceof PlannerError) return c.json({ error: err.message }, 502);
    if (c.req.path === "/chat" && err instanceof Anthropic.APIConnectionError) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) return c.json({ error: "Claude took too long to answer. Try again." }, 504);
      return c.json({ error: "Could not reach Claude. Try again in a moment." }, 503);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return c.json({ error: "The Claude API key is missing or invalid. Set ANTHROPIC_API_KEY in .env." }, 502);
    }
    if (err instanceof Anthropic.APIError) return c.json({ error: `Claude API error: ${err.message}` }, 502);
    console.error(err);
    // viem's own message can include the RPC URL, and with it a provider key: never send it back.
    if (err instanceof BaseError) return c.json({ error: "The BSC node didn't answer as expected. Try again in a moment." }, 502);
    if (err instanceof DataFileError) return c.json({ error: err.message }, 500);
    return c.json({ error: "Something went wrong in the agent server." }, 500);
  });

  return app;
}

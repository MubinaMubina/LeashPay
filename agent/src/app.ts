import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import type { VaultGateway } from "./chain/gateway";
import { ConfigurationError } from "./config";
import { VaultBusyError, type Executor } from "./execution/executor";
import type { Journal } from "./execution/journal";
import { toJson, type PlanJson } from "./json";
import { buildPlan, isExecutable } from "./plan/build";
import { RecipientEntrySchema, type RecipientDirectory } from "./plan/directory";
import { PlannerError, type PlannerInput } from "./plan/planner";
import type { PlanDraft } from "./plan/schema";

export interface AppDeps {
  gateway: VaultGateway;
  planner: (input: PlannerInput) => Promise<PlanDraft>;
  directory: RecipientDirectory;
  journal: Journal;
  executor: Executor;
  /** When set, every route except /health needs `Authorization: Bearer <token>`. */
  apiToken?: string;
  now?: () => Date;
  newId?: () => string;
}

const AddressParam = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "must be a 0x address")
  .transform((value) => getAddress(value) as Address);

const CreatePlanBody = z.object({
  owner: AddressParam,
  message: z.string().trim().min(1).max(2000),
});

/** The owner's vault, or null when there is none or no factory is configured yet. */
async function findVault(gateway: VaultGateway, owner: Address): Promise<Address | null> {
  try {
    return await gateway.vaultOf(owner);
  } catch (err) {
    if (err instanceof ConfigurationError) return null;
    throw err;
  }
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (deps.apiToken && c.req.path !== "/health" && c.req.header("authorization") !== `Bearer ${deps.apiToken}`) {
      return c.json({ error: "Missing or wrong API token." }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, agent: deps.gateway.agentAddress }));

  app.get("/directory", (c) => c.json(deps.directory.list()));

  app.post("/directory", async (c) => {
    const entry = RecipientEntrySchema.parse(await c.req.json());
    return c.json(deps.directory.upsert(entry), 201);
  });

  app.get("/vaults/:owner", async (c) => {
    const owner = AddressParam.parse(c.req.param("owner"));
    const vault = await deps.gateway.vaultOf(owner);
    if (!vault) return c.json({ error: "This owner has no vault yet.", owner }, 404);
    return c.json(toJson(await deps.gateway.snapshot(vault)));
  });

  // Owner's message in, reviewed plan out. Nothing is sent on-chain here: each
  // payment is only simulated against the vault, so the owner sees its verdict.
  app.post("/plans", async (c) => {
    const body = CreatePlanBody.parse(await c.req.json());
    const vault = await findVault(deps.gateway, body.owner);
    const snapshot = vault ? await deps.gateway.snapshot(vault) : null;
    const directory = deps.directory.list();
    const at = now();

    const draft = await deps.planner({
      message: body.message,
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
    const plan = buildPlan(draft, { id: newId(), owner: body.owner, vault, message: body.message, directory, now: at });

    if (vault) {
      const tokens = await deps.gateway.deployment();
      for (const payment of plan.payments) {
        if (!isExecutable(payment)) continue;
        payment.preview = await deps.gateway.previewPay(vault, {
          recipient: payment.recipient,
          token: payment.token === "USDC" ? tokens.usdc : tokens.usdt,
          amount: payment.amount,
          ref: plan.ref,
        });
      }
    }

    deps.journal.append({ type: "plan_created", planId: plan.id, plan: toJson(plan) as PlanJson });
    return c.json(toJson(plan), 201);
  });

  app.get("/plans/:id", (c) => {
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    return c.json(toJson({ plan, events: deps.journal.eventsFor(plan.id) }));
  });

  // The owner confirmed the plan: run it. Safe to call again; finished payments are not repeated.
  app.post("/plans/:id/execute", async (c) => {
    const plan = deps.journal.plan(c.req.param("id"));
    if (!plan) return c.json({ error: "No plan with that id." }, 404);
    if (!plan.vault) {
      return c.json({ error: "This plan has no vault: the owner had no vault (or no factory was configured) when it was made." }, 422);
    }
    const results = await deps.executor.execute(plan);
    return c.json(toJson({ planId: plan.id, results }));
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request.", details: z.flattenError(err) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "The request body is not valid JSON." }, 400);
    if (err instanceof VaultBusyError) return c.json({ error: err.message }, 409);
    if (err instanceof ConfigurationError) return c.json({ error: err.message }, 503);
    if (err instanceof PlannerError) return c.json({ error: err.message }, 502);
    if (err instanceof Anthropic.AuthenticationError) {
      return c.json({ error: "The Claude API key is missing or invalid. Set ANTHROPIC_API_KEY in .env." }, 502);
    }
    if (err instanceof Anthropic.APIError) return c.json({ error: `Claude API error: ${err.message}` }, 502);
    console.error(err);
    return c.json({ error: "Something went wrong in the agent server." }, 500);
  });

  return app;
}

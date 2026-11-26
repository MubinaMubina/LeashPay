import path from "node:path";
import { describe, expect, it } from "vitest";
import { Journal, type JournalEvent } from "../src/execution/journal";
import type { PlanJson } from "../src/json";
import { buildRunway } from "../src/runway";
import { FakeGateway, LINH, OWNER, STRANGER_ACCOUNT, VAULT, tempDir } from "./fakes";

const now = new Date("2026-12-26T23:59:59Z");
const at = now.toISOString();
const hash = "0x1234";
const pay = (amount: string, token: "USDC" | "USDT" = "USDC") =>
  ({ recipient: LINH, recipientName: "Linh", amount, token, warnings: [] });
function created(planId: string, date: string, payments: PlanJson["payments"] = [pay("3")], extra: Partial<PlanJson> = {}): JournalEvent {
  return { type: "plan_created", planId, at, plan: {
    id: planId, ref: hash, owner: OWNER, vault: VAULT, kind: "payment", scheduledFor: date,
    createdAt: at, message: "", notes: [], payments, ...extra,
  } };
}
const select = (planId: string, included = true): JournalEvent => ({ type: "runway_inclusion", at, planId, included });

async function read(events: JournalEvent[]) {
  const vault = await new FakeGateway().snapshot(VAULT);
  vault.balances = { USDC: 5n, USDT: 10n ** 22n, tbillValue: 10000n };
  return buildRunway(events, OWNER, vault, now);
}

describe("30-day vault runway", () => {
  it("projects each unpaid sponsored fee in USDT and preserves the fee-free legacy debit", async () => {
    const paymentFee = { token: "USDT" as const, amount: String(10n ** 16n), recipient: OWNER };
    const payments = [pay("2"), { ...pay("3", "USDT"), recipient: STRANGER_ACCOUNT.address }];
    const events = [created("sponsored", "2026-12-27", payments, { paymentFee }), select("sponsored"),
      created("legacy", "2026-12-27", [pay("1", "USDT")]), select("legacy")];
    const result = await read(events);
    expect(result.projection?.weeks[0]?.due).toEqual({ USDC: 2n, USDT: 4n + 2n * 10n ** 16n });
    expect(result.plans.find(plan => plan.id === "sponsored")).toMatchObject({ feesUSDT: String(2n * 10n ** 16n) });
    const partial = await read([...events, { type: "step_succeeded", at, planId: "sponsored", index: 0, hash }]);
    expect(partial.projection?.weeks[0]?.due).toEqual({ USDC: 0n, USDT: 4n + 10n ** 16n });
  });

  it("uses 30 UTC calendar dates, including today and a two-day final period; isolates dated plans by owner and vault", async () => {
    const forecast = await read([
      created("today", "2026-12-26"), created("last", "2027-01-24"), created("outside", "2027-01-25"),
      created("other", "2027-01-11", [], { owner: STRANGER_ACCOUNT.address }),
      created("oldVault", "2027-01-11", [pay("1")], { vault: LINH }),
      created("instant", "now"), created("invalid", "2026-12-00"), created("stale", "2026-12-24"),
      created("overdue", "2026-12-25"), select("overdue"),
    ]);
    expect(forecast.plans.map(p => p.id)).toEqual(["overdue", "today", "last"]);
    expect(forecast.projection?.weeks).toHaveLength(5);
    expect(forecast.projection?.weeks[4]).toMatchObject({ from: "2027-01-23", through: "2027-01-24" });
    expect(forecast.projection?.closing.USDC).toBe(2n);
  });

  it("warns one week ahead, dates the first shortfall, and keeps each coin independent down to one base unit", async () => {
    const forecast = await read([created("first", "2026-12-28"), select("first"),
      created("second", "2027-01-03"), select("second"), created("third", "2027-01-24"), select("third")]);
    expect(forecast.projection?.weeks[0]).toMatchObject({ status: "tight", closing: { USDC: 2n } });
    expect(forecast.projection?.firstShortfall).toEqual([{ date: "2027-01-03", amount: 1n, token: "USDC" }]);
    expect(forecast.projection?.closing).toEqual({ USDT: 10n ** 22n, USDC: -4n });
    const exact = await read([created("exact", "2027-01-24", [pay("5")]), select("exact")]);
    expect(exact.projection?.weeks.at(-1)?.status).toBe("tight");
    expect(exact.projection?.firstShortfall).toEqual([]);
  });

  it("excludes drafts, paid rows and invalid rows; includes outstanding failed payments until settled or deselected", async () => {
    const base = [created("batch", "2026-12-27", [pay("3"), pay("2"), { ...pay("40"), recipient: null }]), select("batch"),
      { type: "step_succeeded", at, planId: "batch", index: 0, hash }] satisfies JournalEvent[];
    const pending = { type: "step_sent", at, planId: "batch", index: 1, hash } as const;
    expect((await read([...base, pending])).projection).toBeNull();
    const failed = { type: "step_failed", at, planId: "batch", index: 1, hash, error: "failed" } as const;
    const after = await read([...base, pending, failed]);
    expect(after.projection?.closing.USDC).toBe(3n);
    expect(after.plans[0]?.payments).toHaveLength(1);
    expect((await read([...base, select("batch", false)])).projection?.closing.USDC).toBe(5n);
  });

  it("persists repeated inclusion requests once and restores selections after restart", () => {
    const file = path.join(tempDir(), "journal.jsonl");
    const journal = new Journal(file);
    journal.setRunwayInclusion("plan", false);
    journal.setRunwayInclusion("plan", true);
    journal.setRunwayInclusion("plan", true);
    new Journal(file).setRunwayInclusion("plan", false);
    expect(new Journal(file).eventsFor("plan").map(e => e.type === "runway_inclusion" && e.included)).toEqual([true, false]);
  });

  it("rereads a balance if an included payment settles during the chain read", async () => {
    const journal = new Journal(path.join(tempDir(), "journal.jsonl"));
    journal.append(created("batch", "2026-12-28", [pay("3"), pay("2")]));
    journal.setRunwayInclusion("batch", true);
    let reads = 0;
    const report = await journal.runway(OWNER, async () => {
      const snapshot = await new FakeGateway().snapshot(VAULT);
      if (++reads === 1) journal.append({ type: "step_succeeded", planId: "batch", index: 0, hash });
      snapshot.balances.USDC = reads === 1 ? 5n : 2n;
      return snapshot;
    }, () => now);
    expect(reads).toBe(2);
    expect(report?.projection?.closing.USDC).toBe(0n);
  });
});

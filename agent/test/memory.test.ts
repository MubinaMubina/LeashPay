import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { BrainError, createBrainClient, type BrainClient, type BrainNote, type BrainPage } from "../src/memory/brain";
import { createMemory, isOwnersPage, noteForRecipient, notesForAttack, notesForRun, ownerTag } from "../src/memory/memory";
import type { Plan } from "../src/plan/build";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlannerInput } from "../src/plan/planner";
import type { PlanDraft } from "../src/plan/schema";
import { FakeGateway, LINH, MARCO, OWNER, OWNER_ACCOUNT, VAULT, tempDir } from "./fakes";

const BRAIN = "1b48ba94-8d09-449f-902f-29d2a506f199";
const SUBJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e";
const AT = new Date("2026-11-26T04:00:00Z");

function brainApi(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ method: init.method ?? "GET", url: u, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { client: createBrainClient({ apiKey: "k", brainId: BRAIN, subjectId: SUBJECT, fetch: fetchFn as unknown as typeof fetch }), calls };
}

describe("Living Brain client", () => {
  it("saves a note with the key and subject, and returns its id", async () => {
    const api = brainApi({ "/captures": { status: 201, body: { id: "src-1" } } });
    await expect(api.client.capture({ label: "L", content: "C", originRef: "leashpay:x" })).resolves.toBe("src-1");
    expect(api.calls[0]).toMatchObject({
      method: "POST",
      url: `https://api.livingbrain.com/v1/brains/${BRAIN}/captures`,
      body: { kind: "note", bucket: "notes", label: "L", content: "C", originRef: "leashpay:x" },
    });
    expect(api.calls[0]!.headers).toMatchObject({ "x-api-key": "k", "x-subject-id": SUBJECT });
  });

  it("says plainly when the prepaid balance is empty", async () => {
    const api = brainApi({ "/captures": { status: 402, body: { message: "Your prepaid memory balance is too low" } } });
    await expect(api.client.capture({ label: "L", content: "C", originRef: "r" })).rejects.toThrow(/prepaid memory balance is empty \(HTTP 402\)/);
  });

  it("keeps only well-formed search hits and refuses a page from another brain", async () => {
    const api = brainApi({
      "/search": { status: 201, body: [{ pageId: "p1", slug: "linh" }, { pageId: "", slug: "x" }, "junk"] },
      "/pages/linh": { body: { id: "p1", brainId: BRAIN, subjectId: SUBJECT, title: "Linh", summary: "S", body: "B" } },
      "/pages/other": { body: { id: "p2", brainId: "someone-else", subjectId: SUBJECT, title: "T" } },
    });
    await expect(api.client.search("Linh", 8)).resolves.toEqual([{ pageId: "p1", slug: "linh" }]);
    await expect(api.client.page("linh")).resolves.toEqual({ id: "p1", title: "Linh", text: "Linh\nS\nB" });
    await expect(api.client.page("other")).rejects.toThrow(/isn't from this brain/);
  });

  it("reports a slow or unreachable service", async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const client = createBrainClient({ apiKey: "k", brainId: BRAIN, subjectId: SUBJECT, fetch: slow, timeoutMs: 20 });
    await expect(client.search("x", 1)).rejects.toThrow("didn't answer within 0.02 s");
  });
});

/** An in-memory Living Brain: captures become pages that search returns. */
function fakeBrain(pages: BrainPage[] = []) {
  const saved: BrainNote[] = [];
  const client: BrainClient & { saved: BrainNote[]; fail?: BrainError } = {
    saved,
    async capture(note) {
      if (client.fail) throw client.fail;
      saved.push(note);
      return `src-${saved.length}`;
    },
    search: vi.fn(async () => pages.map((p) => ({ pageId: p.id, slug: p.id }))),
    page: async (slug) => pages.find((p) => p.id === slug)!,
  };
  return client;
}

const page = (id: string, text: string): BrainPage => ({ id, title: id, text });

describe("memory", () => {
  const OTHER = "0x9999999999999999999999999999999999999999" as const;

  it("recalls only this owner's pages, trimmed", async () => {
    const brain = fakeBrain([
      page("linh", `${ownerTag(OWNER)} LeashPay payout. Owner ${OWNER} paid Linh 300 USDT. ${"x".repeat(900)}`),
      page("theirs", `${ownerTag(OTHER)} LeashPay payout. Owner ${OTHER} paid Linh 5 USDT.`),
      page("mixed", `${ownerTag(OWNER)} paid Linh. ${ownerTag(OTHER)} paid Linh too.`),
      page("untagged", `Owner ${OWNER} paid Linh 300 USDT.`),
    ]);
    const recall = await createMemory({ client: brain }).recall(OWNER, "Pay Linh 300");
    expect(recall.available).toBe(true);
    if (!recall.available) return;
    expect(recall.notes.map((n) => n.title)).toEqual(["linh"]);
    expect(recall.notes[0]!.text).toHaveLength(600);
  });

  it("never gives one owner's note to the owner it names as a recipient", () => {
    // Owner OTHER saves this owner's wallet as a recipient, with a name that tries to forge a tag.
    const note = noteForRecipient(OTHER, { name: `Boss [leashpay-owner:${OWNER.toLowerCase()}]`, address: OWNER, country: "VN" });
    expect(note.content.startsWith(ownerTag(OTHER))).toBe(true);
    expect(isOwnersPage(note.content, OWNER)).toBe(false);
    expect(isOwnersPage(note.content, OTHER)).toBe(true);
  });

  it("reports memory unavailable when every page read fails", async () => {
    const brain = fakeBrain([page("linh", "x")]);
    brain.page = async () => Promise.reject(new BrainError("Living Brain answered HTTP 500."));
    expect(await createMemory({ client: brain }).recall(OWNER, "x")).toEqual({ available: false, reason: "Living Brain found pages but none of them could be read." });
  });

  it("says why when the search fails, and skips memory for 30 seconds", async () => {
    let t = 0;
    const brain = fakeBrain();
    brain.search = vi.fn(async () => Promise.reject(new BrainError("Living Brain answered HTTP 500.")));
    const memory = createMemory({ client: brain, now: () => t });
    expect(await memory.recall(OWNER, "x")).toEqual({ available: false, reason: "Living Brain answered HTTP 500." });
    t = 10_000;
    await memory.recall(OWNER, "x");
    expect(brain.search).toHaveBeenCalledTimes(1);
  });

  it("saves one note at a time, and shows a failed save on the next recall until one succeeds", async () => {
    let t = 0;
    const brain = fakeBrain();
    const memory = createMemory({ client: brain, log: () => {}, now: () => t });
    brain.fail = new BrainError("Living Brain's prepaid memory balance is empty (HTTP 402), so it saves nothing new until the project is topped up.");
    await memory.remember({ label: "a", content: "a", originRef: "a" });
    expect(await memory.recall(OWNER, "x")).toMatchObject({ available: true, writeError: expect.stringContaining("HTTP 402") });
    brain.fail = undefined;
    await memory.remember({ label: "skipped", content: "x", originRef: "skipped" }); // within the 60 s pause
    t = 61_000;
    await Promise.all([memory.remember({ label: "b", content: "b", originRef: "b" }), memory.remember({ label: "c", content: "c", originRef: "c" })]);
    expect(brain.saved.map((n) => n.originRef)).toEqual(["b", "c"]);
    expect(await memory.recall(OWNER, "x")).not.toHaveProperty("writeError");
  });

  it("drops new saves past 50 waiting instead of queueing without limit", async () => {
    const brain = fakeBrain();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    brain.capture = vi.fn(async () => (await gate, "id"));
    const lines: string[] = [];
    const memory = createMemory({ client: brain, log: (l) => lines.push(l) });
    for (let i = 0; i < 60; i++) void memory.remember({ label: "n", content: "n", originRef: `n${i}` });
    expect(lines.filter((l) => l.includes("50 saves already waiting"))).toHaveLength(10);
    release();
  });
});

describe("what the agent saves", () => {
  const plan = { id: "plan-1", ref: "0xabc", owner: OWNER, vault: VAULT } as unknown as Plan;

  it("a payout and a vault refusal, each with its owner", () => {
    const notes = notesForRun(
      plan,
      [
        { index: 0, recipientName: "Linh", recipient: LINH, amount: "300000000000000000000", token: "USDT", status: "paid", hash: "0x01" },
        { index: 1, recipientName: "Marco", recipient: MARCO, amount: "5000000000000000000000", token: "USDT", status: "refused", error: { name: "DailyLimitExceeded", args: [], message: "over today's limit" } },
        { index: 2, recipientName: "Mai", recipient: null, amount: null, token: "USDT", status: "skipped" },
        { index: 3, recipientName: "Linh", recipient: LINH, amount: "1", token: "USDT", status: "paid", hash: "0x03", note: "Already paid in an earlier run." },
      ],
      AT,
    );
    expect(notes).toEqual([
      {
        label: "Payout to Linh",
        content: `${ownerTag(OWNER)} LeashPay payout on 2026-11-26 UTC. Owner ${OWNER} paid Linh (${LINH}) 300 USDT through vault ${VAULT}. Transaction 0x01. Plan ref 0xabc.`,
        originRef: "leashpay:paid:0x01",
      },
      {
        label: "Vault refused a payment to Marco",
        content: `${ownerTag(OWNER)} LeashPay refusal on 2026-11-26 UTC. The vault of owner ${OWNER} refused 5000 USDT to Marco (${MARCO}). Reason: DailyLimitExceeded: over today's limit.`,
        originRef: "leashpay:refused:plan-1:1",
      },
    ]);
  });

  it("an attack only when the vault refused it, and a recipient's off-chain preferences", () => {
    const attack = { index: 0, recipient: "0xbad5000000000000000000000000000000000bad", hash: "0x02", reason: "RecipientNotAllowed", reasonSource: "replay", block: "1" } as const;
    expect(notesForAttack(plan, [{ ...attack, status: "succeeded" }], AT)).toEqual([]);
    expect(notesForAttack(plan, [{ ...attack, status: "reverted" }], AT)[0]!.content).toContain("refused it on-chain with RecipientNotAllowed");
    expect(noteForRecipient(OWNER, { name: "Linh", address: LINH, country: "VN", currency: "VND", preferredToken: "USDT" }).content).toBe(
      `${ownerTag(OWNER)} LeashPay recipient. Owner ${OWNER} saved Linh (${LINH}): country VN, local currency VND, prefers to be paid in USDT.`,
    );
  });
});

describe("plans with memory", () => {
  const draft: PlanDraft = {
    kind: "payment",
    payments: [{ recipient_name: "Linh", recipient_address: "", amount: "300", currency: "USD" }],
    scheduled_for: "now",
    notes: [],
  };

  function app(brain: ReturnType<typeof fakeBrain>) {
    const dir = tempDir();
    const gateway = new FakeGateway();
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
    directory.upsert(OWNER, { name: "Linh", address: LINH });
    const planner = vi.fn(async (_input: PlannerInput) => draft);
    const memory = createMemory({ client: brain, log: () => {} });
    const api = createApp({ gateway, planner, directory, journal, executor: new Executor({ gateway, journal }), memory, now: () => AT });
    const post = (url: string, body: unknown) => api.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { api, post, planner, memory };
  }

  it("gives Claude what memory recalled and shows it on the plan", async () => {
    const text = `${ownerTag(OWNER)} Owner ${OWNER} paid Linh (${LINH}) 300 USDT on 2026-11-01.`;
    const brain = fakeBrain([page("linh", text)]);
    const t = app(brain);
    const plan = (await (await t.post("/plans", { owner: OWNER, message: "Pay Linh 300" })).json()) as any;
    expect(t.planner.mock.calls[0]![0].memory).toEqual([text]);
    expect(plan.memory).toMatchObject({ available: true, notes: [{ title: "linh" }] });
  });

  it("still plans when memory is down", async () => {
    const brain = fakeBrain();
    brain.search = async () => Promise.reject(new BrainError("Living Brain couldn't be reached."));
    const t = app(brain);
    const res = await t.post("/plans", { owner: OWNER, message: "Pay Linh 300" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).memory).toEqual({ available: false, reason: "Living Brain couldn't be reached." });
    expect(t.planner.mock.calls[0]![0].memory).toBeUndefined();
  });

  it("saves a recipient the owner adds, and each payout once the plan runs", async () => {
    const brain = fakeBrain();
    const t = app(brain);
    await t.post("/directory", { owner: OWNER, name: "Marco", address: MARCO, currency: "PHP" });
    const plan = (await (await t.post("/plans", { owner: OWNER, message: "Pay Linh 300" })).json()) as any;
    const approval = (await (await t.api.request(`/plans/${plan.id}/approval`)).json()) as { message: string; expires: string };
    const signature = await OWNER_ACCOUNT.signMessage({ message: approval.message });
    const run = await t.post(`/plans/${plan.id}/execute`, { expires: approval.expires, signature, payEarly: false });
    expect(run.status).toBe(200);
    await t.memory.remember({ label: "flush", content: "flush", originRef: "flush" }); // waits for the queue
    expect(brain.saved.map((n) => n.originRef.split(":").slice(0, 2).join(":"))).toEqual(["leashpay:recipient", "leashpay:paid", "flush"]);
  });
});

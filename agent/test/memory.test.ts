import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { BrainError, createBrainClient, type BrainClient, type BrainNote, type BrainSource } from "../src/memory/brain";
import { createMemory, noteForRecipient, notesForAttack, notesForRun, ownerPrefix, rankOwnNotes } from "../src/memory/memory";
import type { Plan } from "../src/plan/build";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlannerInput } from "../src/plan/planner";
import type { PlanDraft } from "../src/plan/schema";
import { FakeGateway, LINH, MARCO, OWNER, OWNER_ACCOUNT, VAULT, tempDir } from "./fakes";

const BRAIN = "1b48ba94-8d09-449f-902f-29d2a506f199";
const SUBJECT = "6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e";
const AT = new Date("2026-11-26T04:00:00Z");
const OTHER = "0x9999999999999999999999999999999999999999" as const;

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

  it("keeps well-formed hits, and only saved notes from this brain and subject", async () => {
    const row = { id: "s1", brainId: BRAIN, subjectId: SUBJECT, originRef: "leashpay:x", label: "L", content: "C", status: "completed", affectedPageIds: ["p1", 7], createdAt: "2026-11-26T03:00:00Z" };
    const api = brainApi({
      "/search": { status: 201, body: [{ pageId: "p1", slug: "linh" }, { pageId: "", slug: "x" }, "junk"] },
      "/sources?limit=100&offset=0": { body: { items: [row, { ...row, id: "s2", brainId: "other" }, { ...row, id: "s3", subjectId: "other" }, { ...row, id: "s4", content: 5 }], total: 4 } },
    });
    await expect(api.client.search("Linh", 8)).resolves.toEqual([{ pageId: "p1", slug: "linh" }]);
    await expect(api.client.sources(100, 0)).resolves.toEqual([
      { id: "s1", originRef: "leashpay:x", label: "L", content: "C", status: "completed", affectedPageIds: ["p1"], createdAt: Date.parse("2026-11-26T03:00:00Z") },
    ]);
  });

  it("reports a slow or unreachable service", async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const client = createBrainClient({ apiKey: "k", brainId: BRAIN, subjectId: SUBJECT, fetch: slow, timeoutMs: 20 });
    await expect(client.search("x", 1)).rejects.toThrow("didn't answer within 0.02 s");
  });
});

const source = (owner: string, id: string, content: string, over: Partial<BrainSource> = {}): BrainSource => ({
  id,
  originRef: `${ownerPrefix(owner as `0x${string}`)}paid:${id}`,
  label: id,
  content,
  affectedPageIds: [],
  ...over,
});

/** An in-memory Living Brain: saved notes come back as sources; search returns the pages given. */
function fakeBrain(sources: BrainSource[] = [], hits: string[] = []) {
  const saved: BrainNote[] = [];
  const client: BrainClient & { saved: BrainNote[]; fail?: BrainError } = {
    saved,
    async capture(note) {
      if (client.fail) throw client.fail;
      saved.push(note);
      return `src-${saved.length}`;
    },
    search: vi.fn(async () => hits.map((pageId) => ({ pageId, slug: pageId }))),
    sources: vi.fn(async (_limit: number, offset: number) => (offset === 0 ? sources : [])),
  };
  return client;
}

describe("recall", () => {
  it("returns only this owner's own notes, word for word, never a compiled page", async () => {
    // Page "linh" mixes both owners; recall gives this owner its own capture behind it, never the other's.
    const brain = fakeBrain(
      [
        source(OWNER, "mine", `Owner ${OWNER} paid Linh 300 USDT.`, { affectedPageIds: ["linh"] }),
        source(OTHER, "theirs", `Owner ${OTHER} paid Linh 5 USDT. Their boss is ${OWNER}.`, { affectedPageIds: ["linh"] }),
        source(OWNER, "failed", "x", { status: "failed" }),
        { ...source(OWNER, "forged", "y"), originRef: `leashpay:${OTHER}:recipient:${OWNER.toLowerCase()}` },
      ],
      ["linh"],
    );
    const recall = await createMemory({ client: brain }).recall(OWNER, "Pay Linh 300");
    expect(recall).toEqual({ available: true, notes: [{ title: "mine", text: `Owner ${OWNER} paid Linh 300 USDT.` }] });
  });

  it("never gives one owner's note to the owner it names as a recipient", () => {
    const note = noteForRecipient(OTHER, { name: "Boss", address: OWNER, country: "VN" });
    expect(note.originRef.startsWith(ownerPrefix(OTHER))).toBe(true);
    expect(rankOwnNotes(OWNER, [{ id: "n", ...note, affectedPageIds: [] }], [])).toEqual([]);
  });

  it("ranks notes behind the search hits first, then the newest, six at most and trimmed", () => {
    const sources = [
      source(OWNER, "old", "old", { createdAt: 1 }),
      source(OWNER, "hit2", "hit2", { affectedPageIds: ["p2"] }),
      source(OWNER, "new", "x".repeat(900), { createdAt: 9 }),
      source(OWNER, "hit1", "hit1", { affectedPageIds: ["p1"] }),
      ...Array.from({ length: 5 }, (_, i) => source(OWNER, `more${i}`, "m", { createdAt: 2 })),
    ];
    const notes = rankOwnNotes(OWNER, sources, ["p1", "p2"]);
    expect(notes.map((n) => n.title)).toEqual(["hit1", "hit2", "new", "more0", "more1", "more2"]);
    expect(notes[2]!.text).toHaveLength(600);
  });

  it("is not crowded out by other owners' hits", async () => {
    const theirs = Array.from({ length: 20 }, (_, i) => source(OTHER, `t${i}`, "t", { affectedPageIds: [`p${i}`] }));
    const brain = fakeBrain([...theirs, source(OWNER, "mine", "mine")], theirs.map((_, i) => `p${i}`));
    const recall = await createMemory({ client: brain }).recall(OWNER, "Pay Linh");
    expect(recall).toMatchObject({ available: true, notes: [{ title: "mine" }] });
  });

  it("says why when Living Brain fails, and skips memory for 30 seconds", async () => {
    let t = 0;
    const brain = fakeBrain();
    brain.search = vi.fn(async () => Promise.reject(new BrainError("Living Brain answered HTTP 500.")));
    const memory = createMemory({ client: brain, now: () => t });
    expect(await memory.recall(OWNER, "x")).toEqual({ available: false, reason: "Living Brain answered HTTP 500." });
    t = 10_000;
    await memory.recall(OWNER, "x");
    expect(brain.search).toHaveBeenCalledTimes(1);
  });

  it("reads the saved-note list once a minute, and again right after a save", async () => {
    const brain = fakeBrain();
    const memory = createMemory({ client: brain, now: () => 0 });
    await memory.recall(OWNER, "a");
    await memory.recall(OWNER, "b");
    expect(brain.sources).toHaveBeenCalledTimes(2); // two pages of 100, once
    await memory.remember({ label: "n", content: "n", originRef: "n" });
    await memory.recall(OWNER, "c");
    expect(brain.sources).toHaveBeenCalledTimes(4);
  });
});

describe("saving", () => {
  it("saves one note at a time, pauses after a failure, and shows it on the next recall until one succeeds", async () => {
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
  const prefix = ownerPrefix(OWNER);

  it("a payout and a vault refusal under their owner, and an earlier payout dated honestly", () => {
    const notes = notesForRun(
      plan,
      [
        { index: 0, recipientName: "Linh", recipient: LINH, amount: "300000000000000000000", token: "USDT", status: "paid", hash: "0x01" },
        { index: 1, recipientName: "Marco", recipient: MARCO, amount: "5000000000000000000000", token: "USDT", status: "refused", error: { name: "DailyLimitExceeded", args: [], message: "over today's limit" } },
        { index: 2, recipientName: "Mai", recipient: null, amount: null, token: "USDT", status: "skipped" },
        { index: 3, recipientName: "Linh", recipient: LINH, amount: "1", token: "USDT", status: "paid", hash: "0x03", note: "Already paid in an earlier run." },
        { index: 4, recipientName: "Mai", recipient: LINH, amount: "2000000000000000000", token: "USDC", status: "paid", hash: "0x04", note: "Confirmed from an earlier run." },
      ],
      AT,
    );
    expect(notes).toEqual([
      {
        label: "Payout to Linh",
        content: `LeashPay payout on 2026-11-26 UTC. Owner ${OWNER} paid Linh (${LINH}) 300 USDT through vault ${VAULT}. Transaction 0x01. Plan ref 0xabc.`,
        originRef: `${prefix}paid:0x01`,
      },
      {
        label: "Vault refused a payment to Marco",
        content: `LeashPay refusal on 2026-11-26 UTC. The vault of owner ${OWNER} refused 5000 USDT to Marco (${MARCO}). Reason: DailyLimitExceeded: over today's limit.`,
        originRef: `${prefix}refused:plan-1:1`,
      },
      {
        label: "Payout to Mai",
        content: `LeashPay payout sent in an earlier run, confirmed on 2026-11-26 UTC. Owner ${OWNER} paid Mai (${LINH}) 2 USDC through vault ${VAULT}. Transaction 0x04. Plan ref 0xabc.`,
        originRef: `${prefix}paid:0x04`,
      },
    ]);
  });

  it("an attack only when the vault refused it, and a recipient's off-chain preferences", () => {
    const attack = { index: 0, recipient: "0xbad5000000000000000000000000000000000bad", hash: "0x02", reason: "RecipientNotAllowed", reasonSource: "replay", block: "1" } as const;
    expect(notesForAttack(plan, [{ ...attack, status: "succeeded" }], AT)).toEqual([]);
    const [note] = notesForAttack(plan, [{ ...attack, status: "reverted" }], AT);
    expect(note!.content).toContain("refused it on-chain with RecipientNotAllowed");
    expect(note!.originRef).toBe(`${prefix}attack:0x02`);
    expect(noteForRecipient(OWNER, { name: "Linh", address: LINH, country: "VN", currency: "VND", preferredToken: "USDT" }).content).toBe(
      `LeashPay recipient. Owner ${OWNER} saved Linh (${LINH}): country VN, local currency VND, prefers to be paid in USDT.`,
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
    const text = `Owner ${OWNER} paid Linh (${LINH}) 300 USDT on 2026-11-01.`;
    const t = app(fakeBrain([source(OWNER, "linh", text)]));
    const plan = (await (await t.post("/plans", { owner: OWNER, message: "Pay Linh 300" })).json()) as any;
    expect(t.planner.mock.calls[0]![0].memory).toEqual([text]);
    expect(plan.memory).toEqual({ available: true, notes: [{ title: "linh", text }] });
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
    const prefix = ownerPrefix(OWNER);
    expect(brain.saved.map((n) => n.originRef.replace(prefix, "").split(":")[0])).toEqual(["recipient", "paid", "flush"]);
  });
});

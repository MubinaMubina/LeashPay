import { describe, expect, it, vi } from "vitest";
import { openChatAction, requestChatTurn, requestPaymentReview } from "@/lib/chat-turn";

const owner = "0x0000000000000000000000000000000000000001";
const ok = (body: unknown) => ({ ok: true, status: 200, body });
const active = () => true;
const quote = {
  id: "plan-1", kind: "payment", ref: "0xref", owner, vault: owner, message: "Pay Léa\n25 USDT",
  scheduledFor: "now", createdAt: "2026-11-27T00:00:00Z", notes: [],
  payments: [{ recipientName: "Léa", recipient: owner, amount: "25000000000000000000", token: "USDT", warnings: [] }],
};

describe("the owner's chat", () => {
  it("answers locally and forgets the request when the account has no active vault", async () => {
    const api = vi.fn();
    expect(await requestChatTurn(api, null, "Pay Léa 25 USDT", ["an earlier request"], 5, active))
      .toEqual({ entry: { kind: "access" }, context: [] });
    expect(api).not.toHaveBeenCalled();
  });

  it("keeps pending user turns for a clarification and clears them on a new read", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "clarify", question: "How much?" }))
      .mockResolvedValueOnce(ok({ kind: "balance" }));
    const first = await requestChatTurn(api, owner, "Pay Léa", [], 5, active);
    expect(first?.context).toEqual(["Pay Léa"]);
    expect(first?.entry).toEqual({ kind: "draft", source: ["Pay Léa"] });
    const second = await requestChatTurn(api, owner, "Solde du coffre ?", first!.context, 5, active);
    expect(second).toEqual({ entry: { kind: "balance" }, context: [] });
    expect(api.mock.calls.map(([path]) => path)).toEqual(["chat", "chat"]);
  });

  it("prepares exactly one existing plan using the clarified request and vault policy", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "payment", message: "Pay Léa\n25 USDT" }))
      .mockResolvedValueOnce(ok(quote));
    const turn = await requestChatTurn(api, owner, "25 USDT", ["Pay Léa"], 7, active);
    expect(api.mock.calls).toEqual([
      ["chat", { body: { owner, message: "25 USDT", context: ["Pay Léa"] } }],
      ["plans", { body: { owner, message: "Pay Léa\n25 USDT", depegThreshold: 7 } }],
    ]);
    expect(turn).toEqual({ entry: { kind: "plan", plan: quote, events: [] }, context: [] });
  });

  it("discards a late tool reply when the owner leaves the chat", async () => {
    const api = vi.fn().mockResolvedValue(ok({ kind: "payment", message: "Pay Léa 25 USDT" }));
    expect(await requestChatTurn(api, owner, "Pay Léa 25 USDT", [], 5, () => false)).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected payee when plan preparation fails after a change of recipient", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "payment", message: "Pay Linh 25 USDT" }))
      .mockResolvedValueOnce({ ok: false, status: 503, body: { error: "Try again" } });
    const turn = await requestChatTurn(api, owner, "Pay Linh 25 USDT", ["Pay Léa"], 5, active);
    expect(turn?.entry.kind).toBe("error");
    expect(turn?.context).toEqual(["Pay Linh 25 USDT"]);
    expect(turn?.entry).toMatchObject({ kind: "error", retry: { kind: "review", message: "Pay Linh 25 USDT" } });
  });

  it.each(["help", "balance", "recipients", "add", "payment"] as const)(
    "opens one %s card on consecutive shortcut clicks", (action) => {
      const first = openChatAction([], action);
      expect(first).toHaveLength(1);
      expect(openChatAction(first, action)).toBe(first);
      if (action === "payment") expect(first[0]).toEqual({ kind: "draft", source: [] });
    },
  );

  it("keeps the current partial request and structured candidates without displaying model prose", async () => {
    const api = vi.fn().mockResolvedValue(ok({ kind: "clarify", contextStart: null, candidates: ["Test A", "Test B"], question: "A free-form reply" }));
    const source = ["send 200 test"];
    expect(await requestChatTurn(api, owner, source[0]!, ["Pay Léa 50 tomorrow"], 5, active)).toEqual({
      entry: { kind: "draft", source, candidates: ["Test A", "Test B"] }, context: source,
    });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("keeps only the indicated owner turns when clarifying an ongoing payment", async () => {
    const api = vi.fn().mockResolvedValue(ok({ kind: "clarify", contextStart: 1 }));
    const source = ["Pay Alex on Friday", "200 USDT"];
    expect(await requestChatTurn(api, owner, source[1]!, ["Pay Léa", source[0]!], 5, active)).toEqual({
      entry: { kind: "draft", source }, context: source,
    });
  });

  it.each([null, "free reply", { kind: "not_a_tool", text: "raw" }, { kind: "add", fields: null },
    { kind: "payment", message: "" }, { kind: "clarify", contextStart: 5 }])(
    "turns an unsupported agent response into a recoverable card", async body => {
      const api = vi.fn().mockResolvedValue(ok(body));
      const result = await requestChatTurn(api, owner, "hello", [], 5, active);
      expect(result?.entry).toMatchObject({ kind: "error", retry: { kind: "chat", message: "hello", context: [] } });
      expect(api).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["help", "balance", "recipients"] as const)("opens a structured %s card from a typed message", async kind => {
    const api = vi.fn().mockResolvedValue(ok({ kind, text: "extra model text" }));
    expect(await requestChatTurn(api, owner, "Show me", ["Pay Alex"], 5, active)).toEqual({ entry: { kind }, context: [] });
  });

  it("only passes supported prefill fields to the recipient form", async () => {
    const api = vi.fn().mockResolvedValue(ok({ kind: "add", fields: { name: "Léa", reply: "extra model text" } }));
    expect(await requestChatTurn(api, owner, "Add Léa", [], 5, active)).toEqual({
      entry: { kind: "add", fields: { name: "Léa" } }, context: [],
    });
  });

  it("keeps a missing recipient editable if the classifier prematurely calls the planner", async () => {
    const message = "send 200 test";
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "payment", message })).mockResolvedValueOnce(ok({
      ...quote, message, payments: [{ ...quote.payments[0], recipientName: "test", recipient: null }],
    }));
    expect(await requestChatTurn(api, owner, message, [], 5, active)).toEqual({
      entry: { kind: "draft", source: [message] }, context: [message],
    });
  });

  it("preserves a runnable plan's on-chain refusals and a mixed plan's individual verdicts", async () => {
    const refused = { ...quote.payments[0], preview: { name: "RecipientNotAllowed", args: [owner], message: "Recipient not allowed" } };
    const held = { ...quote.payments[0], amount: null, warnings: ["Held for review"] };
    const plan = { ...quote, payments: [refused, held] };
    const api = vi.fn().mockResolvedValue(ok(plan));
    expect((await requestPaymentReview(api, owner, plan.message, 5, active))?.entry).toEqual({ kind: "plan", plan, events: [] });
  });

  it("uses the owner's form directly for an unsigned quote, including the current vault policy", async () => {
    const api = vi.fn().mockResolvedValue(ok(quote));
    const message = "Pay 25 USDT to " + owner;
    expect((await requestPaymentReview(api, owner, message, 4, active))?.entry).toEqual({ kind: "plan", plan: quote, events: [] });
    expect(api.mock.calls).toEqual([["plans", { body: { owner, message, depegThreshold: 4 } }]]);
  });

  it("routes a non-payment planner response back to an editable card", async () => {
    const api = vi.fn().mockResolvedValue(ok({ ...quote, kind: "not_a_payment", payments: [], notes: ["unstructured planner reply"] }));
    expect(await requestPaymentReview(api, owner, "send 200 test", 5, active)).toEqual({
      entry: { kind: "draft", source: ["send 200 test"] }, context: ["send 200 test"],
    });
  });

  it.each([
    { ...quote, ref: null }, { ...quote, payments: [{}] },
    { ...quote, payments: [{ ...quote.payments[0], amount: "twenty" }] },
    { ...quote, paymentFee: { token: "USDT", amount: "?", recipient: owner } },
  ])("returns a retry card for a quote the payout UI couldn't safely display", async unreadable => {
    const api = vi.fn().mockResolvedValue(ok(unreadable));
    expect((await requestPaymentReview(api, owner, "Pay Léa 25 USDT", 5, active))?.entry).toMatchObject({
      kind: "error", retry: { kind: "review", message: "Pay Léa 25 USDT" },
    });
  });
});

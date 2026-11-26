import { describe, expect, it, vi } from "vitest";
import { requestChatTurn } from "@/lib/chat-turn";

const owner = "0x0000000000000000000000000000000000000001";
const ok = (body: unknown) => ({ ok: true, status: 200, body });
const active = () => true;

describe("the owner's chat", () => {
  it("keeps pending user turns for a clarification and clears them on a new read", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "clarify", question: "How much?" }))
      .mockResolvedValueOnce(ok({ kind: "balance" }));
    const first = await requestChatTurn(api, owner, "Pay Léa", [], 5, active);
    expect(first?.context).toEqual(["Pay Léa"]);
    const second = await requestChatTurn(api, owner, "Solde du coffre ?", first!.context, 5, active);
    expect(second).toEqual({ entry: { kind: "balance" }, context: [] });
    expect(api.mock.calls.map(([path]) => path)).toEqual(["chat", "chat"]);
  });

  it("prepares exactly one existing plan using the clarified request and vault policy", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok({ kind: "payment", message: "Pay Léa\n25 USDT" }))
      .mockResolvedValueOnce(ok({ id: "plan-1" }));
    const turn = await requestChatTurn(api, owner, "25 USDT", ["Pay Léa"], 7, active);
    expect(api.mock.calls).toEqual([
      ["chat", { body: { owner, message: "25 USDT", context: ["Pay Léa"] } }],
      ["plans", { body: { owner, message: "Pay Léa\n25 USDT", depegThreshold: 7 } }],
    ]);
    expect(turn).toEqual({ entry: { kind: "plan", plan: { id: "plan-1" }, events: [] }, context: [] });
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
  });
});

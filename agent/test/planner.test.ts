import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/config";
import { PlannerError, draftPlan, type PlannerInput } from "../src/plan/planner";
import type { PlanDraft } from "../src/plan/schema";
import { LINH } from "./fakes";

const input: PlannerInput = {
  message: "Pay Linh 300 on the 1st",
  directory: [{ name: "Linh", address: LINH, country: "Vietnam", currency: "VND" }],
  today: "2026-11-25",
  balances: { USDT: "5000", USDC: "0", tbill: "0" },
};

const draft: PlanDraft = {
  kind: "payment",
  payments: [{ recipient_name: "Linh", recipient_address: LINH, amount: "300", currency: "USD" }],
  scheduled_for: "2026-12-01",
  notes: [],
};

/** A stand-in Anthropic client: only beta.messages.parse, returning a canned response. */
function fakeClient(response: Record<string, unknown>) {
  const parse = vi.fn(async () => response);
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe("draftPlan", () => {
  it("asks Claude Opus 5.5 for a structured plan and returns it", async () => {
    const { client, parse } = fakeClient({ stop_reason: "end_turn", stop_details: null, parsed_output: draft });

    await expect(draftPlan(client, "claude-opus-5-5", input)).resolves.toEqual(draft);

    const [request] = parse.mock.calls[0] as unknown as [Record<string, any>];
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.output_config.effort).toBe("medium");
    expect(request.output_config.format).toBeDefined();
    expect(request.messages[0].content).toContain("<owner_message>\nPay Linh 300 on the 1st\n</owner_message>");
    expect(request.messages[0].content).toContain(`- Linh: ${LINH}, Vietnam, gets paid in VND`);
  });

  it("reports a refusal instead of reading the output", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null });
    await expect(draftPlan(client, "claude-opus-5-5", input)).rejects.toThrow(
      new PlannerError("Claude declined to plan this message (cyber)."),
    );
  });

  it("reports a cut-off answer", async () => {
    const { client } = fakeClient({ stop_reason: "max_tokens", stop_details: null, parsed_output: null });
    await expect(draftPlan(client, "claude-opus-5-5", input)).rejects.toBeInstanceOf(PlannerError);
  });

  it("turns the SDK's missing-credentials error into a clear configuration error", async () => {
    const parse = vi.fn(async () => {
      throw new Error("Could not resolve authentication method. Expected one of apiKey, authToken, ...");
    });
    const client = { beta: { messages: { parse } } } as unknown as Anthropic;
    await expect(draftPlan(client, "claude-opus-5-5", input)).rejects.toThrow(
      new ConfigurationError("No Claude credentials found. Set ANTHROPIC_API_KEY in .env."),
    );
  });

  it("reports output that doesn't match the schema", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", stop_details: null, parsed_output: null });
    await expect(draftPlan(client, "claude-opus-5-5", input)).rejects.toThrow("didn't match the payment plan format");
  });
});

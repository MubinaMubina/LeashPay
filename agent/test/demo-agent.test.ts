import { describe, expect, it } from "vitest";
import { planDemo } from "../scripts/demo-agent";
import type { PlanDraft } from "../src/plan/schema";

const payment = (name: string) => ({ recipient_name: name, recipient_address: "", amount: "1", currency: "USDT" });
const draft = (names: string[]): PlanDraft => ({
  kind: "payment",
  scheduled_for: "now",
  payments: names.map(payment),
  notes: [],
});

describe("terminal payroll plan", () => {
  it("resolves a names-only response through the production directory and emits exact units", async () => {
    const result = await planDemo(async () => draft(["marco", "mai", "linh"]), false);
    expect(result.chainId).toBe(97);
    expect(result.token).toBe("0x0081297D056308340E5501B5F2f076344A46aB44");
    expect(result.payments).toHaveLength(3);
    expect(result.payments).toContainEqual({
      name: "Marco", address: "0xEBe6E66c61DC57185F2c9a63bbc9914B85A4b13B", amount: "1000000000000000000",
    });
  });

  it("requests only Marco for the single-payment demo", async () => {
    const result = await planDemo(async ({ message, directory }) => {
      expect(message).toContain("Marco");
      expect(message).not.toMatch(/Linh|Mai|0x/);
      expect(directory).toHaveLength(3);
      return draft(["Marco"]);
    }, true);
    expect(result.payments.map((p) => p.name)).toEqual(["Marco"]);
  });

  it.each([
    { ...draft(["Marco"]), scheduled_for: "2027-01-01" },
    draft(["Linh"]),
    draft(["Marco", "Mai"]),
    { ...draft([]), payments: [{ ...payment("Marco"), amount: "1.01" }] },
    { ...draft([]), payments: [{ ...payment("Marco"), currency: "USDC" }] },
    { ...draft([]), payments: [{ ...payment("Linh"), recipient_address: "0xEBe6E66c61DC57185F2c9a63bbc9914B85A4b13B" }] },
  ])("rejects a single-payment response outside the agreed payroll", async (bad) => {
    await expect(planDemo(async () => bad, true)).rejects.toThrow();
  });
});

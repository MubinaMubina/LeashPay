import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import WorkspacePage from "@/app/workspace/page";
import { MoneyActions } from "@/components/MoneyActions";
import { CashFlow } from "@/components/CashFlow";

const { auth, wallet, api, send } = vi.hoisted(() => ({
  auth: { ready: true, authenticated: false, user: null as { id: string } | null },
  wallet: { current: undefined as { address: string } | undefined },
  api: vi.fn(), send: vi.fn(),
}));
vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ ...auth, login: vi.fn(), logout: vi.fn() }) }));
vi.mock("@/lib/client", () => ({
  useOwnerWallet: () => wallet.current, useApi: () => api, useSendAndWait: () => send, useSponsoredAction: () => undefined,
  publicClient: { readContract: vi.fn() },
}));

beforeEach(() => {
  auth.ready = true;
  auth.authenticated = false;
  auth.user = null;
  wallet.current = undefined;
});

describe("public workspace", () => {
  it.each([true, false])("offers email sign-in and a public preview on the home page (ready: %s)", ready => {
    auth.ready = ready;
    const html = renderToStaticMarkup(createElement(Home));
    expect(html).toContain("Pay your contractors in stablecoins.");
    expect(html).toContain("Example payout");
    expect(html).toMatch(/href="\/workspace"/);
    const button = html.match(/<button[^>]*>Continue with email<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button?.includes("disabled")).toBe(!ready);
    expect(html).not.toContain('aria-label="Message the agent"');
    expect(api).not.toHaveBeenCalled();
  });
  it.each(["guest", "loading", "wallet pending", "owner"])("opens the workspace for %s", state => {
    if (state === "loading") auth.ready = false;
    if (state === "wallet pending" || state === "owner") {
      auth.authenticated = true;
      auth.user = { id: "user" };
    }
    if (state === "owner") wallet.current = { address: "0x1111111111111111111111111111111111111111" };
    const html = renderToStaticMarkup(createElement(auth.authenticated ? Home : WorkspacePage));
    for (const name of ["Payment chat", "Recipients", "Your vault", "Cash flow"]) expect(html).toMatch(new RegExp('role="tab"[^>]+>' + name + '<'));
    expect(html).toContain('aria-label="Message the agent"');
    expect(api).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("offers a bank transfer preview with no payment-method selector", () => {
    const html = renderToStaticMarkup(createElement(MoneyActions, { active: true }));
    expect(html).toContain("Bank transfer");
    expect(html).toContain("Coming soon");
    expect(html).not.toMatch(/Apple Pay|<select/);
  });
  it.each(["History", "30-day forecast"] as const)("mounts only %s on entry to Cash flow", view => {
    const history = vi.fn(() => null);
    const forecast = vi.fn(() => null);
    const html = renderToStaticMarkup(createElement(CashFlow, {
      view, onSelect: vi.fn(), history: createElement(history), forecast: createElement(forecast),
    }));
    expect(html).toContain(`aria-selected="true" aria-controls="cash-panel-${view === "History" ? 0 : 1}"`);
    expect(history).toHaveBeenCalledTimes(view === "History" ? 1 : 0);
    expect(forecast).toHaveBeenCalledTimes(view === "30-day forecast" ? 1 : 0);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { MoneyActions } from "@/components/MoneyActions";

const { auth, wallet, api, send } = vi.hoisted(() => ({
  auth: { ready: true, authenticated: false, user: null as { id: string } | null },
  wallet: { current: undefined as { address: string } | undefined },
  api: vi.fn(), send: vi.fn(),
}));
vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ ...auth, login: vi.fn(), logout: vi.fn() }) }));
vi.mock("@/lib/client", () => ({
  useOwnerWallet: () => wallet.current, useApi: () => api, useSendAndWait: () => send,
  publicClient: { readContract: vi.fn() },
}));

beforeEach(() => {
  auth.ready = true;
  auth.authenticated = false;
  auth.user = null;
  wallet.current = undefined;
});

describe("public workspace", () => {
  it.each(["guest", "loading", "wallet pending", "owner"])("renders the same navigation and composer for %s", state => {
    if (state === "loading") auth.ready = false;
    if (state === "wallet pending" || state === "owner") {
      auth.authenticated = true;
      auth.user = { id: "user" };
    }
    if (state === "owner") wallet.current = { address: "0x1111111111111111111111111111111111111111" };
    const html = renderToStaticMarkup(createElement(Home));
    for (const name of ["Payment chat", "Recipients", "Your vault"]) expect(html).toMatch(new RegExp('role="tab"[^>]+>' + name + '<'));
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
});

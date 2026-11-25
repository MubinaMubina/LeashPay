import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createOwnerResolver, type PrivyLookups } from "@/lib/session";

const EMBEDDED = {
  type: "wallet",
  chain_type: "ethereum",
  connector_type: "embedded",
  wallet_client_type: "privy",
  address: "0x7f3a00000000000000000000000000000000c0de",
};
const EXTERNAL = { ...EMBEDDED, connector_type: "injected", wallet_client_type: "metamask", address: "0x5eeccb731a3b642bfe93f0aabe95ac74f5126b21" };

const withToken = (token = "good") => new Request("http://localhost:3000/api/vault", { headers: { authorization: `Bearer ${token}` } });

function privy(accounts: object[][]): PrivyLookups & { getUser: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    verifyAccessToken: async (token) => {
      if (token !== "good") throw new Error("invalid token");
      return { user_id: "did:privy:user-1" };
    },
    getUser: vi.fn(async () => ({ linked_accounts: accounts[Math.min(call++, accounts.length - 1)] })),
  };
}

describe("owner resolver", () => {
  it("takes the owner from the user's Privy embedded wallet, ignoring linked external wallets", async () => {
    const resolve = createOwnerResolver(privy([[EXTERNAL, EMBEDDED]]));
    expect(await resolve(withToken())).toEqual({ ok: true, owner: getAddress(EMBEDDED.address) });
  });

  it("refuses a missing or invalid login token with 401", async () => {
    const resolve = createOwnerResolver(privy([[EMBEDDED]]));
    expect(await resolve(new Request("http://localhost:3000/api/vault"))).toMatchObject({ ok: false, status: 401 });
    expect(await resolve(withToken("forged"))).toMatchObject({ ok: false, status: 401 });
  });

  it("answers 401 wallet not ready before the wallet exists, and doesn't cache that answer", async () => {
    const lookups = privy([[EXTERNAL], [EMBEDDED]]);
    const resolve = createOwnerResolver(lookups);
    expect(await resolve(withToken())).toEqual({ ok: false, status: 401, error: "wallet not ready, try again" });
    expect(await resolve(withToken())).toMatchObject({ ok: true });
  });

  it("caches a found wallet, so polling doesn't call Privy on every request", async () => {
    let now = 0;
    const lookups = privy([[EMBEDDED]]);
    const resolve = createOwnerResolver(lookups, { cacheMs: 1000, now: () => now });
    await resolve(withToken());
    await resolve(withToken());
    expect(lookups.getUser).toHaveBeenCalledTimes(1);
    now = 1001;
    await resolve(withToken());
    expect(lookups.getUser).toHaveBeenCalledTimes(2);
  });

  it("answers 503 with the missing settings when Privy isn't configured", async () => {
    expect(await createOwnerResolver(null)(withToken())).toMatchObject({ ok: false, status: 503 });
  });
});

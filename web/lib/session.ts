import { getAddress, isAddress, type Address } from "viem";

/** Who is asking: the verified owner, or why the request can't go on. */
export type OwnerResult = { ok: true; owner: Address } | { ok: false; status: number; error: string };

/** The two Privy server calls the web app needs, so tests can stand in for Privy. */
export interface PrivyLookups {
  /** Checks the access token's signature and expiry; resolves to the Privy user id. */
  verifyAccessToken(token: string): Promise<{ user_id: string }>;
  /** Looks up the user and the accounts linked to them. */
  getUser(userId: string): Promise<{ linked_accounts: ReadonlyArray<object> }>;
}

const OWNER_CACHE_MS = 10 * 60 * 1000;

/**
 * The vault owner is the address of the user's Privy embedded wallet, read on the server
 * from Privy itself. Whatever the browser says about owners is never trusted. Only found
 * wallets are cached: right after login the wallet may not exist yet, and caching that
 * answer would lock the user out until the cache expired.
 */
export function createOwnerResolver(
  privy: PrivyLookups | null,
  options: { cacheMs?: number; now?: () => number } = {},
): (request: Request) => Promise<OwnerResult> {
  const cacheMs = options.cacheMs ?? OWNER_CACHE_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { owner: Address; until: number }>();

  return async (request) => {
    if (!privy) {
      return { ok: false, status: 503, error: "The web server needs NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET in .env." };
    }
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return { ok: false, status: 401, error: "Log in to continue." };

    let userId: string;
    try {
      ({ user_id: userId } = await privy.verifyAccessToken(token));
    } catch {
      return { ok: false, status: 401, error: "Your login has expired. Log in again." };
    }

    const cached = cache.get(userId);
    if (cached && cached.until > now()) return { ok: true, owner: cached.owner };

    let accounts: ReadonlyArray<object>;
    try {
      accounts = (await privy.getUser(userId)).linked_accounts;
    } catch {
      return { ok: false, status: 502, error: "Couldn't reach Privy to look up your wallet. Try again." };
    }
    const address = embeddedWalletAddress(accounts);
    if (!address) return { ok: false, status: 401, error: "wallet not ready, try again" };

    const owner = getAddress(address);
    cache.set(userId, { owner, until: now() + cacheMs });
    return { ok: true, owner };
  };
}

/** The Privy-made Ethereum wallet among the user's linked accounts. Linked external wallets don't count. */
function embeddedWalletAddress(accounts: ReadonlyArray<object>): string | undefined {
  for (const account of accounts as ReadonlyArray<Record<string, unknown>>) {
    if (
      account.type === "wallet" &&
      account.chain_type === "ethereum" &&
      account.connector_type === "embedded" &&
      account.wallet_client_type === "privy" &&
      typeof account.address === "string" &&
      isAddress(account.address)
    ) {
      return account.address;
    }
  }
  return undefined;
}

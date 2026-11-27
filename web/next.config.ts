import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// The repository keeps one .env at its root (see .env.example), but Next.js only
// reads .env files from web/. Copy in exactly the settings the web app needs and
// nothing else: the agent key and the Claude key stay out of this process.
const WEB_SETTINGS = [
  "NEXT_PUBLIC_PRIVY_APP_ID",
  "NEXT_PUBLIC_FACTORY_ADDRESS",
  "NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS",
  "PRIVY_APP_SECRET",
  "NODEREAL_API_KEY",
  "CMC_API_KEY",
  "AGENT_URL",
  "AGENT_API_TOKEN",
] as const;

const rootEnv = path.resolve(process.cwd(), "..", ".env");
if (existsSync(rootEnv)) {
  const values = parseEnv(readFileSync(rootEnv, "utf8"));
  for (const key of WEB_SETTINGS) {
    const value = values[key]?.trim();
    if (value && !process.env[key]) process.env[key] = value;
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;

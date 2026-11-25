import { describe, expect, it } from "vitest";
import { claudeApiKey, isLoopback, loadConfig, localHostHeaders } from "../src/config";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("listens on this machine only by default", () => {
    expect(loadConfig(env({})).AGENT_HOST).toBe("127.0.0.1");
    expect(loadConfig(env({ AGENT_HOST: "" })).AGENT_HOST).toBe("127.0.0.1");
  });

  it("refuses to listen beyond this machine without an API token", () => {
    expect(() => loadConfig(env({ AGENT_HOST: "0.0.0.0" }))).toThrow(/AGENT_API_TOKEN/);
    expect(loadConfig(env({ AGENT_HOST: "0.0.0.0", AGENT_API_TOKEN: "a-long-enough-test-token" })).AGENT_HOST).toBe("0.0.0.0");
  });

  it("reads the Claude key under its current name, or the old LLM_API_KEY", () => {
    expect(claudeApiKey(loadConfig(env({ ANTHROPIC_API_KEY: "new", LLM_API_KEY: "old" })))).toBe("new");
    expect(claudeApiKey(loadConfig(env({ LLM_API_KEY: "old" })))).toBe("old");
    expect(claudeApiKey(loadConfig(env({ LLM_API_KEY: "" })))).toBeUndefined();
  });

  it("knows which addresses only this machine can reach, and never trusts a lookalike hostname", () => {
    expect(["127.0.0.1", "127.0.0.2", "localhost", "::1"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.20", "::", "127.agent.example", "127.0.0.1.example.com"].some(isLoopback)).toBe(false);
    expect(() => loadConfig(env({ AGENT_HOST: "127.agent.example" }))).toThrow(/AGENT_API_TOKEN/);
  });

  it("accepts requests addressed to the host it listens on", () => {
    expect(localHostHeaders({ AGENT_HOST: "127.0.0.2", PORT: 8787 })).toEqual([
      "localhost:8787",
      "127.0.0.1:8787",
      "[::1]:8787",
      "127.0.0.2:8787",
    ]);
    expect(localHostHeaders({ AGENT_HOST: "::1", PORT: 8787 })).toEqual(["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]);
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lockDataDir } from "../src/execution/lock";
import { tempDir } from "./fakes";

describe("lockDataDir", () => {
  it("refuses to share a data folder with another running agent server", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "server.lock"), String(process.ppid)); // a live process that isn't us
    expect(() => lockDataDir(dir)).toThrow(/already using/);
  });

  it("points to the lock file, never to a fresh data folder that would forget sent payments", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "server.lock"), String(process.ppid));
    let message = "";
    try {
      lockDataDir(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`delete ${path.join(dir, "server.lock")}`);
    expect(message).not.toContain("DATA_DIR");
  });

  it("takes over a lock left behind by a server that crashed, and releases it", () => {
    const dir = tempDir();
    const file = path.join(dir, "server.lock");
    writeFileSync(file, "999999999"); // no such process

    const release = lockDataDir(dir);

    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});

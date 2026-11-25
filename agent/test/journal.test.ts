import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../src/execution/journal";
import { lockDataDir } from "../src/execution/lock";
import { RecipientDirectory } from "../src/plan/directory";
import { LINH, OWNER, tempDir } from "./fakes";

const record = (planId: string) => JSON.stringify({ type: "plan_finished", planId, at: "2026-11-25T00:00:00.000Z" });

let file: string;

beforeEach(() => {
  file = path.join(tempDir(), "journal.jsonl");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Journal", () => {
  it("keeps every record across a restart", () => {
    const journal = new Journal(file);
    journal.append({ type: "plan_finished", planId: "a" });
    journal.append({ type: "plan_finished", planId: "b" });

    const reloaded = new Journal(file);

    expect(reloaded.eventsFor("a")).toHaveLength(1);
    expect(reloaded.eventsFor("b")).toHaveLength(1);
  });

  it("starts after a crash left half a record at the end, and drops only that fragment", () => {
    writeFileSync(file, `${record("a")}\n{"type":"step_se`);

    const journal = new Journal(file);

    expect(journal.eventsFor("a")).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(`${record("a")}\n`);
    journal.append({ type: "plan_finished", planId: "b" });
    expect(new Journal(file).eventsFor("b")).toHaveLength(1);
  });

  it("cuts at the right byte after records with non-ASCII names", () => {
    const named = JSON.stringify({ type: "plan_finished", planId: "Nguyễn 🚀", at: "2026-11-25T00:00:00.000Z" });
    writeFileSync(file, `${named}\n{"type":"step_se`);

    new Journal(file);

    expect(readFileSync(file, "utf8")).toBe(`${named}\n`);
  });

  it("finishes a complete last record that lost its newline, so the next append starts its own line", () => {
    writeFileSync(file, record("a"));

    new Journal(file).append({ type: "plan_finished", planId: "b" });

    const reloaded = new Journal(file);
    expect(reloaded.eventsFor("a")).toHaveLength(1);
    expect(reloaded.eventsFor("b")).toHaveLength(1);
  });

  it("keeps the data folder readable only by the account running the agent", () => {
    const dir = path.join(tempDir(), "data");
    lockDataDir(dir)();
    new Journal(path.join(dir, "journal.jsonl")).append({ type: "plan_finished", planId: "a" });
    new RecipientDirectory(path.join(dir, "recipients.json")).upsert(OWNER, { name: "Linh", address: LINH });

    const mode = (name: string) => statSync(path.join(dir, name)).mode & 0o777;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(mode("journal.jsonl")).toBe(0o600);
    expect(mode("recipients.json")).toBe(0o600);
  });

  it("refuses to load damage in the middle instead of silently skipping it", () => {
    writeFileSync(file, `${record("a")}\n{oops\n${record("b")}\n`);

    expect(() => new Journal(file)).toThrow(/damaged at line 2/);
    expect(readFileSync(file, "utf8")).toBe(`${record("a")}\n{oops\n${record("b")}\n`); // untouched
  });
});

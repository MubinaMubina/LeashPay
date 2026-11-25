import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A disk that fills up mid-record: the next write puts only part of it on disk, then fails.
// Both write paths are covered, so the test holds whichever one the journal uses.
const fault = vi.hoisted(() => ({ armed: false, failTruncate: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const diskFull = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const mocked = {
    ...fs,
    appendFileSync: ((file: Parameters<typeof fs.appendFileSync>[0], data: string, options?: unknown) => {
      if (!fault.armed) return fs.appendFileSync(file, data, options as never);
      fault.armed = false;
      fs.appendFileSync(file, String(data).slice(0, 12));
      throw diskFull();
    }) as typeof fs.appendFileSync,
    writeSync: ((fd: number, data: string) => {
      if (!fault.armed) return fs.writeSync(fd, data);
      fault.armed = false;
      fs.writeSync(fd, String(data).slice(0, 12));
      throw diskFull();
    }) as typeof fs.writeSync,
    truncateSync: ((file: Parameters<typeof fs.truncateSync>[0], len?: number) => {
      if (!fault.failTruncate) return fs.truncateSync(file, len);
      fault.failTruncate = false;
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    }) as typeof fs.truncateSync,
  };
  return { ...mocked, default: mocked };
});

const { Journal } = await import("../src/execution/journal");
const { tempDir } = await import("./fakes");

let file: string;
beforeEach(() => {
  file = path.join(tempDir(), "journal.jsonl");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Journal on a full disk", () => {
  it("leaves no half record behind when a write fails, so the server keeps working", () => {
    const journal = new Journal(file);
    journal.append({ type: "plan_finished", planId: "a" });

    fault.armed = true;
    expect(() => journal.append({ type: "plan_finished", planId: "b" })).toThrow(/ENOSPC/);
    journal.append({ type: "plan_finished", planId: "c" }); // space came back

    const reloaded = new Journal(file); // would refuse to load with half a record in the middle
    expect(reloaded.eventsFor("a")).toHaveLength(1);
    expect(reloaded.eventsFor("b")).toHaveLength(0);
    expect(reloaded.eventsFor("c")).toHaveLength(1);
  });

  it("stops taking records when it can't remove half a record, so nothing is written after it", () => {
    const journal = new Journal(file);
    journal.append({ type: "plan_finished", planId: "a" });

    fault.armed = true;
    fault.failTruncate = true;
    expect(() => journal.append({ type: "plan_finished", planId: "b" })).toThrow(/ENOSPC/);

    // Without this refusal the next record would follow the fragment and the journal would
    // no longer load; a payment could then go out with no record of it.
    expect(() => journal.append({ type: "plan_finished", planId: "c" })).toThrow(/restart/);
    expect(new Journal(file).eventsFor("a")).toHaveLength(1); // a restart repairs the torn tail
  });
});

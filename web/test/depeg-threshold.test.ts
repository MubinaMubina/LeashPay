import { describe, expect, it } from "vitest";
import { parseStoredThreshold, percent, readingTime } from "../lib/depeg";

describe("the stored depeg limit", () => {
  it("keeps a saved limit within the slider's range", () => {
    expect(parseStoredThreshold("3.5", 20)).toBe(3.5);
    expect(parseStoredThreshold("0", 20)).toBe(0);
    expect(parseStoredThreshold("50", 20)).toBe(20);
  });

  it("ignores a missing, blank, negative or non-numeric value", () => {
    for (const raw of [null, "", "  ", "-1", "abc", "NaN", "Infinity"]) expect(parseStoredThreshold(raw, 20)).toBeNull();
  });

  it("shows the reading's date and time in UTC, and the percent as the agent rounds it", () => {
    expect(readingTime("2026-11-26T06:30:59.000Z")).toBe("26 Nov 06:30 UTC");
    expect(percent(0.032)).toBe("3.2%");
    expect(percent(0.05004)).toBe("5%");
  });
});

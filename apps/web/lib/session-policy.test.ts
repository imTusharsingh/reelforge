import { describe, expect, it } from "vitest";
import { isCurrentGeneration, resolveCurrentRequest } from "./session-policy";

describe("authenticated request generations", () => {
  it("rejects responses from a previous session or workspace generation", () => {
    expect(isCurrentGeneration(4, 4)).toBe(true);
    expect(isCurrentGeneration(5, 4)).toBe(false);
  });

  it("ignores delayed success and rejection from an obsolete generation", async () => {
    let current = 1;
    let release!: (value: string) => void;
    const delayed = new Promise<string>((resolve) => {
      release = resolve;
    });
    const result = resolveCurrentRequest(delayed, () => current, 1);
    current = 2;
    release("old workspace");
    await expect(result).resolves.toBeNull();

    let reject!: (reason: Error) => void;
    const rejected = new Promise<string>((_, fail) => {
      reject = fail;
    });
    const staleError = resolveCurrentRequest(rejected, () => current, 2);
    current = 3;
    reject(new Error("old request failed"));
    await expect(staleError).resolves.toBeNull();
  });
});

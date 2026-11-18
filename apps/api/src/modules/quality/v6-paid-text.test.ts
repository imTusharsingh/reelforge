import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Context, Run } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { criticTextPort } from "./v6-paid-text.js";

const spec = {
  prompt: "review",
  jsonSchema: {},
  parse: (value: unknown): number => z.number().parse(value),
};
function fixture(previous: unknown = null): {
  port: ReturnType<typeof criticTextPort>;
  calls: string[];
  findFirst: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const findFirst = vi.fn(async () => previous);
  const complete = vi.fn(async () => {
    calls.push("dispatch");
    return { output: 8, providerJobId: "job", usage: {} };
  });
  const db = {
    videoRunStep: {
      findFirst,
      updateMany: async (): Promise<void> => {
        calls.push("persist-job");
      },
    },
  };
  const deps = {
    access: { runs: { store: { scoped: () => db } } } as unknown as MediaAccess,
    accounts: {
      begin: async () => {
        calls.push("intent");
        return { id: "step", idempotencyKey: "idem" };
      },
      prepare: async () => {
        calls.push("reserve");
      },
      complete: async () => {
        calls.push("settle");
      },
    } as unknown as MediaAccounts,
    ports: { get: async () => ({ text: { complete } }) } as unknown as MediaPorts,
    context: { workspaceId: "w" } as Context,
    run: { id: "r" } as Run,
    attempt: 2,
  };
  return { port: criticTextPort(deps), calls, findFirst, complete };
}
afterEach(() => vi.unstubAllEnvs());
describe("V6 paid text boundary", () => {
  it("reserves before dispatch and records the provider job before settling", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    const t = fixture();
    await expect(t.port.complete(spec, "ignored")).resolves.toMatchObject({
      output: 8,
      providerJobId: "job",
    });
    expect(t.calls).toEqual(["intent", "reserve", "dispatch", "persist-job", "settle"]);
    expect(t.findFirst).toHaveBeenCalledWith({ where: { runId: "r", key: "media:text:critic:2" } });
  });
  it("reuses a completed result and refuses an uncertain submission", async () => {
    const input = {
      spec: {
        fingerprint: createHash("sha256")
          .update(JSON.stringify({ prompt: spec.prompt, jsonSchema: spec.jsonSchema }))
          .digest("hex"),
      },
    };
    const saved = fixture({
      state: "SUCCEEDED",
      input,
      output: { result: { output: 7, providerJobId: "job", usage: {} } },
    });
    await expect(saved.port.complete(spec, "ignored")).resolves.toMatchObject({ output: 7 });
    expect(saved.complete).not.toHaveBeenCalled();
    const pending = fixture({ state: "RUNNING", input });
    await expect(pending.port.complete(spec, "ignored")).rejects.toThrow("RECONCILE_REQUIRED");
    expect(pending.complete).not.toHaveBeenCalled();
    const changed = fixture({ state: "SUCCEEDED", input: { spec: { fingerprint: "different" } } });
    await expect(changed.port.complete(spec, "ignored")).rejects.toThrow("input changed");
    expect(changed.complete).not.toHaveBeenCalled();
  });
});

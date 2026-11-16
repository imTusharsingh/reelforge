import { afterEach, expect, it, vi } from "vitest";
import { scriptRequestIdentity, finishScriptRequest } from "./script-request";
afterEach(() => vi.unstubAllGlobals());
it("preserves identity without session storage and clears only on confirmed success", async () => {
  vi.stubGlobal("sessionStorage", {
    getItem: (): never => {
      throw new Error("Unavailable");
    },
    setItem: (): never => {
      throw new Error("Unavailable");
    },
    removeItem: (): never => {
      throw new Error("Unavailable");
    },
  });
  const workspace = crypto.randomUUID();
  const first = await scriptRequestIdentity(workspace, ["same content"]);
  expect(await scriptRequestIdentity(workspace, ["same content"])).toEqual(first);
  expect((await scriptRequestIdentity(workspace, ["changed content"])).correlationId).not.toBe(
    first.correlationId,
  );
  finishScriptRequest(first.key);
  expect((await scriptRequestIdentity(workspace, ["same content"])).correlationId).not.toBe(
    first.correlationId,
  );
});
it("rejects a corrupted persisted identity instead of silently paying again", async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => "corrupted", setItem: vi.fn() });
  await expect(scriptRequestIdentity(crypto.randomUUID(), ["content"])).rejects.toThrow(
    "identity is invalid",
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefClient } from "./client";
import { brief, capability, channelId, runId, setupStub, workspaceId } from "./setup.fixture";
import { BriefInputSchema } from "../../../../packages/contracts/src/channel-brief";
const input = (): ReturnType<typeof BriefInputSchema.parse> =>
  BriefInputSchema.parse(
    Object.fromEntries(
      Object.entries(brief).filter(
        ([key]) => !["id", "workspaceId", "channelId", "schemaVersion", "version"].includes(key),
      ),
    ),
  );
afterEach(() => vi.unstubAllGlobals());
describe("V7 HTTP ports", () => {
  it("uses V1 contract responses for Briefs, capabilities and queued runs", async () => {
    const stub = setupStub();
    const client = new BriefClient(workspaceId, stub.fetch);
    expect(await client.briefs(channelId)).toEqual([brief]);
    expect((await client.save(channelId, input())).version).toBe(2);
    expect(await client.createChannel("Science")).toBe(channelId);
    expect(await client.capabilities()).toEqual([capability]);
    expect(await client.queue(brief, "once")).toEqual({ id: runId });
    expect(await client.eligibility(channelId)).toBe(false);
    stub.approved = 10;
    expect(await client.eligibility(channelId)).toBe(true);
  });
  it("binds the browser fetch receiver when using the default transport", async () => {
    vi.stubGlobal("fetch", function (this: unknown): Promise<Response> {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ gemini: false, xai: false }));
    });
    expect(await new BriefClient(workspaceId).keys()).toEqual({ gemini: false, xai: false });
  });
  it("sends the run idempotency and immutable Brief ID", async () => {
    let sent: RequestInit | undefined;
    const stub = setupStub();
    const client = new BriefClient(workspaceId, async (url, init) => {
      sent = init;
      return stub.fetch(url, init);
    });
    await client.queue(brief, "stable-key");
    expect(JSON.parse(String(sent?.body))).toEqual({
      workspaceId,
      channelBriefId: brief.id,
      idempotencyKey: "stable-key",
    });
  });
  it("returns only key configuration flags and never reads a key-write response", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const json = vi.fn(() => {
      throw new Error("must not read key response");
    });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json });
    const client = new BriefClient(workspaceId, fetcher);
    await client.saveKey("gemini", " fixture-secret ");
    expect(fetcher).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({ key: " fixture-secret " }),
      }),
    );
    expect(json).not.toHaveBeenCalled();
    await expect(client.saveKey("xai", " ")).rejects.toThrow("Enter");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
    const stub = setupStub();
    const safe = new BriefClient(workspaceId, stub.fetch);
    expect(await safe.keys()).toEqual({ gemini: false, xai: false });
    await safe.saveKey("xai", "fixture-secret");
    expect(await safe.keys()).toEqual({ gemini: false, xai: true });
  });
  it.each([403, 500])("does not propagate secret-bearing error bodies (%s)", async (status) => {
    const client = new BriefClient(workspaceId, async () =>
      Response.json({ message: "fixture-secret" }, { status }),
    );
    await expect(client.saveKey("gemini", "fixture-secret")).rejects.not.toThrow("fixture-secret");
  });
  it("rejects malformed and cross-workspace responses", async () => {
    const value = (data: unknown): BriefClient =>
      new BriefClient(workspaceId, async () => Response.json(data));
    await expect(value({}).briefs(channelId)).rejects.toThrow("Invalid Brief response");
    await expect(value([{ ...brief, workspaceId: channelId }]).briefs(channelId)).rejects.toThrow(
      "scope",
    );
    await expect(value([{ ...brief, channelId: workspaceId }]).briefs(channelId)).rejects.toThrow(
      "scope",
    );
    await expect(value({}).createChannel("Science")).rejects.toThrow("channel response");
    await expect(value({}).capabilities()).rejects.toThrow("provider response");
    await expect(value([{ ...capability, workspaceId: channelId }]).capabilities()).rejects.toThrow(
      "scope",
    );
    for (const data of [null, {}, { approvedShorts: -1 }, { approvedShorts: 1.5 }])
      await expect(value(data).eligibility(channelId)).rejects.toThrow("approval count");
    for (const data of [
      null,
      {},
      { gemini: true, xai: false, key: "fixture-secret" },
      { gemini: "secret", xai: false },
    ])
      await expect(value(data).keys()).rejects.toThrow("key status");
    const stub = setupStub();
    stub.fail = true;
    await expect(new BriefClient(workspaceId, stub.fetch).keys()).rejects.toThrow("unavailable");
  });
});

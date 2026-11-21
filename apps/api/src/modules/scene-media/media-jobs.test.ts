import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaJobPort } from "@reelforge/ai-providers";
import { ProviderFailure } from "@reelforge/ai-providers";
import { MediaJobs } from "./media-jobs.js";
import { MediaAccess } from "./media-access.js";
import type { MediaAccounts } from "./media-accounts.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
const context: Context = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "user",
  role: "OWNER",
};
const run = { id: "22222222-2222-4222-8222-222222222222" } as Run;
const body = Buffer.from("fixture-image"),
  hash = createHash("sha256").update(body).digest("hex");
function harness(): {
  jobs: MediaJobs;
  state: { step: Record<string, unknown> | null };
  port: MediaJobPort<object>;
  paid: { finish: ReturnType<typeof vi.fn> };
  account: {
    begin: ReturnType<typeof vi.fn>;
    reserve: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    reconcilePending: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    cancelUndispatched: ReturnType<typeof vi.fn>;
  };
} {
  const state: { step: Record<string, unknown> | null } = { step: null };
  const db = {
    videoRunStep: {
      findFirst: vi.fn(async () => state.step),
      findFirstOrThrow: vi.fn(async () => state.step),
      updateMany: vi.fn(async ({ data }: { data: object }) => {
        state.step = { ...state.step, ...data };
        return { count: 1 };
      }),
    },
  };
  const paid = {
    finish: vi.fn(),
    recordJob: vi.fn(),
    jobReceipt: vi.fn().mockResolvedValue(null),
    finalizeJobFailure: vi.fn(),
  };
  const access = {
    gate: vi.fn(),
    boundary: { check: vi.fn() },
    paid,
    runs: {
      store: { scoped: () => db, get: async () => run },
      attachJob: async (_ctx: Context, _step: unknown, providerJobId: string) => {
        await db.videoRunStep.updateMany({ data: { providerJobId, state: "WAITING_EXTERNAL" } });
        return state.step;
      },
    },
    artifacts: {
      put: async () => ({
        kind: "keyframes",
        objectKey: `runs/draft/1900000000000/${hash}`,
        checksumSha256: hash,
        contentType: "image/png",
        byteSize: body.length,
        expiresAt: "2030-03-17T17:46:40.000Z",
      }),
    },
  } as unknown as MediaAccess;
  const account = {
    abandoned: (): boolean => false,
    dispatch: async (
      _context: unknown,
      _step: unknown,
      call: () => Promise<unknown>,
    ): Promise<unknown> => call(),
    begin: vi.fn(async () => {
      state.step = {
        id: "step",
        runId: run.id,
        idempotencyKey: "once",
        costMinor: 4,
        state: "RUNNING",
        providerJobId: null,
      };
      return state.step;
    }),
    reserve: vi.fn(),
    prepare: vi.fn(async () => {
      await account.reserve();
    }),
    recoverUndispatched: vi.fn().mockResolvedValue(false),
    reconcilePending: vi.fn(async () => {
      throw new Error("RECONCILE_REQUIRED");
    }),
    cancelUndispatched: vi.fn(async () => {
      state.step = { ...state.step, state: "CANCELLED", finishedAt: new Date() };
      await paid.finish(context, state.step, false, 0);
    }),
    complete: vi.fn(async (_context: unknown, _step: unknown, output: unknown) => {
      state.step = { ...state.step, state: "SUCCEEDED", output: { result: output } };
    }),
  };
  const storage = { getObject: vi.fn().mockResolvedValue(body) } as unknown as StoragePort;
  const port: MediaJobPort<object> = {
    submit: vi.fn().mockResolvedValue({ providerJobId: "fixture-job" }),
    poll: vi.fn().mockResolvedValue("running"),
    fetch: vi.fn().mockResolvedValue({
      objectKey: "fixture",
      checksumSha256: hash,
      byteSize: body.length,
      mimeType: "image/png",
      durationSeconds: 0,
      width: 720,
      height: 1280,
      fps: 0,
      billedSeconds: null,
    }),
  };
  return {
    jobs: new MediaJobs(access, account as unknown as MediaAccounts, storage),
    state,
    port,
    paid,
    account,
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("V5 durable async media jobs", () => {
  it("stores job ids before polling and never repeats a paid submit on resume", async () => {
    const h = harness();
    expect(
      await h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).toBeNull();
    vi.mocked(h.port.poll).mockResolvedValue("succeeded");
    const result = await h.jobs.tick(
      context,
      run,
      "keyframe:0",
      h.port,
      {},
      4,
      "configured-model",
      "v2",
    );
    expect(result?.receipt.providerJobId).toBe("fixture-job");
    expect(
      await h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).toEqual(result);
    expect(h.port.submit).toHaveBeenCalledOnce();
    expect(h.account.reserve).toHaveBeenCalledOnce();
  });
  it("does not resubmit an unknown dispatch and reports terminal provider results", async () => {
    const h = harness();
    h.state.step = { id: "uncertain", state: "RUNNING", providerJobId: null };
    await expect(
      h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).rejects.toThrow("RECONCILE_REQUIRED");
    expect(h.port.submit).not.toHaveBeenCalled();
    h.state.step = { id: "known", state: "WAITING_EXTERNAL", providerJobId: "known" };
    vi.mocked(h.port.poll).mockResolvedValue("refused");
    await expect(
      h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).rejects.toThrow("PROVIDER_REFUSED");
  });
  it.each(["narration", "music"])(
    "drains an admitted %s job using its saved identity and model",
    async (key) => {
      const h = harness();
      const now = new Date();
      const step: Step = {
        id: "accepted-step",
        runId: run.id,
        workspaceId: context.workspaceId,
        attempt: 1,
        idempotencyKey: "admitted",
        providerId: "gemini",
        schemaVersion: "1.0",
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: null,
        output: null,
        error: null,
        artifacts: [],
        key: `media:${key}`,
        state: "WAITING_EXTERNAL",
        providerJobId: "accepted",
        costMinor: 4,
        input: { modelId: "admitted-model" },
      };
      vi.mocked(h.port.poll).mockResolvedValue("succeeded");
      await h.jobs.drainAudio(context, step, h.port, 30);
      expect(h.port.fetch).toHaveBeenCalledWith("accepted", 30);
      expect(h.port.submit).not.toHaveBeenCalled();
      expect(h.account.complete).toHaveBeenCalledWith(
        context,
        step,
        expect.objectContaining({
          receipt: expect.objectContaining({
            key,
            modelId: "admitted-model",
            providerJobId: "accepted",
          }),
        }),
      );
    },
  );
  it("records proven non-dispatch without inventing successful output and verifies checksums", async () => {
    const h = harness();
    vi.mocked(h.port.submit).mockRejectedValue(new ProviderFailure("OUTAGE", false));
    await expect(
      h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).rejects.toBeInstanceOf(ProviderFailure);
    expect(h.account.cancelUndispatched).toHaveBeenCalledOnce();
    expect(h.paid.finish).toHaveBeenCalledWith(context, expect.anything(), false, 0);
    expect(h.state.step?.state).toBe("CANCELLED");
    await expect(
      h.jobs.tick(context, run, "keyframe:0", h.port, {}, 4, "configured-model", "v2"),
    ).rejects.toThrow("MEDIA_NOT_DISPATCHED");
    expect(h.port.submit).toHaveBeenCalledOnce();
    await expect(
      h.jobs.bytes(context, { objectKey: "fixture", checksumSha256: "0".repeat(64) }),
    ).rejects.toThrow("checksum");
  });
});

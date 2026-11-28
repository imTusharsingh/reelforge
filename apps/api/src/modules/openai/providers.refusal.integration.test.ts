import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { ProviderArtifacts } from "./provider-artifacts.js";
import { artifact, shot } from "./provider.fixture.js";
import { fixtureRuntime } from "./providers.runtime.fixture.js";

const jobId = "gemini-original";
const refs = { resolve: async (): Promise<[]> => [] };
const accepted = (): Response => Response.json({ id: jobId, status: "queued" });
const refused = (): Response =>
  Response.json({ id: jobId, status: "refused", usage: { billed_seconds: 3.3 } });
const completed = (): Response =>
  Response.json({
    id: jobId,
    status: "completed",
    usage: { billed_seconds: 0.5 },
    steps: [
      { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "YWJj" }] },
    ],
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!process.env.DATABASE_URL)("routed Gemini refusal billing", () => {
  const fixture = runsFixture();

  it.each(["POST", "poll"])(
    "posts the original bill before a paid rewrite on %s refusal",
    async (method) => {
      const t = await fixture.tenant();
      const { workspaceId, channelId } = t.run;
      const runtime = fixtureRuntime(t, new Map());
      const router = await runtime.router(
        t.context,
        channelId,
        refs,
        async (spec) => spec,
        async () => undefined,
      );
      const fetcher = vi.spyOn(globalThis, "fetch");
      if (method === "poll") fetcher.mockResolvedValueOnce(accepted());
      fetcher
        .mockResolvedValueOnce(refused())
        .mockImplementationOnce(async (_url, init) => {
          expect(init?.method).toBe("POST");
          const original = await t.db.providerRequest.findFirstOrThrow({
            where: { workspaceId, errorCode: "REFUSED" },
          });
          expect(original.estimatedCost?.toString()).toBe("0.208512");
          expect(original.actualCost?.toString()).toBe("0.229364");
          expect(original).toMatchObject({
            status: "FAILED",
            usage: { seconds: 3.3 },
            responseMetadata: { providerJobId: jobId },
          });
          expect(
            await t.db.usageReservation.findFirstOrThrow({
              where: { workspaceId, correlationId: original.correlationId },
            }),
          ).toMatchObject({ status: "COMMITTED", committedMinor: 23n });
          expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(44);
          return Response.json({ id: "gemini-rewrite", status: "queued" });
        })
        .mockRejectedValue(new Error("unexpected offline request"));

      const submitted = await router.submit(
        { ...shot, workspaceId, durationSeconds: 3 },
        "first-refusal",
        ["gemini"],
      );
      const replacement = method === "poll" ? (await router.poll(submitted)).job : submitted;
      expect(replacement).toMatchObject({ providerJobId: "gemini-rewrite", rewrites: 1 });
      expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(
        method === "poll" ? ["POST", "GET", "POST"] : ["POST", "POST"],
      );
    },
  );

  it.each(["delivery first", "refusal first"])(
    "keeps the delivered clip and never POSTs a rewrite: %s",
    async (order) => {
      const t = await fixture.tenant();
      const { workspaceId, channelId } = t.run;
      const runtime = fixtureRuntime(t, new Map());
      const { omni } = await runtime.ports(t.context, refs);
      const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(accepted());
      if (order === "delivery first")
        fetcher.mockResolvedValueOnce(completed()).mockResolvedValueOnce(refused());
      else fetcher.mockResolvedValueOnce(refused()).mockResolvedValueOnce(completed());
      fetcher.mockRejectedValue(new Error("unexpected offline request"));
      vi.spyOn(ProviderArtifacts.prototype, "save").mockResolvedValue(artifact);
      const key = "conflicting-receipts";
      const deliver = (): Promise<void> =>
        runtime.reconcile(workspaceId, `${key}:gemini`, omni, jobId);
      const rewrite = vi.fn(async (spec: typeof shot) => {
        // A refused poll begins a rewrite, then delivery wins before the new paid admission.
        await deliver();
        return spec;
      });
      const router = await runtime.router(
        t.context,
        channelId,
        refs,
        rewrite,
        async () => undefined,
      );
      const job = await router.submit({ ...shot, workspaceId, durationSeconds: 3 }, key, [
        "gemini",
      ]);
      if (order === "delivery first") await deliver();
      await expect(router.poll(job)).rejects.toThrow(/refusal requires|rewrite requires/);
      expect(rewrite).toHaveBeenCalledTimes(order === "delivery first" ? 0 : 1);
      const row = await t.db.providerRequest.findFirstOrThrow({ where: { workspaceId } });
      expect(row.actualCost?.toString()).toBe("0.229364");
      expect(row).toMatchObject({
        status: "SUCCEEDED",
        errorCode: null,
        usage: { seconds: 3.3 },
        responseMetadata: {
          objectKey: artifact.objectKey,
          checksumSha256: artifact.checksumSha256,
        },
      });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
      expect(await t.db.providerRequest.count({ where: { workspaceId } })).toBe(1);
      expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "GET"]);
    },
  );
});

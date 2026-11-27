import { randomUUID } from "node:crypto";
import { defaultBrief } from "@reelforge/contracts";
import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { alignmentLanguage } from "../composition/alignment-language.js";
import type { RunsArtifacts } from "./runs.artifacts.js";
import type { RunsStore } from "./runs.store.js";
import type { Context } from "./runs.types.js";
import { RunsService } from "./runs.service.js";

const runtime = vi.hoisted(() => ({ assertLanguage: vi.fn() }));
vi.mock("../composition/media-runtime.js", () => ({ mediaRuntimeGate: runtime }));

function fixture(language: string): {
  runs: RunsService;
  context: Context;
  id: string;
  findFirst: Mock;
  count: Mock;
  transaction: Mock;
} {
  const id = randomUUID();
  const workspaceId = randomUUID();
  const channelId = randomUUID();
  const scope = { id, workspaceId, channelId, version: 1 };
  const document = {
    ...defaultBrief({
      niche: "Botany",
      audience: "Everyone",
      language,
      voiceId: "Kore",
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
    }),
    ...scope,
    schemaVersion: "1.1",
  };
  const findFirst = vi.fn().mockResolvedValue(null);
  const count = vi.fn().mockResolvedValue(0);
  const transaction = vi.fn().mockRejectedValue(new Error("Run creation reached"));
  const runs = new RunsService(
    {
      scoped: () => ({
        channelBrief: { findFirst: vi.fn().mockResolvedValue({ ...scope, document }) },
        videoRun: { findFirst, count },
      }),
      db: { $transaction: transaction },
    } as unknown as RunsStore,
    {} as RunsArtifacts,
  );
  const context: Context = { workspaceId, userId: randomUUID(), role: "OWNER" };
  return { runs, context, id, findFirst, count, transaction };
}

beforeEach(() => {
  runtime.assertLanguage.mockImplementation((read: () => unknown) =>
    alignmentLanguage(read(), new Set(["eng", "ita"])),
  );
});

it("rejects an unsupported narration before opening a new run transaction", async () => {
  const { runs, context, id, count, transaction } = fixture("Not a language");
  await expect(runs.create(context, id, "new-run")).rejects.toMatchObject({
    response: { code: "NARRATION_LANGUAGE_UNSUPPORTED" },
  });
  expect(count).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
});

it("keeps idempotent replay usable even when a pinned voice is no longer available", async () => {
  const { runs, context, id, findFirst, transaction } = fixture("Spanish");
  const existing = { id: "existing-run", channelBriefId: id };
  findFirst.mockResolvedValueOnce(existing);
  await expect(runs.create(context, id, "existing")).resolves.toBe(existing);
  expect(transaction).not.toHaveBeenCalled();
});

it("lets Italian reach ordinary run creation when its local voice is available", async () => {
  const { runs, context, id, transaction } = fixture("Italian");
  await expect(runs.create(context, id, "new-run")).rejects.toThrow("Run creation reached");
  expect(transaction).toHaveBeenCalledOnce();
});

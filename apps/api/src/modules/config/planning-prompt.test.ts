import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PlanningPromptService } from "./planning-prompt.service.js";
import type { Database } from "../identity/identity.types.js";
import type { PromptService } from "./prompt.service.js";
import { context, planningFixture } from "../script/planning.fixture.js";
import { jsonFingerprint } from "@reelforge/config-engine";
import { planningPrompts } from "./planning-prompts.js";
describe("V4 prompt versions", () => {
  it.each(["scriptwriter", "director", "art-director"] as const)(
    "adds immutable v2 %s and captures exact M05 version",
    async (role) => {
      const templateId = randomUUID();
      const versionId = randomUUID();
      const body = {
        ...planningPrompts[role],
        variables: [],
        allowedAdditionSections: ["instructions"],
      };
      const upsert = vi.fn().mockResolvedValue({
        id: versionId,
        checksumSha256: jsonFingerprint(body),
        status: "PUBLISHED",
      });
      const db = {
        promptTemplate: {
          findFirst: vi.fn().mockResolvedValue({ id: templateId, key: `v1.${role}` }),
        },
        promptTemplateVersion: { upsert },
      };
      const capture = vi.fn().mockResolvedValue({
        configSnapshot: { id: randomUUID() },
        promptBundleSnapshot: {
          id: randomUUID(),
          templateVersionId: versionId,
          fingerprintSha256: "a".repeat(64),
        },
        bundle: { renderedText: "compiled v2" },
      });
      const service = new PlanningPromptService(
        db as unknown as Database,
        { capture } as unknown as PromptService,
      );
      const channel = planningFixture().brief.channelId;
      const result = await service.capture(context, channel, role);
      expect(result.receipt).toMatchObject({ role, version: 2, templateVersionId: versionId });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: {}, create: expect.objectContaining({ version: 2 }) }),
      );
      expect(capture).toHaveBeenCalledWith(context, {
        channelId: channel,
        template: { templateKey: `v1.${role}`, version: 2 },
      });
    },
  );
  it("rejects missing seeds and conflicts without overwriting", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue({ checksumSha256: "bad", status: "PUBLISHED" });
    const service = new PlanningPromptService(
      { promptTemplate: { findFirst }, promptTemplateVersion: { upsert } } as unknown as Database,
      {} as PromptService,
    );
    await expect(service.capture(context, randomUUID(), "director")).rejects.toThrow(
      "seed missing",
    );
    findFirst.mockResolvedValue({ id: randomUUID(), key: "v1.director" });
    await expect(service.capture(context, randomUUID(), "director")).rejects.toThrow("conflicts");
  });
});

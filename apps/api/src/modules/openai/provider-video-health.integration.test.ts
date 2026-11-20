import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { videoHealth } from "@reelforge/ai-providers";
import { ProviderVideoHealth } from "./provider-video-health.js";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("durable video router observations", () => {
  it("publishes an open circuit and actual acceptance to a separate API connection", async () => {
    const workerDb = createDatabaseClient(url!);
    const apiDb = createDatabaseClient(url!);
    const workspaceId = randomUUID();
    try {
      await workerDb.workspace.create({ data: { id: workspaceId, name: "Video health test" } });
      const worker = new ProviderVideoHealth(workerDb);
      const api = new ProviderVideoHealth(apiDb);
      await Promise.all(
        Array.from({ length: 3 }, () => worker.record(workspaceId, "gemini", "OUTAGE")),
      );
      const opened = (await api.state(workspaceId)).get("gemini");
      expect(opened).toMatchObject({ calls: 3, accepted: 0, failures: 3 });
      expect(videoHealth("HEALTHY", opened, Date.now())).toBe("UNAVAILABLE");
      expect((await api.state(randomUUID())).size).toBe(0);
      await worker.record(workspaceId, "gemini", "ACCEPTED");
      const accepted = (await api.state(workspaceId)).get("gemini");
      expect(accepted).toEqual({ calls: 4, accepted: 1, failures: 0, openUntil: 0 });
      expect(videoHealth("HEALTHY", accepted, Date.now())).toBe("DEGRADED");
      expect(videoHealth("NOT_CONFIGURED", accepted, Date.now())).toBe("NOT_CONFIGURED");
    } finally {
      await workerDb.workspace.deleteMany({ where: { id: workspaceId } });
      await Promise.all([apiDb.$disconnect(), workerDb.$disconnect()]);
    }
  });
});

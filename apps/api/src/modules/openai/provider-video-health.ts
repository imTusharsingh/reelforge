import { Inject, Injectable, Logger } from "@nestjs/common";
import type { VideoOutcome, VideoRoutingState } from "@reelforge/ai-providers";
import type { Database } from "../identity/identity.types.js";

@Injectable()
export class ProviderVideoHealth {
  private readonly log = new Logger(ProviderVideoHealth.name);
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async state(workspaceId: string): Promise<VideoRoutingState> {
    const rows = await this.db.providerVideoHealth.findMany({ where: { workspaceId } });
    return new Map(
      rows.map((row) => [
        row.providerId,
        {
          calls: row.calls,
          accepted: row.accepted,
          failures: row.failures,
          openUntil: row.openUntil?.getTime() ?? 0,
        },
      ]),
    );
  }

  /** Atomic increments preserve concurrent worker outcomes across API and worker restarts. */
  public async record(
    workspaceId: string,
    providerId: string,
    outcome: VideoOutcome,
  ): Promise<void> {
    const accepted = Number(outcome === "ACCEPTED");
    const outage = Number(outcome === "OUTAGE");
    try {
      await this.db.$executeRaw`
        INSERT INTO provider_video_health (workspace_id, provider_id, calls, accepted, failures)
        VALUES (${workspaceId}::uuid, ${providerId}, 1, ${accepted}, ${outage})
        ON CONFLICT (workspace_id, provider_id) DO UPDATE SET
          calls = provider_video_health.calls + 1,
          accepted = provider_video_health.accepted + EXCLUDED.accepted,
          failures = CASE WHEN EXCLUDED.accepted = 1 THEN 0
            ELSE provider_video_health.failures + EXCLUDED.failures END,
          open_until = CASE WHEN EXCLUDED.accepted = 1 THEN NULL
            WHEN EXCLUDED.failures = 1 AND provider_video_health.failures + 1 >= 3
            THEN CURRENT_TIMESTAMP + INTERVAL '60 seconds' ELSE provider_video_health.open_until END
      `;
    } catch {
      // A health telemetry failure cannot turn a successful paid operation into a retry.
      this.log.warn("Could not record video provider outcome");
    }
  }
}

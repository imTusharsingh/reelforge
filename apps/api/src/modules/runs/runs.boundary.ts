import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { EMERGENCY_STOP_PORT, type EmergencyStopPort } from "../admin/emergency-stop.types.js";
import { RunsService } from "./runs.service.js";
import type { Context, Run } from "./runs.types.js";

@Injectable()
export class RunsBoundary {
  public constructor(
    @Inject(EMERGENCY_STOP_PORT) private readonly stop: EmergencyStopPort,
    private readonly runs: RunsService,
  ) {}
  public async check(context: Context, run: Run): Promise<void> {
    const decision = await this.stop.check({
      workspaceId: context.workspaceId,
      channelId: run.channelId,
    });
    if (!decision.stopped) return;
    const result = await this.runs.store.mutate(context, run.id, "emergency_stop", async (db) => {
      await db.videoRun.updateMany({
        where: { id: run.id },
        data: { pauseReason: "EMERGENCY_STOP" },
      });
      return { value: null, payload: { reason: "EMERGENCY_STOP" } };
    });
    await this.runs.events?.publish(result.event);
    throw new ConflictException({ code: "EMERGENCY_STOP", message: "Run halted at step boundary" });
  }
}

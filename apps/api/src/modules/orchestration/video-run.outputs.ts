import { Injectable } from "@nestjs/common";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { RunsStore } from "../runs/runs.store.js";
import { json, type Artifact, type Context, type Run } from "../runs/runs.types.js";

/** V3 emits an honest fixture manifest; V5 replaces assembly with real media. */
@Injectable()
export class RunOutputs {
  public constructor(
    private readonly artifacts: RunsArtifacts,
    private readonly store: RunsStore,
  ) {}
  public async assembly(context: Context, run: Run): Promise<Artifact[]> {
    const steps = await this.store
      .scoped(context)
      .videoRunStep.findMany({ where: { runId: run.id } });
    const manifest = {
      schemaVersion: "1.0",
      stub: true,
      runId: run.id,
      briefId: run.channelBriefId,
      briefVersion: run.channelBriefVersion,
      steps: steps.map((s) => ({
        key: s.key,
        attempt: s.attempt,
        providerId: s.providerId,
        providerJobId: s.providerJobId,
        costMinor: s.costMinor,
        input: s.input,
        artifacts: this.artifacts.descriptors(s.output),
      })),
    };
    const body = Buffer.from(JSON.stringify(json(manifest)));
    return [await this.artifacts.put(context, "manifest", body, "application/json")];
  }
}

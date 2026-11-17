import { Injectable, NotFoundException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import { RunsService } from "../runs/runs.service.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
@Injectable()
export class MediaAccess {
  public constructor(public readonly modules: ModuleRef) {}
  public gate(): void {
    if (!pipelineV2Enabled()) throw new NotFoundException("pipeline.v2 is disabled");
  }
  public get runs(): RunsService {
    this.gate();
    return this.modules.get(RunsService, { strict: false });
  }
  public get paid(): RunPaidCalls {
    this.gate();
    return this.modules.get(RunPaidCalls, { strict: false });
  }
  public get artifacts(): RunsArtifacts {
    this.gate();
    return this.modules.get(RunsArtifacts, { strict: false });
  }
  public get boundary(): RunsBoundary {
    this.gate();
    return this.modules.get(RunsBoundary, { strict: false });
  }
}

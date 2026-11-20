import { Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { RunsService } from "../runs/runs.service.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
@Injectable()
export class MediaAccess {
  public constructor(public readonly modules: ModuleRef) {}
  public get runs(): RunsService {
    return this.modules.get(RunsService, { strict: false });
  }
  public get paid(): RunPaidCalls {
    return this.modules.get(RunPaidCalls, { strict: false });
  }
  public get artifacts(): RunsArtifacts {
    return this.modules.get(RunsArtifacts, { strict: false });
  }
  public get boundary(): RunsBoundary {
    return this.modules.get(RunsBoundary, { strict: false });
  }
}

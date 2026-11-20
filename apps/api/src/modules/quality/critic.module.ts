import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { MediaAssembly } from "../composition/media-assembly.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { CriticEvidence } from "./critic-evidence.js";
import { CriticStep } from "./critic.step.js";
import { CriticPipeline } from "./critic.pipeline.js";
import { MediaProbe } from "./media-probe.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
import { RunCritic } from "./run-critic.js";

@Module({
  providers: [
    CriticPipeline,
    MediaProbe,
    SpawnProcessRunner,
    {
      provide: CriticStep,
      inject: [ModuleRef, CriticPipeline, MediaProbe],
      useFactory: (modules: ModuleRef, pipeline: CriticPipeline, probe: MediaProbe): CriticStep =>
        new CriticStep(
          modules,
          () =>
            new RunCritic(
              modules.get(MediaAccess, { strict: false }),
              modules.get(MediaAccounts, { strict: false }),
              modules.get(MediaPorts, { strict: false }),
              new CriticEvidence(
                modules.get(MediaAssembly, { strict: false }),
                modules.get(MediaJobs, { strict: false }),
                modules.get(MediaPlanning, { strict: false }),
                probe,
              ),
              pipeline,
            ),
        ),
    },
  ],
})
export class CriticModule {}

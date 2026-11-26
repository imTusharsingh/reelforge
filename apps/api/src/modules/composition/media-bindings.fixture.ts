import { randomUUID } from "node:crypto";
import { ModuleRef } from "@nestjs/core";
import type { PlanningPromptReceipt } from "@reelforge/contracts";
import type { Tenant } from "../runs/runs.fixture.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { RunsControl } from "../runs/runs.control.js";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { ProvidersRuntime } from "../openai/providers.runtime.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { PlanningCharacterService } from "../character/planning-character.service.js";
import { AssetService } from "../asset/asset.service.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { MediaFrames } from "../scene-media/media-frames.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { MediaBindings } from "../scene-media/media-pipeline.module.js";
import { MediaAssembly } from "./media-assembly.js";
import { MediaRenderer } from "./media-render.js";
import { SpawnProcessRunner } from "./composition.engine.js";
import type { fakeMediaPorts } from "./media-recovery.fixture.js";

export function bindMedia(
  t: Tenant,
  native: ReturnType<typeof fakeMediaPorts>,
): {
  assembly: MediaAssembly;
  jobs: MediaJobs;
  renderer: MediaRenderer;
  access: MediaAccess;
  accounts: MediaAccounts;
  ports: MediaPorts;
  planning: MediaPlanning;
} {
  const paid = new RunPaidCalls(new UsageBudgetService(t.db, () => new Date()), t.store);
  const mapping = new Map<unknown, unknown>([
    [RunsService, t.runs],
    [RunsControl, t.control],
    [RunPaidCalls, paid],
    [RunsArtifacts, t.artifacts],
    [RunsBoundary, new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs)],
    [RunGeneration, t.generation],
    [RunPlanning, t.planning],
    [RunOutputs, t.outputs],
    [AssetService, new AssetService(t.db, t.storage)],
    [ReferenceLibraryService, new ReferenceLibraryService(t.db)],
    [PlanningReferenceAssetsService, new PlanningReferenceAssetsService(t.db, t.storage)],
    [PlanningCharacterService, new PlanningCharacterService(t.db)],
    [
      PlanningPromptService,
      {
        capture: async (
          _context: unknown,
          _channel: unknown,
          role: PlanningPromptReceipt["role"],
        ): Promise<{ prompt: string; receipt: PlanningPromptReceipt }> => ({
          prompt: `fixture ${role}`,
          receipt: {
            role,
            version: 2,
            templateVersionId: randomUUID(),
            promptSnapshotId: randomUUID(),
            configSnapshotId: randomUUID(),
            fingerprintSha256: "a".repeat(64),
          },
        }),
        format: async (): Promise<{ key: string }> => ({ key: "explainer" }),
      },
    ],
  ]);
  const access = new MediaAccess({
    get: (token: unknown): unknown => mapping.get(token),
  } as unknown as ModuleRef);
  const accounts = new MediaAccounts(access),
    jobs = new MediaJobs(access, accounts, t.storage);
  const ports = new MediaPorts(
    access,
    {
      ports: async () => ({ ...native, assertKey: (): void => {} }),
      videoState: () => new Map(),
      videoOutcome: () => async (): Promise<void> => {},
    } as unknown as ProvidersRuntime,
    jobs,
  );
  const frames = new MediaFrames(access, jobs, ports, new SpawnProcessRunner()),
    planning = new MediaPlanning(access, accounts, jobs, ports);
  const aligner = {
    alignPhrases: async (
      _path: string,
      text: string,
    ): Promise<{ text: string; start: number; end: number }[]> => [{ text, start: 0, end: 20 }],
    align: async (
      _path: string,
      text: string,
    ): Promise<{ text: string; start: number; end: number }[]> =>
      text
        .split(/\s+/)
        .map((word, index) => ({ text: word, start: index * 0.3, end: index * 0.3 + 0.25 })),
  };
  const renderer = new MediaRenderer(t.storage, new SpawnProcessRunner(), aligner);
  const assembly = new MediaAssembly(access, jobs, ports, planning, renderer);
  mapping.set(MediaAssembly, assembly);
  const binding = new MediaBindings(access, accounts, frames, ports, jobs, planning, assembly);
  binding.onModuleInit();
  return { assembly, jobs, renderer, access, accounts, ports, planning };
}

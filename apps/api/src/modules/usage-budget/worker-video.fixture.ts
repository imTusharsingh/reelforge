import { vi } from "vitest";
import { type VideoGenPort } from "@reelforge/ai-providers";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { generating, type Tenant } from "../runs/runs.fixture.js";
import type { Run, RunJob, Step } from "../runs/runs.types.js";
import type { VideoGenPort as WorkerVideoPort } from "../orchestration/video-run.handlers.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";

export async function workerVideo(
  t: Tenant,
  primary?: (port: VideoGenPort) => VideoGenPort,
): Promise<{
  run: Run;
  step: Step;
  job: RunJob;
  native: VideoGenPort;
}> {
  const run = await generating(t);
  const native = fakeMediaPorts(
    run.workspaceId,
    t.storage,
    {
      clip: Buffer.from("fixture-clip"),
      image: Buffer.alloc(0),
      audio: Buffer.alloc(0),
    },
    [],
  );
  if (primary) native.omni = primary(native.omni);
  else
    vi.spyOn(native.omni, "poll").mockResolvedValueOnce("running").mockResolvedValue("succeeded");
  const bindings = bindMedia(t, native);
  t.generation.resolvePorts = async (): Promise<{
    primary: WorkerVideoPort;
    fallback: WorkerVideoPort;
  }> => ({
    primary: new RoutedMediaVideo(native.omni, bindings.jobs, t.context, run),
    fallback: new RoutedMediaVideo(native.grok, bindings.jobs, t.context, run),
  });
  const step = await t.db.videoRunStep.findFirstOrThrow({
    where: { runId: run.id, key: "shot-0" },
  });
  return { run, step, job: t.runs.job(t.context, run.id, step.id), native: native.omni };
}

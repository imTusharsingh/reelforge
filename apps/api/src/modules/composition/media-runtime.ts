import { execFile } from "node:child_process";
import { promisify } from "node:util";

type MediaExecutable = "ffmpeg" | "ffprobe";
export function mediaExecutable(
  name: MediaExecutable,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (name === "ffmpeg" ? env.FFMPEG_PATH : env.FFPROBE_PATH)?.trim() || name;
}

export function alignmentPython(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALIGNMENT_PYTHON_PATH?.trim() || "python3";
}

function signature(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    alignmentPython(env),
    mediaExecutable("ffmpeg", env),
    mediaExecutable("ffprobe", env),
    env.PATH,
    env.PYTHONPATH,
    env.ESPEAK_DATA_PATH,
  ]);
}

type Probe = (executable: string, args: string[]) => Promise<Buffer>;
const probe: Probe = async (executable, args) => {
  const { stdout } = await promisify(execFile)(executable, args, {
    encoding: "buffer",
    timeout: 5000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

async function verify(
  label: string,
  execute: () => Promise<boolean>,
  instructions: string,
): Promise<void> {
  try {
    if (await execute()) return;
  } catch {
    // Keep raw subprocess output (including environment information) out of errors.
  }
  throw new Error(`Local media runtime is unavailable: ${label}. ${instructions}`);
}

export function createMediaRuntimeGate(run: Probe = probe): {
  activate: (env?: NodeJS.ProcessEnv) => Promise<void>;
  assertReady: (env?: NodeJS.ProcessEnv) => void;
} {
  // The production entry points explicitly activate this guard before Nest boots.
  // Isolated test harnesses that inject fake ports do not activate it.
  let state: { ready: string | null } | undefined;
  return {
    async activate(env = process.env): Promise<void> {
      const pending: { ready: string | null } = { ready: null };
      state = pending;
      const checkedSignature = signature(env);
      const ffmpeg = mediaExecutable("ffmpeg", env);
      const ffprobe = mediaExecutable("ffprobe", env);
      const python = alignmentPython(env);
      if (/[|=]/u.test(ffmpeg) || /[|=]/u.test(ffprobe))
        throw new Error("Use FFMPEG_PATH and FFPROBE_PATH without | or = in aeneas configuration.");
      await verify(
        "FFmpeg with the subtitles filter",
        async () =>
          /\bV->V\s+Render text subtitles/u.test(
            (await run(ffmpeg, ["-hide_banner", "-filters"])).toString(),
          ),
        "Install FFmpeg with libass and check FFMPEG_PATH.",
      );
      await verify(
        "FFprobe",
        async () => (await run(ffprobe, ["-version"])).toString().startsWith("ffprobe version "),
        "Install FFprobe and check FFPROBE_PATH.",
      );
      await verify(
        "aeneas command-line module",
        async () => {
          await run(python, ["-c", "from aeneas.tools.execute_task import ExecuteTaskCLI"]);
          return true;
        },
        "Install aeneas==1.7.3.0 in the Python selected by ALIGNMENT_PYTHON_PATH.",
      );
      await verify(
        "eSpeak reference speech and language data",
        async () => {
          const wav = await run("espeak", ["-v", "en", "--stdout", "ReelForge"]);
          return (
            wav.length > 44 &&
            wav.toString("ascii", 0, 4) === "RIFF" &&
            wav.toString("ascii", 8, 12) === "WAVE"
          );
        },
        "Install eSpeak and its voice data, and put espeak on PATH.",
      );
      pending.ready = checkedSignature;
    },
    assertReady(env = process.env): void {
      if (state && state.ready !== signature(env))
        throw new Error(
          "Local media runtime has not passed preflight. Restart after fixing its configuration.",
        );
    },
  };
}

export const mediaRuntimeGate = createMediaRuntimeGate();

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { alignmentLanguage } from "./alignment-language.js";

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

const languageCatalogue = [
  "import json",
  "from aeneas.tools.execute_task import ExecuteTaskCLI",
  "from aeneas.ttswrappers.espeakttswrapper import ESPEAKTTSWrapper",
  "print(json.dumps(ESPEAKTTSWrapper.LANGUAGE_TO_VOICE_CODE))",
].join("; ");

async function loadVoices(run: Probe, python: string): Promise<Map<string, string>> {
  const voices = new Map<string, string>();
  await verify(
    "aeneas command-line module",
    async () => {
      const listing: unknown = JSON.parse(
        (await run(python, ["-c", languageCatalogue])).toString(),
      );
      if (!listing || typeof listing !== "object") return false;
      for (const [code, voice] of Object.entries(listing)) {
        if (
          /^[a-z]{3}$/u.test(code) &&
          typeof voice === "string" &&
          /^[a-z0-9][a-z0-9-]*$/u.test(voice)
        )
          voices.set(code, voice);
      }
      return voices.has("eng");
    },
    "Install aeneas==1.7.3.0 in the Python selected by ALIGNMENT_PYTHON_PATH.",
  );
  return voices;
}

async function canSynthesize(run: Probe, voice: string): Promise<boolean> {
  try {
    const wav = await run("espeak", ["-v", voice, "--stdout", "ReelForge"]);
    return (
      wav.length > 44 &&
      wav.toString("ascii", 0, 4) === "RIFF" &&
      wav.toString("ascii", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  }
}

async function installedLanguages(
  run: Probe,
  catalogue: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const english = catalogue.get("eng")!;
  await verify(
    "eSpeak reference speech and language data",
    () => canSynthesize(run, english),
    "Install eSpeak and its voice data, and put espeak on PATH.",
  );
  // A mapping in the Python library is not proof that the particular voice is installed.
  // Probe each distinct voice once, outside any request or paid transaction.
  const otherVoices = [...new Set(catalogue.values())].filter((voice) => voice !== english);
  const working = new Set([english]);
  for (let i = 0; i < otherVoices.length; i += 8) {
    await Promise.all(
      otherVoices.slice(i, i + 8).map(async (voice) => {
        if (await canSynthesize(run, voice)) working.add(voice);
      }),
    );
  }
  return new Set([...catalogue].filter(([, voice]) => working.has(voice)).map(([code]) => code));
}

export function createMediaRuntimeGate(run: Probe = probe): {
  activate: (env?: NodeJS.ProcessEnv) => Promise<void>;
  assertReady: (env?: NodeJS.ProcessEnv) => void;
  assertLanguage: (language: () => unknown, env?: NodeJS.ProcessEnv) => void;
  resolveLanguage: (language: unknown, env?: NodeJS.ProcessEnv) => string;
} {
  // The production entry points explicitly activate this guard before Nest boots.
  // Isolated test harnesses that inject fake ports do not activate it.
  type Ready = { signature: string; languages: ReadonlySet<string> };
  let state: { ready: Ready | null } | undefined;
  function ready(env: NodeJS.ProcessEnv): Ready | undefined {
    if (!state) return undefined;
    if (state.ready?.signature !== signature(env))
      throw new Error(
        "Local media runtime has not passed preflight. Restart after fixing its configuration.",
      );
    return state.ready;
  }
  return {
    async activate(env = process.env): Promise<void> {
      const pending: { ready: Ready | null } = { ready: null };
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
      const languages = await installedLanguages(run, await loadVoices(run, python));
      pending.ready = { signature: checkedSignature, languages };
    },
    assertReady(env = process.env): void {
      ready(env);
    },
    assertLanguage(language, env = process.env): void {
      const checked = ready(env);
      if (checked) alignmentLanguage(language(), checked.languages);
    },
    resolveLanguage(language, env = process.env): string {
      return alignmentLanguage(language, ready(env)?.languages);
    },
  };
}

export const mediaRuntimeGate = createMediaRuntimeGate();

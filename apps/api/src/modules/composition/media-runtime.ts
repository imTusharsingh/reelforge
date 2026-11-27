import { LocalAssemblyFailure } from "./local-assembly-failure.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyAssemblyRoundTrip } from "./media-probe.js";
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
  throw new LocalAssemblyFailure(
    "MEDIA_TOOL_UNAVAILABLE",
    `Local media runtime is unavailable: ${label}. ${instructions}`,
  );
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
): Promise<Map<string, string>> {
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
  return new Map([...catalogue].filter(([, voice]) => working.has(voice)));
}

async function verifyMediaTools(run: Probe, env: NodeJS.ProcessEnv): Promise<void> {
  const ffmpeg = mediaExecutable("ffmpeg", env);
  const ffprobe = mediaExecutable("ffprobe", env);
  if (/[|=]/u.test(ffmpeg) || /[|=]/u.test(ffprobe))
    throw new Error("Use FFMPEG_PATH and FFPROBE_PATH without | or = in aeneas configuration.");
  await Promise.all([
    verify(
      "FFmpeg with the subtitles filter",
      async () =>
        /\bV->V\s+Render text subtitles/u.test(
          (await run(ffmpeg, ["-hide_banner", "-filters"])).toString(),
        ),
      "Install FFmpeg with libass and check FFMPEG_PATH.",
    ),
    verify(
      "FFprobe",
      async () => (await run(ffprobe, ["-version"])).toString().startsWith("ffprobe version "),
      "Install FFprobe and check FFPROBE_PATH.",
    ),
  ]);
  // Exercise the active binaries at every fresh check, including same-path replacements.
  await verify(
    "FFmpeg/FFprobe MP4 encode and inspection",
    () => verifyAssemblyRoundTrip(run, ffmpeg, ffprobe),
    "Check libass, libx264, AAC and MP4 support in FFMPEG_PATH and FFPROBE_PATH.",
  );
}

type Ready = { signature: string; languages: ReadonlyMap<string, string> };
export type MediaReadiness = Readonly<{ runtime: Ready; code: string; checkedAt: number }>;

const voiceCheck = [
  "import sys",
  "from aeneas.tools.execute_task import ExecuteTaskCLI",
  "from aeneas.ttswrappers.espeakttswrapper import ESPEAKTTSWrapper",
  "sys.exit(0 if ESPEAKTTSWrapper.LANGUAGE_TO_VOICE_CODE.get(sys.argv[1]) == sys.argv[2] else 1)",
].join("; ");

async function refreshVoice(
  run: Probe,
  env: NodeJS.ProcessEnv,
  code: string,
  voice: string,
): Promise<void> {
  await Promise.all([
    verifyMediaTools(run, env),
    verify(
      "aeneas command-line module or narration mapping",
      async () => {
        await run(alignmentPython(env), ["-c", voiceCheck, code, voice]);
        return true;
      },
      "Install aeneas==1.7.3.0 and check ALIGNMENT_PYTHON_PATH.",
    ),
    verify(
      "eSpeak narration voice",
      () => canSynthesize(run, voice),
      "Restore the pinned eSpeak voice and language data.",
    ),
  ]);
}

function verifyFreshLanguage(
  checked: Ready,
  language: unknown,
  proof: MediaReadiness | undefined,
): void {
  const code = alignmentLanguage(language, checked.languages);
  if (
    proof?.runtime !== checked ||
    proof.code !== code ||
    performance.now() - proof.checkedAt > 10000
  )
    throw new LocalAssemblyFailure(
      "LOCAL_RENDER_TRANSIENT",
      "Fresh local media readiness is missing or expired for the pinned narration",
      true,
    );
}

function readinessChanged(): LocalAssemblyFailure {
  return new LocalAssemblyFailure(
    "LOCAL_RENDER_TRANSIENT",
    "Media runtime changed during readiness check",
    true,
  );
}

export function createMediaRuntimeGate(run: Probe = probe): {
  activate: (env?: NodeJS.ProcessEnv) => Promise<void>;
  assertReady: (env?: NodeJS.ProcessEnv) => void;
  assertLanguage: (language: () => unknown, env?: NodeJS.ProcessEnv) => void;
  resolveLanguage: (language: unknown, env?: NodeJS.ProcessEnv) => string;
  prepareLanguage: (
    language: () => unknown,
    env?: NodeJS.ProcessEnv,
  ) => Promise<MediaReadiness | undefined>;
  assertFreshLanguage: (
    language: () => unknown,
    evidence?: MediaReadiness,
    env?: NodeJS.ProcessEnv,
  ) => void;
} {
  // The production entry points explicitly activate this guard before Nest boots.
  // Isolated test harnesses that inject fake ports do not activate it.

  let state: { ready: Ready | null } | undefined;
  function ready(env: NodeJS.ProcessEnv): Ready | undefined {
    if (!state) return undefined;
    if (state.ready?.signature !== signature(env))
      throw new LocalAssemblyFailure(
        "MEDIA_TOOL_UNAVAILABLE",
        "Local media runtime has not passed preflight. Restart after fixing its configuration.",
      );
    return state.ready;
  }
  return {
    async activate(env = process.env): Promise<void> {
      const pending: { ready: Ready | null } = { ready: null };
      state = pending;
      const checkedSignature = signature(env);
      await verifyMediaTools(run, env);
      const languages = await installedLanguages(run, await loadVoices(run, alignmentPython(env)));
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
    async prepareLanguage(language, env = process.env): Promise<MediaReadiness | undefined> {
      const checked = ready(env);
      if (!checked) return undefined;
      const code = alignmentLanguage(await language(), checked.languages);
      await refreshVoice(run, env, code, checked.languages.get(code)!);
      if (ready(env) !== checked) throw readinessChanged();
      return Object.freeze({ runtime: checked, code, checkedAt: performance.now() });
    },
    assertFreshLanguage(language, evidence, env = process.env): void {
      const checked = ready(env);
      if (checked) verifyFreshLanguage(checked, language(), evidence);
    },
  };
}

export const mediaRuntimeGate = createMediaRuntimeGate();

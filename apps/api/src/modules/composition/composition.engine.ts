import { spawn } from "node:child_process";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { type ProcessRunner } from "@reelforge/media";
import { mediaExecutable } from "./media-runtime.js";

@Injectable()
export class SpawnProcessRunner implements ProcessRunner {
  public run(
    input: Readonly<{
      executable: "ffmpeg" | "ffprobe";
      argv: readonly string[];
      signal?: AbortSignal;
    }>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const executable = mediaExecutable(input.executable);
      const child = spawn(executable, [...input.argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (part: string): void => {
        if (stdout.length < 4_000_000) stdout += part;
      });
      child.stderr.setEncoding("utf8").on("data", (part: string): void => {
        if (stderr.length < 4_000_000) stderr += part;
      });
      let settled = false;
      const abort = (): boolean => child.kill("SIGTERM");
      const cleanup = (): void => {
        input.signal?.removeEventListener("abort", abort);
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      child.once("error", (error: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            new ServiceUnavailableException(
              `${input.executable} is unavailable: ${error.code ?? error.message}`,
              { cause: error },
            ),
          ),
        ),
      );
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (code, codeSignal) =>
        finish(() =>
          input.signal?.aborted
            ? reject(Object.assign(new Error("Render canceled"), { name: "AbortError" }))
            : resolve({ stdout, stderr, exitCode: code ?? (codeSignal ? 1 : 0) }),
        ),
      );
    });
  }
}

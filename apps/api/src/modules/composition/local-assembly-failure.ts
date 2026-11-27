import { HttpException } from "@nestjs/common";
import { z } from "zod";

const errno = z.object({ code: z.string() });
const transientCodes = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT"]);

export class LocalAssemblyFailure extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export function localRenderFailure(error: unknown): LocalAssemblyFailure {
  if (error instanceof LocalAssemblyFailure) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  const code = errno.safeParse(cause ?? error).data?.code;
  if ((error instanceof Error && error.name === "AbortError") || (code && transientCodes.has(code)))
    return new LocalAssemblyFailure(
      "LOCAL_RENDER_TRANSIENT",
      "Local render was interrupted.",
      true,
    );
  if (code === "ENOENT" && error instanceof HttpException)
    return new LocalAssemblyFailure(
      "MEDIA_TOOL_UNAVAILABLE",
      "Install the required local media tools before making a new Short.",
    );
  return new LocalAssemblyFailure(
    "LOCAL_RENDER_FAILED",
    "Local assembly could not render the pinned media. Check the inputs and media tools before making a new Short.",
  );
}

export function assemblyFailure(error: unknown): LocalAssemblyFailure | undefined {
  if (error instanceof LocalAssemblyFailure) return error;
  if (!(error instanceof HttpException)) return;
  const result = z
    .object({ code: z.literal("NARRATION_PACE_UNSUPPORTED") })
    .safeParse(error.getResponse());
  if (result.success) return new LocalAssemblyFailure(result.data.code, error.message);
}

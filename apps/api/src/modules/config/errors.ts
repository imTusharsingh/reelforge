import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  ConfigLockViolationError,
  ConfigValidationError,
  PromptCompilationError,
} from "@reelforge/config-engine";

function formatIssues(issues: readonly { path: string; message: string }[]): string {
  if (issues.length === 0) return "";
  return `: ${issues.map((issue) => `${issue.path || "<root>"} ${issue.message}`).join("; ")}`;
}

/** Converts pure config-engine errors into HTTP errors without leaking internals. */
export function translateConfigError(error: unknown): never {
  if (error instanceof ConfigLockViolationError) {
    throw new ConflictException({
      code: error.code,
      message: error.message,
      path: error.path,
      layer: error.layer,
      lockedBy: error.lockedBy,
      reason: error.reason,
    });
  }
  if (error instanceof ConfigValidationError) {
    throw new BadRequestException(`${error.message}${formatIssues(error.issues)}`);
  }
  if (error instanceof PromptCompilationError) {
    throw new BadRequestException({
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  throw error;
}

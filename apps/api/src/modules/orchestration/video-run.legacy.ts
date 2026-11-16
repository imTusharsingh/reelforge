import { GoneException } from "@nestjs/common";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import type { NextFunction, Request, Response } from "express";

/** V3 owns the strangler gate; M09 is untouched until V5 removes its synchronous endpoints. */
export function legacyGenerationGate(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const path = request.originalUrl.split("?")[0] ?? "";
  if (
    pipelineV2Enabled() &&
    request.method === "POST" &&
    /\/workspaces\/[^/]+\/(?:scene-media\/|orchestration\/)/.test(path)
  )
    throw new GoneException("Legacy generation is disabled; use POST /api/v1/runs");
  next();
}

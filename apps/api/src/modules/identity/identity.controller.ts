import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.js";
import { IdentityService } from "./identity.service.js";

type Credentials = { email: string; password: string; displayName?: string };
function parseCredentials(body: unknown): Credentials {
  if (typeof body !== "object" || body === null) throw new Error("Invalid request");
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.email !== "string" || typeof candidate.password !== "string") throw new Error("Invalid request");
  return { email: candidate.email, password: candidate.password, ...(typeof candidate.displayName === "string" ? { displayName: candidate.displayName } : {}) };
}

@Controller("auth")
export class IdentityController {
  public constructor(private readonly identity: IdentityService) {}

  @Post("register")
  public async register(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<{ userId: string }> {
    const input = parseCredentials(body);
    const result = await this.identity.register(input.email, input.password, input.displayName);
    response.cookie("reelforge_session", result.token, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    return { userId: result.userId };
  }

  @Post("login")
  public async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<{ userId: string }> {
    const input = parseCredentials(body);
    const result = await this.identity.login(input.email, input.password);
    response.cookie("reelforge_session", result.token, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    return { userId: result.userId };
  }

  @Post("logout")
  @UseGuards(AuthGuard)
  public async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response): Promise<{ ok: true }> {
    await this.identity.revoke(request.principal);
    response.clearCookie("reelforge_session", { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
    return { ok: true };
  }
}

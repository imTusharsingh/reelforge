import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ChangePasswordRequestSchema, UpdateAuthMeRequestSchema } from "@reelforge/contracts";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.js";
import { IdentityService } from "./identity.service.js";

type Credentials = { email: string; password: string; displayName?: string };
function parseCredentials(body: unknown): Credentials {
  if (typeof body !== "object" || body === null) throw new BadRequestException("Invalid request");
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.email !== "string" || typeof candidate.password !== "string")
    throw new BadRequestException("Invalid request");
  return {
    email: candidate.email,
    password: candidate.password,
    ...(typeof candidate.displayName === "string" ? { displayName: candidate.displayName } : {}),
  };
}

function parseStrict<T>(schema: { parse: (value: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch {
    throw new BadRequestException("Invalid request");
  }
}

@Controller("auth")
export class IdentityController {
  public constructor(private readonly identity: IdentityService) {}

  @Post("register")
  public async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ userId: string }> {
    const input = parseCredentials(body);
    const result = await this.identity.register(input.email, input.password, input.displayName);
    response.cookie("reelforge_session", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
    });
    return { userId: result.userId };
  }

  @Post("login")
  public async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ userId: string }> {
    const input = parseCredentials(body);
    const result = await this.identity.login(input.email, input.password);
    response.cookie("reelforge_session", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
    });
    return { userId: result.userId };
  }

  @Post("logout")
  @UseGuards(AuthGuard)
  public async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    await this.identity.revoke(request.principal);
    response.clearCookie("reelforge_session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
    });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  public async me(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ userId: string; email: string; displayName: string | null }> {
    return this.identity.me(request.principal.userId);
  }

  @Patch("me")
  @UseGuards(AuthGuard)
  public async updateMe(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ userId: string; email: string; displayName: string | null }> {
    const input = parseStrict(UpdateAuthMeRequestSchema, body);
    return this.identity.updateProfile(request.principal.userId, input.displayName);
  }

  @Post("me/password")
  @UseGuards(AuthGuard)
  public async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true; revokedSessions: number }> {
    const input = parseStrict(ChangePasswordRequestSchema, body);
    return this.identity.changePassword(
      request.principal,
      input.currentPassword,
      input.newPassword,
    );
  }
}

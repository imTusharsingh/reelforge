import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { IdentityService } from "./identity.service.js";
import type { Principal } from "./identity.types.js";

export type AuthenticatedRequest = Request & { principal: Principal };

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(private readonly identity: IdentityService) {}
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("reelforge_session="))?.slice("reelforge_session=".length);
    const token = header?.startsWith("Bearer ") ? header.slice(7) : cookie;
    if (!token) throw new UnauthorizedException("Authentication required");
    request.principal = await this.identity.principalForToken(token);
    return true;
  }
}

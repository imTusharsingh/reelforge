import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ForbiddenException } from "@nestjs/common";

export const CSRF_COOKIE = "reelforge_csrf";
export const SESSION_COOKIE = "reelforge_session";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function cookieValue(request: Pick<Request, "headers">, name: string): string | undefined {
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .replace(/^"|"$/g, "");
}

function invalid(code: "CSRF_TOKEN_INVALID" | "CSRF_ORIGIN_INVALID"): never {
  throw new ForbiddenException({ code, message: code });
}

export function originAllowed(
  request: Pick<Request, "headers">,
  configured: string | undefined,
): boolean {
  if (!configured) return false;
  let expected: URL;
  try {
    expected = new URL(configured);
  } catch {
    return false;
  }
  const candidate = request.headers.origin ?? request.headers.referer;
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === expected.origin;
  } catch {
    return false;
  }
}

export function validateCsrf(request: Pick<Request, "headers">): void {
  const cookie = cookieValue(request, CSRF_COOKIE);
  const header = request.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || cookie.length !== header.length)
    invalid("CSRF_TOKEN_INVALID");
  if (!timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) invalid("CSRF_TOKEN_INVALID");
  if (!originAllowed(request, process.env.WEB_APP_ORIGIN)) invalid("CSRF_ORIGIN_INVALID");
}

export function csrfMiddleware(request: Request, _response: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(request.method)) return next();
  const path = request.path.replace(/^\/api\/v1(?=\/|$)/, "");
  if (
    path === "/health" ||
    path === "/ops/metrics" ||
    /^\/social-accounts\/oauth\/[^/]+\/callback$/.test(path)
  )
    return next();
  const session = cookieValue(request, SESSION_COOKIE);
  const preAuth = path === "/auth/login" || path === "/auth/register";
  if (session === undefined && !preAuth) return next();
  if (session === undefined && !preAuth && request.headers.authorization?.startsWith("Bearer "))
    return next();
  try {
    validateCsrf(request);
  } catch (error) {
    return next(error);
  }
  return next();
}

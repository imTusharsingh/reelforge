import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { StructuredLogger, isUuid, parseLogLevel } from "@reelforge/observability";
import { catchError, from, mergeMap, throwError, type Observable } from "rxjs";
import { AuditService } from "./audit.service.js";
import { classifyRoute, extractTargetIds, isAuditedRequest } from "./audit.catalog.js";
import { SKIP_HTTP_AUDIT, type AuditOutcomeValue } from "./audit.types.js";
import { routeTemplate, type ObservedRequest } from "./request-context.middleware.js";

/** Nest `@HttpCode()` metadata key (`HTTP_CODE_METADATA` in @nestjs/common constants). */
const HTTP_CODE_METADATA = "__httpCode__";

function responseUserId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const userId = (value as { userId?: unknown }).userId;
  return isUuid(userId) ? userId : null;
}

function responseId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return isUuid(id) ? id : null;
}

function errorDetails(error: unknown): {
  status: number;
  code: string;
  outcome: AuditOutcomeValue;
} {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const body = error.getResponse();
    const code =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { code?: unknown }).code === "string"
        ? (body as { code: string }).code
        : `HTTP_${status}`;
    return { status, code, outcome: status === 401 || status === 403 ? "DENIED" : "FAILURE" };
  }
  if (error instanceof Error && error.name === "ZodError")
    return { status: 400, code: "VALIDATION_FAILED", outcome: "FAILURE" };
  return { status: 500, code: "INTERNAL_ERROR", outcome: "FAILURE" };
}

/**
 * M19-T02 HTTP audit: every mutating request (and the OAuth callback) produces one append-only
 * audit event with actor, workspace, category, route template, outcome, status, error code, route
 * ids, and correlation id. Request bodies are never stored. Guard denials (401/403 before the
 * handler) are not audited here; M01 `auth_events` and access logs cover failed authentication.
 * A failed audit write is logged and counted but never changes the response of an action that
 * already happened.
 */
@Injectable()
export class HttpAuditInterceptor implements NestInterceptor {
  private readonly logger = new StructuredLogger({
    service: "api",
    level: parseLogLevel(process.env["LOG_LEVEL"]),
  });

  public constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<ObservedRequest>();
    const route = routeTemplate(request);
    if (!isAuditedRequest(request.method, route)) return next.handle();
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_HTTP_AUDIT, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return next.handle();
    const handler = `${context.getClass().name}.${context.getHandler().name}`;
    const params = (request.params ?? {}) as Record<string, unknown>;
    const base = {
      workspaceId: isUuid(params["workspaceId"]) ? params["workspaceId"] : null,
      category: classifyRoute(route),
      action: `${request.method} ${route}`,
      method: request.method,
      route,
      targetIds: extractTargetIds(params),
      ...(request.observability ? { correlationId: request.observability.correlationId } : {}),
    } as const;
    const write = async (
      outcome: AuditOutcomeValue,
      statusCode: number,
      errorCode: string | null,
      value: unknown,
    ): Promise<void> => {
      const resultId = responseId(value);
      try {
        await this.audit.record({
          ...base,
          workspaceId: base.workspaceId ?? (route === "/workspaces" ? resultId : null),
          actorUserId: request.principal?.userId ?? responseUserId(value),
          outcome,
          statusCode,
          errorCode,
          targetIds: { ...base.targetIds, ...(resultId === null ? {} : { resultId }) },
          metadata: { handler },
        });
      } catch (error) {
        this.logger.error("audit write failed", { handler, route, error });
      }
    };
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        // Nest applies the final status after interceptors run, so use the declared @HttpCode.
        const declared = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as unknown;
        const status =
          typeof declared === "number" ? declared : request.method === "POST" ? 201 : 200;
        await write("SUCCESS", status, null, value);
        return value;
      }),
      catchError((error: unknown) => {
        const details = errorDetails(error);
        return from(write(details.outcome, details.status, details.code, null)).pipe(
          mergeMap(() => throwError(() => error)),
        );
      }),
    );
  }
}

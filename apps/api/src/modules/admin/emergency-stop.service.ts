import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { AuditService } from "./audit.service.js";
import {
  EmergencyStopError,
  NOT_STOPPED,
  type EmergencyStopCheckInput,
  type EmergencyStopDecision,
  type EmergencyStopPort,
} from "./emergency-stop.types.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * GLOBAL scope is operator-controlled through the environment (no platform-operator role exists;
 * ADR-003 has only OWNER/EDITOR/VIEWER). WORKSPACE and CHANNEL scopes are set by a workspace OWNER.
 */
export function globalStopFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmergencyStopDecision {
  const flag = env["REELFORGE_EMERGENCY_STOP"]?.trim().toLowerCase();
  if (flag === undefined || !TRUE_VALUES.has(flag)) return NOT_STOPPED;
  const reason = env["REELFORGE_EMERGENCY_STOP_REASON"]?.trim();
  return {
    stopped: true,
    scope: "GLOBAL",
    reason: reason ? reason.slice(0, 500) : "Operator stop",
  };
}

const setStopSchema = z
  .object({
    scope: z.enum(["WORKSPACE", "CHANNEL"]),
    channelId: z.uuid().optional(),
    active: z.boolean(),
    reason: z.string().trim().min(3).max(500),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "CHANNEL" && value.channelId === undefined)
      ctx.addIssue({
        code: "custom",
        message: "channelId is required for CHANNEL scope",
        path: ["channelId"],
      });
    if (value.scope === "WORKSPACE" && value.channelId !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "channelId is only allowed for CHANNEL scope",
        path: ["channelId"],
      });
  });

export type EmergencyStopView = Readonly<{
  id: string | null;
  scope: "GLOBAL" | "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  active: boolean;
  reason: string | null;
  setByUserId: string | null;
  setAt: string | null;
  clearedByUserId: string | null;
  clearedAt: string | null;
  version: number | null;
}>;

export type EmergencyStopStatusView = Readonly<{
  global: EmergencyStopView;
  stops: EmergencyStopView[];
  effect: string;
}>;

type StopRow = {
  id: string;
  scope: "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  active: boolean;
  reason: string | null;
  setByUserId: string | null;
  setAt: Date | null;
  clearedByUserId: string | null;
  clearedAt: Date | null;
  version: number;
};

function view(row: StopRow): EmergencyStopView {
  return {
    id: row.id,
    scope: row.scope,
    channelId: row.channelId,
    active: row.active,
    reason: row.reason,
    setByUserId: row.setByUserId,
    setAt: row.setAt?.toISOString() ?? null,
    clearedByUserId: row.clearedByUserId,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    version: row.version,
  };
}

const EFFECT =
  "While active: no new M16 runs (manual 409, scheduled slots SKIPPED/EMERGENCY_STOP); queued M16 steps pause the run (PAUSED/EMERGENCY_STOP) at the next step boundary; M08 paid script/scene-media calls are refused before reservation (409 EMERGENCY_STOP); M13 publish/retry preflight fails. Allowed: reads, cancel, M13 reconcile, M16 recovery sweeps and WAITING_EXTERNAL polls, disconnect.";

@Injectable()
export class EmergencyStopService implements EmergencyStopPort {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  public async check(input: EmergencyStopCheckInput): Promise<EmergencyStopDecision> {
    const global = globalStopFromEnv();
    if (global.stopped) return global;
    const keys = ["workspace"];
    if (input.channelId) keys.push(`channel:${input.channelId}`);
    const rows = await this.db.emergencyStop.findMany({
      where: { workspaceId: input.workspaceId, active: true, scopeKey: { in: keys } },
      select: { scope: true, reason: true },
      orderBy: { scope: "asc" },
    });
    const workspace = rows.find((row) => row.scope === "WORKSPACE");
    const hit = workspace ?? rows[0];
    return hit ? { stopped: true, scope: hit.scope, reason: hit.reason } : NOT_STOPPED;
  }

  /** Throws `EmergencyStopError` (409) when stopped. */
  public async assertNotStopped(input: EmergencyStopCheckInput, action: string): Promise<void> {
    const decision = await this.check(input);
    if (decision.stopped) throw new EmergencyStopError(decision, action);
  }

  /** Any workspace member may read the stop status (so editors can see why runs paused). */
  public async status(context: WorkspaceContext): Promise<EmergencyStopStatusView> {
    const global = globalStopFromEnv();
    const rows = await this.db.emergencyStop.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ scope: "desc" }, { createdAt: "asc" }],
    });
    return {
      global: {
        id: null,
        scope: "GLOBAL",
        channelId: null,
        active: global.stopped,
        reason: global.reason,
        setByUserId: null,
        setAt: null,
        clearedByUserId: null,
        clearedAt: null,
        version: null,
      },
      stops: rows.map(view),
      effect: EFFECT,
    };
  }

  /** OWNER only. Sets or clears a WORKSPACE or CHANNEL stop and writes an ADMIN audit event. */
  public async set(context: WorkspaceContext, body: unknown): Promise<EmergencyStopView> {
    if (context.role !== "OWNER") throw new ForbiddenException("Owner permission required");
    const parsed = setStopSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join("; "));
    const input = parsed.data;
    const channelId = input.scope === "CHANNEL" ? (input.channelId ?? null) : null;
    if (channelId !== null) {
      const channel = await this.db.channel.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: channelId } },
        select: { id: true },
      });
      if (!channel) throw new NotFoundException("Channel not found");
    }
    const scopeKey = channelId === null ? "workspace" : `channel:${channelId}`;
    const now = new Date();
    const result = await this.db.$transaction(async (tx) => {
      const before = await tx.emergencyStop.findUnique({
        where: { workspaceId_scopeKey: { workspaceId: context.workspaceId, scopeKey } },
      });
      if (input.expectedVersion !== undefined && (before?.version ?? 0) !== input.expectedVersion)
        throw new ConflictException("Emergency stop changed; reload and retry");
      if (before !== null && before.active === input.active)
        return { before, after: before, changed: false };
      const data = input.active
        ? {
            active: true,
            reason: input.reason,
            setByUserId: context.userId,
            setAt: now,
            clearedByUserId: null,
            clearedAt: null,
          }
        : { active: false, clearedByUserId: context.userId, clearedAt: now };
      let after: StopRow;
      if (before === null) {
        after = await tx.emergencyStop.create({
          data: {
            workspaceId: context.workspaceId,
            scope: input.scope,
            channelId,
            scopeKey,
            ...data,
            reason: input.reason,
            version: 1,
          },
        });
      } else {
        const updated = await tx.emergencyStop.updateMany({
          where: { workspaceId: context.workspaceId, id: before.id, version: before.version },
          data: { ...data, version: { increment: 1 } },
        });
        if (updated.count === 0)
          throw new ConflictException("Emergency stop changed; reload and retry");
        after = await tx.emergencyStop.findUniqueOrThrow({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: before.id } },
        });
      }
      return { before, after, changed: true };
    });
    if (result.changed)
      await this.audit.record({
        workspaceId: context.workspaceId,
        actorUserId: context.userId,
        category: "ADMIN",
        action: input.active ? "EMERGENCY_STOP_SET" : "EMERGENCY_STOP_CLEARED",
        method: "PUT",
        route: "/workspaces/:workspaceId/admin/emergency-stop",
        outcome: "SUCCESS",
        statusCode: 200,
        targetIds: {
          emergencyStopId: result.after.id,
          ...(channelId === null ? {} : { channelId }),
        },
        metadata: {
          scope: input.scope,
          reason: input.reason,
          before: result.before === null ? null : view(result.before),
          after: view(result.after),
        },
      });
    return view(result.after);
  }
}

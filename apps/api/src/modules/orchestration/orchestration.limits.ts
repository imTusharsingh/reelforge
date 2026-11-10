import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "../identity/identity.types.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  WORKFLOW_LIMIT_CONFIG,
  type WorkflowLeaseScopeValue,
  type WorkflowLimitConfig,
} from "./orchestration.types.js";

@Injectable()
export class WorkflowLimitsService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(WORKFLOW_LIMIT_CONFIG) private readonly config: WorkflowLimitConfig,
  ) {}

  public limits(): WorkflowLimitConfig {
    return this.config;
  }

  public async acquireLease(input: {
    workspaceId: string;
    scope: WorkflowLeaseScopeValue;
    scopeKey: string;
    holderId: string;
    limit: number;
    now: Date;
  }): Promise<number | null> {
    if (input.limit <= 0) return null;
    const expiresAt = new Date(input.now.getTime() + this.config.leaseTtlMs);
    for (let slot = 0; slot < input.limit; slot += 1) {
      const rows = await this.db.$queryRaw<Array<{ slot: number }>>`
        INSERT INTO "workflow_limit_leases"
          ("id", "workspace_id", "scope", "scope_key", "slot", "holder_id", "acquired_at", "expires_at", "created_at")
        VALUES (
          ${randomUUID()}::uuid,
          ${input.workspaceId}::uuid,
          ${input.scope}::"WorkflowLeaseScope",
          ${input.scopeKey},
          ${slot},
          ${input.holderId},
          ${input.now},
          ${expiresAt},
          ${input.now}
        )
        ON CONFLICT ("workspace_id", "scope", "scope_key", "slot")
        DO UPDATE SET
          "holder_id" = EXCLUDED."holder_id",
          "acquired_at" = EXCLUDED."acquired_at",
          "expires_at" = EXCLUDED."expires_at"
        WHERE "workflow_limit_leases"."expires_at" < ${input.now}
        RETURNING "slot"
      `;
      if (rows.length > 0) return slot;
    }
    return null;
  }

  public async releaseLease(input: {
    workspaceId: string;
    scope: WorkflowLeaseScopeValue;
    scopeKey: string;
    holderId: string;
    slot: number;
  }): Promise<void> {
    await this.db.workflowLimitLease.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        scope: input.scope,
        scopeKey: input.scopeKey,
        holderId: input.holderId,
        slot: input.slot,
      },
    });
  }

  public async consumeRate(input: {
    workspaceId: string;
    scope: WorkflowLeaseScopeValue;
    scopeKey: string;
    limit: number;
    now: Date;
  }): Promise<boolean> {
    if (input.limit <= 0) return false;
    const windowStart = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
    const rows = await this.db.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "workflow_rate_counters"
        ("id", "workspace_id", "scope", "scope_key", "window_start", "count", "updated_at")
      VALUES (
        ${randomUUID()}::uuid,
        ${input.workspaceId}::uuid,
        ${input.scope}::"WorkflowLeaseScope",
        ${input.scopeKey},
        ${windowStart},
        1,
        ${input.now}
      )
      ON CONFLICT ("workspace_id", "scope", "scope_key", "window_start")
      DO UPDATE SET
        "count" = "workflow_rate_counters"."count" + 1,
        "updated_at" = ${input.now}
      RETURNING "count"
    `;
    const count = rows[0]?.count;
    return count !== undefined && count <= input.limit;
  }
}

export function defaultWorkflowLimitConfig(): WorkflowLimitConfig {
  return DEFAULT_WORKFLOW_LIMIT_CONFIG;
}

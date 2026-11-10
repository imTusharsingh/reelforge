import { isUuid } from "@reelforge/observability";
import type { AuditCategoryValue } from "./audit.types.js";

/**
 * Maps an HTTP route template (without the `/api/v1` prefix) to an audit category. Order matters:
 * approvals are checked before generic config routes. Unknown mutating routes are OPERATION, so
 * every write is still audited.
 */
const RULES: ReadonlyArray<readonly [RegExp, AuditCategoryValue]> = [
  [/^\/?auth\//, "AUTH"],
  [/\/admin(\/|$)/, "ADMIN"],
  [/social-accounts/, "CONNECTION"],
  [/\/publishing\//, "PUBLISHING"],
  [/(\/approve$|\/decision$|\/ideas\/:ideaId\/status$)/, "APPROVAL"],
  [
    /(\/config(\/|$)|\/prompts\/|\/channels(\/:channelId)?(\/status)?$|\/genres|\/series|\/characters|\/character-groups|\/usage\/(budgets|adjustments)$|\/notifications\/preferences$|\/assets|^\/?workspaces(\/:workspaceId)?$)/,
    "CONFIG",
  ],
];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function stripGlobalPrefix(route: string): string {
  return route.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
}

export function classifyRoute(route: string): AuditCategoryValue {
  const normalized = stripGlobalPrefix(route);
  for (const [pattern, category] of RULES) if (pattern.test(normalized)) return category;
  return "OPERATION";
}

/**
 * Which requests are audited: every mutating request, plus the OAuth callback GET (a connection is
 * completed there). Reads are not audited.
 */
export function isAuditedRequest(method: string, route: string): boolean {
  if (MUTATING.has(method.toUpperCase())) return true;
  return (
    method.toUpperCase() === "GET" && /social-accounts\/oauth\/:platform\/callback$/.test(route)
  );
}

/** Keeps only id-like route params (`...Id` keys with UUID values, or `platform`). */
export function extractTargetIds(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof params !== "object" || params === null) return out;
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (key === "workspaceId") continue;
    if (key.endsWith("Id") && isUuid(value)) out[key] = value.toLowerCase();
    else if (key === "platform" && typeof value === "string" && /^[A-Z_]{2,32}$/i.test(value))
      out[key] = value.toUpperCase();
  }
  return out;
}

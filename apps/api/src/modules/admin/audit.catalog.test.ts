import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  extractTargetIds,
  isAuditedRequest,
  stripGlobalPrefix,
} from "./audit.catalog.js";

describe("M19 audit catalog", () => {
  it("classifies the five required classes plus admin and operations", () => {
    const cases: Array<[string, string]> = [
      ["/api/v1/auth/login", "AUTH"],
      ["/auth/register", "AUTH"],
      ["/auth/logout", "AUTH"],
      ["/workspaces/:workspaceId/config", "CONFIG"],
      ["/workspaces/:workspaceId/prompts/templates/:templateId", "CONFIG"],
      ["/workspaces/:workspaceId/channels/:channelId", "CONFIG"],
      ["/workspaces/:workspaceId/channels/:channelId/status", "CONFIG"],
      ["/workspaces/:workspaceId/usage/budgets", "CONFIG"],
      ["/workspaces/:workspaceId/notifications/preferences", "CONFIG"],
      ["/workspaces", "CONFIG"],
      ["/workspaces/:workspaceId", "CONFIG"],
      ["/workspaces/:workspaceId/scripts/:scriptId/approve", "APPROVAL"],
      ["/workspaces/:workspaceId/quality/runs/:runId/decision", "APPROVAL"],
      ["/workspaces/:workspaceId/ideas/:ideaId/status", "APPROVAL"],
      [
        "/workspaces/:workspaceId/performance-intelligence/recommendations/:recommendationId/approve",
        "APPROVAL",
      ],
      [
        "/workspaces/:workspaceId/channels/:channelId/social-accounts/:platform/connect",
        "CONNECTION",
      ],
      ["/workspaces/:workspaceId/social-accounts/:accountId/revoke", "CONNECTION"],
      ["/social-accounts/oauth/:platform/callback", "CONNECTION"],
      ["/workspaces/:workspaceId/publishing/destinations/:destinationId/publish", "PUBLISHING"],
      ["/workspaces/:workspaceId/publishing/posts", "PUBLISHING"],
      ["/workspaces/:workspaceId/admin/emergency-stop", "ADMIN"],
      ["/workspaces/:workspaceId/orchestration/runs", "OPERATION"],
      ["/workspaces/:workspaceId/scene-media/jobs", "OPERATION"],
    ];
    for (const [route, category] of cases)
      expect([route, classifyRoute(route)]).toEqual([route, category]);
  });

  it("audits every mutating method and the OAuth callback, but not reads", () => {
    expect(isAuditedRequest("POST", "/workspaces/:workspaceId/ideas")).toBe(true);
    expect(isAuditedRequest("PATCH", "/x")).toBe(true);
    expect(isAuditedRequest("PUT", "/x")).toBe(true);
    expect(isAuditedRequest("DELETE", "/x")).toBe(true);
    expect(isAuditedRequest("GET", "/workspaces/:workspaceId/ideas")).toBe(false);
    expect(isAuditedRequest("GET", "/social-accounts/oauth/:platform/callback")).toBe(true);
    expect(stripGlobalPrefix("/api/v1/health")).toBe("/health");
  });

  it("keeps only UUID route ids and never raw strings that could carry secrets", () => {
    expect(
      extractTargetIds({
        workspaceId: "8b3f3f8e-3c9a-4b38-9d5e-6f7a8b9c0d1e",
        channelId: "1B3F3F8E-3C9A-4B38-9D5E-6F7A8B9C0D1E",
        accountId: "not-a-uuid?token=abc",
        platform: "youtube",
        templateId: "x".repeat(40),
      }),
    ).toEqual({ channelId: "1b3f3f8e-3c9a-4b38-9d5e-6f7a8b9c0d1e", platform: "YOUTUBE" });
  });
});

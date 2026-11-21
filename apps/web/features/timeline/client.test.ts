// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClient, runRequest, watchRun } from "./client";
import { detail, FakeEventSource, runId, workspaceId } from "./timeline.fixture";
import { dollars, latestCritic, pauseLabel } from "./view-model";
afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  document.cookie = "reelforge_csrf=;max-age=0";
});
describe("V8 V3 HTTP and SSE clients on fakes", () => {
  it("uses named ordered events, reconnects with credentials, and closes", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const update = vi.fn(),
      connection = vi.fn();
    const close = watchRun(workspaceId, runId, update, connection);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain(`/runs/${runId}/events?workspaceId=${workspaceId}`);
    expect(source.options.withCredentials).toBe(true);
    source.onopen?.();
    expect(connection).toHaveBeenCalledWith("Live");
    source.emit("step_completed", 1);
    source.emit("step_completed", 1);
    source.emit("transition", 2);
    expect(update).toHaveBeenCalledTimes(2);
    source.emit("provider_receipt", 3);
    expect(update).toHaveBeenCalledTimes(3);
    source.emit("billing_reconciled", 4);
    source.emit("billing_reconciled", 4);
    expect(update).toHaveBeenCalledTimes(4);
    source.onerror?.();
    expect(connection).toHaveBeenCalledWith("Reconnecting…");
    close();
    expect(source.closed).toBe(true);
  });
  it("validates detail, lists, autonomy status and usage responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(detail()));
    vi.stubGlobal("fetch", fetcher);
    expect((await runClient.detail(workspaceId, runId)).run.id).toBe(runId);
    fetcher.mockResolvedValueOnce(Response.json([detail().run]));
    expect(await runClient.list(workspaceId)).toHaveLength(1);
    fetcher.mockResolvedValueOnce(
      Response.json({
        approvedShorts: 10,
        offerL3: true,
        effective: "L2",
        agreements: 8,
        samples: 10,
        recommended: true,
      }),
    );
    expect((await runClient.status(workspaceId, runId)).recommended).toBe(true);
    fetcher.mockResolvedValueOnce(Response.json({ shorts: [], providers: [] }));
    expect((await runClient.usage(workspaceId)).shorts).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({}));
    await expect(runClient.detail(workspaceId, runId)).rejects.toThrow();
  });
  it("posts a decision with CSRF and reports failures", async () => {
    document.cookie = "reelforge_csrf=fake";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await runRequest(`run-experience/${runId}/decision`, workspaceId, { decision: "APPROVE" });
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/api/v1/workspaces/${workspaceId}/run-experience/${runId}/decision?workspaceId=${workspaceId}`,
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("fake");
    expect(init.body).toBe('{"decision":"APPROVE"}');
    fetcher.mockResolvedValueOnce(Response.json({ message: "Denied" }, { status: 403 }));
    await expect(runRequest("run-experience", workspaceId)).rejects.toThrow("Denied");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(runRequest("run-experience", workspaceId)).rejects.toThrow("503");
  });
  it("explains V3 pause codes and latest critic with costs", () => {
    for (const reason of [
      "BUDGET_CAP",
      "PROVIDER_REFUSED",
      "RECONCILE_REQUIRED",
      "HUMAN_REJECTED",
      "EMERGENCY_STOP",
    ])
      expect(pauseLabel(reason)).not.toBe(reason);
    expect(pauseLabel("other reason")).toBe("other reason");
    expect(dollars(579)).toBe("$5.79");
    expect(latestCritic(detail())?.recommendation).toBe("APPROVE");
    expect(latestCritic({ ...detail(), steps: [] })).toBeNull();
  });
});

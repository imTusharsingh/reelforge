import { describe, expect, it, vi } from "vitest";
import type { QualityService } from "../quality/quality.service.js";
import { WorkflowDomainDispatcher } from "./orchestration.dispatcher.js";
import type { WorkflowStepDispatchInput } from "./orchestration.types.js";

function fixture(status = "APPROVED"): {
  dispatcher: WorkflowDomainDispatcher;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async () => ({ id: "review", status }));
  const quality = { get } as unknown as QualityService;
  return {
    dispatcher: new WorkflowDomainDispatcher(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      quality,
      {} as never,
      {} as never,
    ),
    get,
  };
}
function input(previousResultRef: string | null): WorkflowStepDispatchInput {
  return {
    stepKey: "QUALITY_REVIEW",
    context: { workspaceId: "w", userId: "u", role: "OWNER" },
    input: {},
    previousResultRef,
  } as WorkflowStepDispatchInput;
}
describe("legacy workflow review compatibility", () => {
  it("resumes a persisted review", async () => {
    const t = fixture();
    await expect(t.dispatcher.dispatchStep(input("review"))).resolves.toMatchObject({
      resultRef: "review",
      output: { qualityStatus: "APPROVED" },
    });
    expect(t.get).toHaveBeenCalledOnce();
  });
  it("does not create a legacy review when no persisted review is present", async () => {
    const t = fixture();
    await expect(t.dispatcher.dispatchStep(input(null))).rejects.toMatchObject({
      code: "LEGACY_QUALITY_UNAVAILABLE",
    });
    expect(t.get).not.toHaveBeenCalled();
  });
});

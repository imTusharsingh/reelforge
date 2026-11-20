// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../../components/studio-workspace-context";
import { Onboarding } from "./onboarding";
import { BriefEditor } from "./editor";
import { ProviderHealth, ProviderSettings } from "./settings";
import { brief, channelId, setupStub, workspaceId } from "./setup.fixture";
vi.mock("../../components/studio-link", () => ({
  StudioLink: (props: object): ReactNode => createElement("a", props),
}));
let root: Root, container: HTMLDivElement;
let stub: ReturnType<typeof setupStub>;
async function render(node: ReactNode): Promise<void> {
  await act(async () =>
    root.render(
      createElement(WorkspaceProvider, {
        workspace: { id: workspaceId, name: "Science", role: "OWNER" },
        children: node,
      }),
    ),
  );
}
async function change(selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(selector)!;
  const proto =
    element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : element.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
async function submit(selector = "form"): Promise<void> {
  await act(async () =>
    container
      .querySelector(selector)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stub = setupStub();
  vi.stubGlobal("fetch", stub.fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("V7 mounted screens", () => {
  it("queues a Short with five inputs and reuses saved objects when run-create fails", async () => {
    const completed = vi.fn();
    stub.failRun = true;
    await render(createElement(Onboarding, { onComplete: completed }));
    expect(container.querySelectorAll("input,select")).toHaveLength(3);
    await change("#setup-niche", "Science");
    await change("#setup-audience", "Adults");
    await change("#setup-language", "Hindi");
    await submit();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Voice & cadence");
    await change("#setup-voice", "Puck");
    await change("#setup-cadence", "17:30");
    await submit();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Confirm");
    await submit();
    expect(container.textContent).toContain("Setup could not finish");
    const before = stub.calls.filter(
      (call) => call.method === "POST" && !call.path.endsWith("/runs"),
    ).length;
    stub.failRun = false;
    await submit();
    expect(completed).toHaveBeenCalledOnce();
    expect(
      stub.calls.filter((call) => call.method === "POST" && !call.path.endsWith("/runs")),
    ).toHaveLength(before);
    expect(container.textContent).toContain("first Short is queued");
  });
  it("shows safe failures and clears submitted keys on success and failure", async () => {
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).endsWith("/providers/xai/key") && init?.method === "PUT"
        ? Promise.resolve(Response.json({ message: "fixture-secret" }, { status: 503 }))
        : stub.fetch(url, init),
    );
    await render(createElement(ProviderSettings));
    await change("#key-gemini", "fixture-secret");
    await submit("form:first-of-type");
    expect(container.querySelector<HTMLInputElement>("#key-gemini")!.value).toBe("");
    expect(container.innerHTML).not.toContain("fixture-secret");
    expect(container.textContent).toContain("Configured");
    await change("#key-xai", "fixture-secret");
    await submit("form:last-of-type");
    expect(container.textContent).toContain("The service is unavailable. Retry when it is ready.");
    expect(container.querySelector<HTMLInputElement>("#key-xai")!.value).toBe("");
    expect(container.innerHTML).not.toContain("fixture-secret");
  });
  it("renders registry health without provider probes and handles an unavailable service", async () => {
    await render(createElement(ProviderHealth));
    expect(container.textContent).toContain("gemini-omni");
    expect(stub.calls.every((call) => call.path.endsWith("/providers/health"))).toBe(true);
    stub.fail = true;
    await render(createElement(ProviderHealth, { key: "reload" }));
    expect(container.textContent).toContain("Health unavailable");
  });
  it("loads and edits a Brief with L3 locked and preserves prior versions", async () => {
    await render(createElement(BriefEditor, { channelId }));
    expect(container.querySelector<HTMLOptionElement>('option[value="L3"]')!.disabled).toBe(true);
    await change("#brief-topic", "Space");
    await change("#brief-niche", "Astronomy");
    await change("#brief-audience", "Students");
    await change("#language-script", "English");
    await change("#language-narration", "Hindi");
    await change("#language-captions", "Hindi");
    await change("#brief-autonomy", "L1");
    await change("#shorts-per-day", "2");
    await change("#local-time", "17:30");
    await change("#timezone", "Asia/Kolkata");
    for (const field of ["targetMinor", "hardCapMinor", "dailyLimitMinor", "monthlyLimitMinor"])
      await change(
        `#budget-${field}`,
        String(brief.budgetPolicy[field as keyof typeof brief.budgetPolicy]),
      );
    await change("#visual-style", "Ink illustration");
    await change("#palette", "blue");
    await change("#bannedVisuals", "logos");
    await change("#bannedTopics", "Violence");
    await change("#topicsToAvoid", "Breaking news");
    await change("#fact-check", "STANDARD");
    await change("#json-constraints", '{"original":true}');
    await change("#json-narratorVoice", "{");
    expect(container.textContent).toContain("valid JSON");
    await change("#json-narratorVoice", JSON.stringify(brief.narratorVoice));
    await submit();
    expect(container.textContent).toContain("Saved immutable Brief version 2");
    expect(stub.versions[1]!.topic).toBe("Science");
    expect(stub.versions[0]!.topic).toBe("Space");
    stub.fail = true;
    await submit();
    expect(container.textContent).toContain("Brief was not saved");
  });
  it("offers L3 after ten approvals, supports a new Brief and denies editing to viewers", async () => {
    stub.approved = 10;
    stub.versions.splice(0);
    await render(createElement(BriefEditor, { channelId }));
    expect(container.querySelector<HTMLOptionElement>('option[value="L3"]')!.disabled).toBe(false);
    await change("#brief-autonomy", "L3");
    await submit();
    expect(stub.versions[0]!.requestedAutonomy).toBe("L3");
    await act(async () =>
      root.render(
        createElement(WorkspaceProvider, {
          workspace: { id: workspaceId, name: "Science", role: "VIEWER" },
          children: createElement(BriefEditor, { channelId }),
        }),
      ),
    );
    expect(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  });
  it("shows load failures without enabling the editor", async () => {
    stub.fail = true;
    await render(createElement(BriefEditor, { channelId }));
    expect(container.textContent).toContain("Unable to load");
    expect(container.querySelector("form")).toBeNull();
    await render(createElement(ProviderSettings));
    expect(container.textContent).toContain("Settings unavailable");
  });
});

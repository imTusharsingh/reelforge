// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../../components/studio-workspace-context";
import { ChannelOverview } from "./channel-overview";
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
    container.querySelector(selector)!.dispatchEvent(
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: container.querySelector('button[value="queue"]'),
      }),
    ),
  );
}
async function submitOnboardingConfirm(): Promise<void> {
  await change("#setup-niche", "Science");
  await change("#setup-audience", "Adults");
  for (let step = 0; step < 3; step++) await submit();
}
beforeEach(() => {
  history.replaceState(null, "", "/onboarding");
  sessionStorage.clear();
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
  it("reuses the committed queue POST after losing its response and remounting Confirm", async () => {
    const created = new Map<string, string>();
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/runs")) return stub.fetch(url, init);
      const body = String(init?.body);
      const { idempotencyKey } = JSON.parse(body) as { idempotencyKey: string };
      requests.push(body);
      if (!created.has(idempotencyKey)) {
        created.set(idempotencyKey, crypto.randomUUID());
        throw new TypeError("Response lost after commit");
      }
      return Response.json({ id: created.get(idempotencyKey) }, { status: 202 });
    });
    const workspace = { id: workspaceId, name: "Science", role: "OWNER" as const };
    await render(createElement(Onboarding, { workspace }));
    await submitOnboardingConfirm();
    expect(location.search).toBe("?step=confirm");
    await render(null);
    await render(createElement(Onboarding, { workspace }));
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(container.querySelector('button[value="queue"]')?.textContent).toBe("Retry first Short");
    await submit();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(created.size).toBe(1);
    for (const suffix of ["/channels", "/briefs"])
      expect(stub.calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix))).toHaveLength(
        1,
      );
    expect(container.textContent).toContain("first Short is queued");
  });
  it("does not start over when a submitted Confirm checkpoint is missing on reload", async () => {
    const workspace = { id: workspaceId, name: "Science", role: "OWNER" as const };
    stub.failRun = true;
    await render(createElement(Onboarding, { workspace }));
    await submitOnboardingConfirm();
    expect(stub.calls.filter(({ path }) => path.endsWith("/runs"))).toHaveLength(1);
    await render(null);
    sessionStorage.clear();
    await render(createElement(Onboarding, { workspace }));
    await submit();
    expect(container.textContent).toContain("No new Short was sent");
    for (const path of ["/channels", "/briefs", "/runs"]) {
      expect(
        stub.calls.filter((call) => call.method === "POST" && call.path.endsWith(path)),
      ).toHaveLength(1);
    }
  });
  it("repairs a saved unsupported language without recreating the workspace or channel", async () => {
    const attempts: { channelBriefId: string; idempotencyKey: string }[] = [];
    let correctedUnavailable = true;
    const completed = vi.fn();
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/runs")) return stub.fetch(url, init);
      const attempt = JSON.parse(String(init?.body)) as (typeof attempts)[number];
      attempts.push(attempt);
      const saved = stub.versions.find(({ id }) => id === attempt.channelBriefId);
      if (saved?.languages.narration === "Klingon")
        return Response.json(
          {
            code: "NARRATION_LANGUAGE_UNSUPPORTED",
            message: "fixture-secret",
          },
          { status: 409 },
        );
      return correctedUnavailable
        ? Response.json({ message: "ambiguous" }, { status: 503 })
        : stub.fetch(url, init);
    });
    await render(createElement(Onboarding, { onComplete: completed }));
    await change("#setup-niche", "Science");
    await change("#setup-audience", "Adults");
    await change("#setup-language", "Klingon");
    for (let i = 0; i < 3; i++) await submit();
    const field = container.querySelector<HTMLInputElement>("#setup-language")!;
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Audience");
    expect(field.matches(":disabled")).toBe(false);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    expect(container.textContent).toContain("This narration language isn’t supported.");
    expect(container.textContent).not.toContain("fixture-secret");
    expect(completed).not.toHaveBeenCalled();
    await submit();
    expect(attempts).toHaveLength(1);
    await change("#setup-language", "Italian");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    for (let i = 0; i < 3; i++) await submit();
    expect(container.textContent).toContain("Setup could not finish");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.channelBriefId).not.toBe(attempts[0]!.channelBriefId);
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    correctedUnavailable = false;
    await submit();
    expect(attempts[2]).toEqual(attempts[1]);
    expect(completed).toHaveBeenCalledOnce();
    const posts = stub.calls.filter(({ method }) => method === "POST");
    expect(posts.filter(({ path }) => path.endsWith("/workspaces"))).toHaveLength(1);
    expect(posts.filter(({ path }) => path.endsWith("/channels"))).toHaveLength(1);
    expect(posts.filter(({ path }) => path.endsWith("/briefs"))).toHaveLength(2);
    expect(stub.versions[0]).toMatchObject({
      channelId,
      languages: { script: "Italian", narration: "Italian", captions: "Italian" },
      narrationLanguage: "Italian",
      narratorVoice: { language: "Italian" },
    });
  });
  it("restores the successful create-only action on remount without queuing a Short", async () => {
    await render(createElement(Onboarding));
    await submit();
    expect(container.querySelector("#setup-audience")?.getAttribute("aria-invalid")).toBe("true");
    await change("#setup-niche", "Science");
    await change("#setup-audience", "Adults");
    await submit();
    await change("#setup-timezone", "Asia/Kolkata");
    await submit();
    await change("#budget-targetMinor", "350");
    await change("#budget-hardCapMinor", "400");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[type="submit"]:not([value])')!.click(),
    );
    await render(null);
    await render(createElement(Onboarding));
    expect(stub.calls.filter(({ method }) => method === "POST")).toHaveLength(3);
    expect(container.textContent).toContain("channel and Brief are saved");
    expect(container.querySelector('button[value="queue"]')).toBeNull();
    expect(stub.versions[0]).toMatchObject({
      budgetPolicy: { hardCapMinor: 400 },
      cadence: { timezone: "Asia/Kolkata" },
    });
  });
  it("opens the channel overview with a scoped link to its Brief", async () => {
    await render(createElement(ChannelOverview, { channelId }));
    expect(container.querySelector("h1")?.textContent).toBe("Channel overview");
    expect(container.textContent).toContain("45-second Shorts in English");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`/channels/${channelId}/brief`);
  });
  it("discards edits including multiline drafts", async () => {
    await render(createElement(BriefEditor, { channelId }));
    await change("#palette", "red\n");
    await change("#brief-topic", "Different");
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent === "Discard changes")!
        .click(),
    );
    expect(container.querySelector<HTMLInputElement>("#brief-topic")!.value).toBe(brief.topic);
    expect(container.querySelector<HTMLTextAreaElement>("#palette")!.value).toBe(
      brief.styleBible.palette.join("\n"),
    );
    expect(stub.versions).toHaveLength(1);
  });
  it("checks the audience step before advancing or writing setup data", async () => {
    await render(createElement(Onboarding));
    await change("#setup-niche", "Science");
    await change("#setup-audience", "Adults");
    await change("#setup-language", "   ");
    await submit();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Audience");
    expect(container.textContent).toContain("Enter a narration language.");
    expect(stub.calls.filter(({ method }) => method === "POST")).toHaveLength(0);
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
  it("saves an unrelated topic edit with a valid fractional narrator pace", async () => {
    stub.versions[0]!.narratorVoice!.pace = 0.875;
    await render(createElement(BriefEditor, { channelId }));
    await change("#brief-topic", "Space");
    const form = container.querySelector("form")!;
    expect(form.checkValidity()).toBe(true);
    await act(async () => form.requestSubmit());
    expect(stub.versions[0]).toMatchObject({
      version: 2,
      topic: "Space",
      narratorVoice: { pace: 0.875 },
    });
  });
  it("blocks native submission on an invalid legacy pace until corrected", async () => {
    stub.versions[0]!.narratorVoice!.pace = 3;
    await render(createElement(BriefEditor, { channelId }));
    const field = container.querySelector<HTMLTextAreaElement>("#narrator-pace")!;
    const form = container.querySelector("form")!;
    expect(field.validity.rangeOverflow).toBe(true);
    expect(container.textContent).toContain("Narrator pace must be between 0.5 and 2.");
    await change("#brief-topic", "Space");
    await act(async () => form.requestSubmit());
    expect(stub.versions).toHaveLength(1);
    expect(container.textContent).not.toContain("Brief was not saved");
    await change("#narrator-pace", "1");
    expect(field.validity.customError).toBe(false);
    await act(async () => form.requestSubmit());
    expect(stub.versions[0]).toMatchObject({
      version: 2,
      topic: "Space",
      narratorVoice: { pace: 1 },
    });
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
    await change("#narrator-pace", "3");
    expect(container.textContent).toContain("Narrator pace must be between 0.5 and 2.");
    expect(container.querySelector<HTMLTextAreaElement>("#narrator-pace")!.validity.valid).toBe(
      false,
    );
    await change("#narrator-pace", "1");
    await change("#target-duration", "30");
    await change("#palette", "red\n");
    expect(container.querySelector<HTMLTextAreaElement>("#palette")!.value).toBe("red\n");
    await change("#palette", "red\nblue");
    await submit();
    expect(container.textContent).toContain("Saved immutable Brief version 2");
    expect(stub.versions).toHaveLength(2);
    expect(stub.versions[1]).toEqual(brief);
    expect(stub.versions[0]).toMatchObject({
      version: 2,
      topic: "Space",
      targetDurationSeconds: 30,
      styleBible: { palette: ["red", "blue"] },
      narrationLanguage: "Hindi",
      languages: { narration: "Hindi" },
      narratorVoice: { language: "Hindi" },
    });
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

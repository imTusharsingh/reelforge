// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { brief, channelId, runId, workspaceId } from "../brief/setup.fixture";
import { NewShort } from "./new-short";

vi.mock("../../components/studio-workspace-context", () => ({
  useActiveWorkspace: (): { id: string; role: "OWNER" } => ({ id: workspaceId, role: "OWNER" }),
}));
vi.mock("../../components/studio-link", () => ({
  StudioLink: ({ href, children }: { href: string; children: ReactNode }): ReactNode =>
    createElement("a", { href }, children),
}));

const runB = "66666666-6666-4666-8666-666666666666";
const newerBrief = { ...brief, id: "77777777-7777-4777-8777-777777777777", version: 2 };
type Attempt = { workspaceId: string; channelBriefId: string; idempotencyKey: string };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function transport(reply: (index: number) => Response | Promise<Response>): {
  attempts: Attempt[];
  setNewerBrief: () => void;
  briefReads: () => number;
} {
  const attempts: Attempt[] = [];
  let latest = brief;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith("/channels")) {
        return Response.json([{ id: channelId, workspaceId, name: "Science", status: "ACTIVE" }]);
      }
      if (url.endsWith("/briefs")) {
        reads++;
        return Response.json([latest]);
      }
      if (url.endsWith("/auth/csrf")) return new Response(null, { status: 204 });
      if (url.endsWith("/runs") && init?.method === "POST") {
        attempts.push(JSON.parse(String(init.body)) as Attempt);
        return reply(attempts.length);
      }
      throw new Error(`Unexpected mock request: ${url}`);
    }),
  );
  return {
    attempts,
    setNewerBrief: () => {
      latest = newerBrief;
    },
    briefReads: () => reads,
  };
}

async function mount(): Promise<void> {
  await act(async () => root.render(createElement(NewShort)));
  const dialog = host.querySelector("dialog")!;
  Object.defineProperties(dialog, {
    showModal: { value: (): void => dialog.setAttribute("open", "") },
    close: {
      value: (): void => {
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close", { bubbles: true }));
      },
    },
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
}

async function click(label: string): Promise<void> {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => target!.click());
}

it("queues a second Short against the latest brief after reopening a confirmed success", async () => {
  const f = transport((index) =>
    Response.json({ id: index === 1 ? runId : runB }, { status: 202 }),
  );
  await mount();
  await click("New Short");
  await click("Queue Short");
  expect(host.querySelector(`a[href="/runs/${runId}"]`)).not.toBeNull();
  await click("Close");
  f.setNewerBrief();
  await click("New Short");
  expect(host.querySelector(`a[href="/runs/${runId}"]`)).toBeNull();
  await click("Queue Short");
  expect(host.querySelector(`a[href="/runs/${runB}"]`)).not.toBeNull();
  expect(f.attempts.map(({ channelBriefId }) => channelBriefId)).toEqual([brief.id, newerBrief.id]);
  expect(f.attempts[0]?.idempotencyKey).not.toBe(f.attempts[1]?.idempotencyKey);
  expect(f.briefReads()).toBe(2);
});

it("retries an ambiguous request with its original key and brief after reopening", async () => {
  const f = transport((index) => {
    if (index === 1) throw new TypeError("Request timed out after submission");
    return Response.json({ id: runId }, { status: 202 });
  });
  await mount();
  await click("New Short");
  await click("Queue Short");
  expect(host.textContent).toContain("Short could not be queued");
  await click("Close");
  f.setNewerBrief();
  await click("New Short");
  await click("Queue Short");
  expect(host.querySelector(`a[href="/runs/${runId}"]`)).not.toBeNull();
  expect(f.attempts).toHaveLength(2);
  expect(f.attempts[0]?.idempotencyKey).toBeTruthy();
  expect(f.attempts[0]?.channelBriefId).toBe(brief.id);
  expect(f.attempts[0]).toEqual(f.attempts[1]);
  expect(f.briefReads()).toBe(1);
});

it("keeps a still-pending request across close and reopen and shows its eventual result", async () => {
  const pending = Promise.withResolvers<Response>();
  const f = transport(() => pending.promise);
  await mount();
  await click("New Short");
  await click("Queue Short");
  await click("Close");
  await click("New Short");
  expect(f.attempts).toHaveLength(1);
  await act(async () => pending.resolve(Response.json({ id: runId }, { status: 202 })));
  expect(host.querySelector(`a[href="/runs/${runId}"]`)).not.toBeNull();
  expect(button("Queue Short")).toBeUndefined();
});

it("loads a corrected brief after a definitive unsupported-language rejection", async () => {
  const f = transport((index) =>
    index === 1
      ? Response.json({ code: "NARRATION_LANGUAGE_UNSUPPORTED" }, { status: 409 })
      : Response.json({ id: runId }, { status: 202 }),
  );
  await mount();
  await click("New Short");
  await click("Queue Short");
  expect(host.textContent).toContain("narration language isn’t supported");
  f.setNewerBrief();
  await click("Queue Short");
  expect(host.querySelector(`a[href="/runs/${runId}"]`)).not.toBeNull();
  expect(f.attempts.map(({ channelBriefId }) => channelBriefId)).toEqual([brief.id, newerBrief.id]);
  expect(f.attempts[0]?.idempotencyKey).not.toBe(f.attempts[1]?.idempotencyKey);
});

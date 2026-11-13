import { createRoot } from "react-dom/client";
import type { JSX } from "react";
import { AppShell } from "../../../components/app-shell";
import { WorkspaceProvider } from "../../../components/studio-workspace-context";
import { Accounts } from "../accounts";
import { Calendar } from "../calendar";
import { Composer } from "../composer";
import { History } from "../history";
import { PublishingScope } from "../session";
import { PostDetail } from "../post";
import type { CreatePostRequest, Post } from "../model";
import {
  accounts,
  blockedPreflight,
  channels,
  eligibleRender,
  passingPreflight,
  platforms,
  post,
  publishedRecord,
  workspaceId,
} from "./fixtures";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") ?? "compose";
const role = query.get("role") === "VIEWER" ? "VIEWER" : "OWNER";

type Call = { path: string; method: string; body: string | null };
const calls: Call[] = [];
Object.assign(window, { m27Fixture: { calls } });

let current: Post = structuredClone(post);
let createCalls = 0;
let accountCalls = 0;
let currentAccounts = structuredClone(accounts);
if (mode === "retry") {
  current = {
    ...current,
    status: "FAILED_RETRYABLE",
    destinations: current.destinations.map((item) => ({
      ...item,
      status: "FAILED_RETRYABLE",
      lastErrorCode: "UPLOAD_INTERRUPTED",
      lastErrorMessage: "The upload was interrupted",
      latestAttempt: {
        id: "attempt-1",
        attemptNumber: 1,
        status: "FAILED_RETRYABLE",
        errorCode: "UPLOAD_INTERRUPTED",
        errorMessage: "The upload was interrupted",
      },
    })),
  };
}
if (mode === "scheduled") {
  current = { ...current, status: "SCHEDULED", scheduledAt: "2026-11-20T10:00:00.000Z" };
}
if (mode === "post-pending") {
  try {
    sessionStorage.setItem(
      `reelforge:publishing:pending:${workspaceId}:post:${post.id}`,
      "pending",
    );
  } catch {
    // The fixture mirrors the browser storage contract.
  }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });

function createFromRequest(request: CreatePostRequest): Post {
  const scheduled = request.scheduledAt !== null;
  return {
    ...current,
    id: post.id,
    channelId: request.channelId,
    renderJobId: request.renderJobId,
    qualityReviewRunId: request.qualityReviewRunId,
    scheduledAt: request.scheduledAt,
    status: scheduled ? "SCHEDULED" : "DRAFT",
    disclosureDecision: request.disclosure.decision,
    disclosureText:
      request.disclosure.decision === "DISCLOSE" ? request.disclosure.disclosureText : null,
    disclosureReason: request.disclosure.reason,
    destinations: request.destinations.map((destination) => ({
      ...post.destinations[0]!,
      platform: destination.platform,
      socialAccountId: destination.socialAccountId,
      status: scheduled ? "SCHEDULED" : "DRAFT",
      remotePostId: null,
      publishedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      latestAttempt: null,
    })),
  };
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  const method = init?.method ?? "GET";
  calls.push({
    path: `${path}${url.search}`,
    method,
    body: typeof init?.body === "string" ? init.body : null,
  });
  const publishing = path.slice(path.indexOf("/publishing"));
  const destinationMatch = path.match(
    /\/destinations\/([^/]+)\/(preflight|publish|retry|reconcile)$/,
  );
  const postMatch = path.match(/\/publishing\/posts\/([^/]+)(?:\/(cancel))?$/);

  if (path.endsWith("/publishing/platforms"))
    return json(
      mode === "unavailable"
        ? platforms.map((item) => ({
            ...item,
            connectable: false,
            publishable: false,
            reasonCode:
              item.platform === "INSTAGRAM" ? "INSTAGRAM_NOT_VERIFIED" : "PLATFORM_NOT_CONFIGURED",
          }))
        : platforms,
    );
  if (path.endsWith("/social-accounts")) return json(currentAccounts);
  if (method === "POST" && path.includes("/social-accounts/")) {
    accountCalls += 1;
    if (mode === "accounts-interrupted" && accountCalls === 1)
      return json({ message: "Interrupted" }, 503);
    if (path.endsWith("/connect"))
      return json({
        authorizationUrl: "https://oauth.fixture.test/authorize",
      });
    if (path.endsWith("/revoke"))
      currentAccounts = currentAccounts.map((account) => ({
        ...account,
        status: "REVOKED",
        health: "UNAVAILABLE",
      }));
    return json({});
  }
  if (path.endsWith("/channels")) return json(channels);
  if (path.endsWith("/publishing/eligible-renders"))
    return json({ items: [eligibleRender], nextCursor: null });
  if (path.endsWith("/publishing/published-records")) return json([publishedRecord]);
  if (path.endsWith("/publishing/calendar")) return json([current]);
  if (publishing === "/publishing/posts" && method === "GET")
    return json({ items: current.scheduledAt === null ? [current] : [], nextCursor: null });

  if (destinationMatch) {
    const [, id, action] = destinationMatch;
    if (action === "preflight")
      return json({
        ...(mode === "preflight-failure" ? blockedPreflight : passingPreflight),
        destinationId: id,
      });
    if (mode === "preflight-failure" && action === "publish")
      return json({ message: "Preflight gates failed" }, 409);
    current = {
      ...current,
      status: "PUBLISHED",
      destinations: current.destinations.map((item) =>
        item.id === id
          ? {
              ...item,
              status: "PUBLISHED",
              remotePostId: "fixture-platform-post",
              publishedAt: "2026-11-13T11:00:00.000Z",
              lastErrorCode: null,
              lastErrorMessage: null,
            }
          : item,
      ),
    };
    return json(current);
  }

  if (publishing === "/publishing/posts" && method === "POST") {
    createCalls += 1;
    if (mode === "recovery" && createCalls === 1) return json({ message: "Unavailable" }, 503);
    const request = JSON.parse(String(init?.body)) as CreatePostRequest;
    current = createFromRequest(request);
    return json(current);
  }

  if (postMatch && postMatch[2] === "cancel") {
    current = {
      ...current,
      status: "CANCELED",
      destinations: current.destinations.map((item) => ({ ...item, status: "CANCELED" })),
    };
    return json(current);
  }

  if (postMatch && method === "PATCH") {
    const body = JSON.parse(String(init?.body)) as { scheduledAt: string | null };
    current = {
      ...current,
      scheduledAt: body.scheduledAt,
      status: body.scheduledAt === null ? "DRAFT" : "SCHEDULED",
    };
    return json(current);
  }

  if (postMatch && method === "GET") return json(current);

  if (path.includes("/social-accounts/") && method === "POST") return json({});

  return json({ message: `Unhandled fixture path ${path}` }, 404);
};

function Fixture(): JSX.Element {
  let content: JSX.Element;
  if (mode.startsWith("accounts") || mode === "connect-error") content = <Accounts />;
  else if (mode === "history") content = <History />;
  else if (mode === "calendar" || mode === "calendar-mobile") content = <Calendar />;
  else if (mode.startsWith("post-") || mode === "retry" || mode === "scheduled")
    content = <PostDetail postId={post.id} />;
  else content = <Composer />;
  return (
    <AppShell>
      <WorkspaceProvider workspace={{ id: workspaceId, name: "Fixture studio", role }}>
        <PublishingScope>{content}</PublishingScope>
      </WorkspaceProvider>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);

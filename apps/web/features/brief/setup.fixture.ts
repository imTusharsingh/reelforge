import { defaultBrief } from "../../../../packages/contracts/src/channel-brief";
import type {
  ChannelBrief,
  ProviderCapability,
} from "../../../../packages/contracts/src/foundations";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const channelId = "22222222-2222-4222-8222-222222222222";
export const brief: ChannelBrief = {
  ...defaultBrief({
    niche: "Science",
    audience: "Adults",
    language: "English",
    voiceId: "Kore",
    cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
  }),
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId,
  channelId,
  version: 1,
  schemaVersion: "1.0",
};
export const capability: ProviderCapability = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId,
  schemaVersion: "1.0",
  providerId: "gemini",
  modelId: "gemini-omni-1.2-flash",
  kind: "VIDEO",
  aspects: ["9:16"],
  maxReferenceImages: 6,
  firstLastFrame: true,
  minExtensionSeconds: 3,
  maxExtensionPerTurnSeconds: 10,
  maxExtensionSeconds: 30,
  nativeAudio: true,
  health: "NOT_CONFIGURED",
  pricePerSecond: { "360p": 23000, "720p": 69504, "1080p": 104000 },
  enabled: true,
  supportsReferenceImages: true,
  supportsAudio: true,
  asynchronous: true,
  polling: true,
  minDurationSeconds: 3,
  maxDurationSeconds: 15,
  resolutions: [{ width: 720, height: 1280 }],
  frameRates: [24],
  regions: [],
  cost: { currency: "USD", unit: "second", estimateMinor: null },
};
export const runId = "55555555-5555-4555-8555-555555555555";

/** Explicit test-only V2/V3 stub. It stores configuration booleans, never secret values. */
type SetupStub = {
  fetch: typeof fetch;
  calls: { path: string; method: string }[];
  versions: ChannelBrief[];
  keys: { gemini: boolean; xai: boolean };
  failRun: boolean;
  fail: boolean;
  approved: number;
};
export function setupStub(): SetupStub {
  const state = {
    calls: [] as { path: string; method: string }[],
    versions: [structuredClone(brief)],
    keys: { gemini: false, xai: false },
    failRun: false,
    fail: false,
    approved: 0,
    fetch: (async (): Promise<Response> => new Response()) as typeof fetch,
  };
  state.fetch = async (url, init): Promise<Response> => {
    const path = String(url);
    const method = init?.method ?? "GET";
    state.calls.push({ path, method });
    if (state.fail || (state.failRun && path.endsWith("/runs")))
      return Response.json({ message: "unavailable" }, { status: 503 });
    if (path.endsWith("/workspaces"))
      return Response.json(
        method === "POST"
          ? { id: workspaceId, name: "Science" }
          : [{ id: workspaceId, name: "Science", role: "OWNER" }],
      );
    if (path.endsWith("/channels")) return Response.json({ id: channelId, workspaceId });
    if (path.endsWith("/briefs/eligibility"))
      return Response.json({ approvedShorts: state.approved, offerL3: state.approved >= 10 });
    if (path.endsWith("/briefs")) {
      if (method === "POST") {
        const input: object = JSON.parse(String(init?.body));
        const next = { ...brief, ...input, version: state.versions.length + 1 };
        state.versions.unshift(next);
        return Response.json(next);
      }
      return Response.json(state.versions);
    }
    if (path.endsWith("/providers/keys")) return Response.json(state.keys);
    if (path.endsWith("/key")) {
      const provider = path.split("/").at(-2);
      if (provider === "gemini" || provider === "xai") state.keys[provider] = true;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/providers/health")) return Response.json([capability]);
    if (path.endsWith("/runs")) return Response.json({ id: runId }, { status: 202 });
    return Response.json({}, { status: 404 });
  };
  return state;
}

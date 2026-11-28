import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
export const workspaceId = "00000000-0000-4000-8000-000000000001";
export const runId = "00000000-0000-4000-8000-000000000003";
export function detail(): RunDetailView {
  return {
    run: {
      id: runId,
      channelId: "00000000-0000-4000-8000-000000000004",
      state: "AWAITING_APPROVAL",
      requestedAutonomy: "L2",
      effectiveAutonomy: "L2",
      approvedShortsAtStart: 0,
      pauseReason: null,
    },
    envelope: { spentMinor: 579, hardCapMinor: 800 },
    artifactUrls: [],
    steps: [
      {
        id: "00000000-0000-4000-8000-000000000005",
        key: "CRITIC",
        attempt: 1,
        state: "SUCCEEDED",
        providerId: null,
        costMinor: null,
        input: {},
        output: {
          result: {
            recommendation: "APPROVE",
            summary: "Ready to publish",
            gates: {
              policy: true,
              rights: true,
              technical: true,
              budget: true,
              permission: true,
              score: true,
            },
          },
        },
      },
    ],
  };
}
export function levelTwoPlanning(): RunDetailView {
  const fixture = detail();
  fixture.run = { ...fixture.run, state: "PLANNING" };
  fixture.steps = [];
  fixture.completedStages = [];
  return fixture;
}
export class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  public readonly listeners = new Map<string, EventListener>();
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed = false;
  public constructor(
    public readonly url: string,
    public readonly options: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  public close(): void {
    this.closed = true;
  }
  public emit(type: string, sequence: number): void {
    this.listeners.get(type)?.(
      new MessageEvent(type, { lastEventId: String(sequence), data: "{}" }),
    );
  }
}

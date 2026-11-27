import { RunEventSchema, type RunEvent } from "@reelforge/contracts";
import { Redis } from "ioredis";
import { Observable } from "rxjs";
import type { MessageEvent } from "@nestjs/common";
import type { Context, Event } from "./runs.types.js";
import type { RunsStore } from "./runs.store.js";

/** Postgres is the replay log. Redis is a wake-up signal, never the ordering authority. */
export class RunsEvents {
  private readonly publisher: Redis;
  private subscriber?: Redis;
  private readonly listeners = new Map<string, Set<() => void>>();

  private watch(channel: string, drain: () => void): () => void {
    if (!this.subscriber) {
      this.subscriber = this.publisher.duplicate();
      this.subscriber.on("error", () => undefined);
      this.subscriber.on("message", (name: string) => {
        for (const wake of this.listeners.get(name) ?? []) wake();
      });
    }
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
      void this.subscriber.subscribe(channel).then(drain, drain);
    }
    listeners.add(drain);
    drain();
    return () => {
      listeners.delete(drain);
      if (!listeners.size) {
        this.listeners.delete(channel);
        void this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }
  public constructor(
    private readonly store: RunsStore,
    redisUrl: string,
  ) {
    this.publisher = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.publisher.on("error", () => undefined);
  }
  public async publish(event: Event): Promise<void> {
    // A missed wake-up cannot lose a committed event: subscribers also drain periodically.
    await this.publisher
      .publish(`runs:${event.workspaceId}:${event.runId}`, JSON.stringify(this.contract(event)))
      .catch(() => undefined);
  }
  public stream(context: Context, runId: string, after: number): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      let pending = false;
      let cursor = after,
        draining = false,
        closed = false;
      const drain = async (): Promise<void> => {
        if (closed) return;
        if (draining) {
          pending = true;
          return;
        }
        draining = true;
        try {
          let batch: Event[];
          do {
            pending = false;
            batch = await this.store.events(context, runId, cursor);
            for (const event of batch) {
              if (closed) return;
              subscriber.next({
                id: String(event.sequence),
                type: event.type,
                data: this.contract(event),
              });
              cursor = event.sequence;
            }
          } while (!closed && (pending || batch.length === 500));
        } catch (error) {
          subscriber.error(error);
        } finally {
          draining = false;
        }
      };
      const unwatch = this.watch(`runs:${context.workspaceId}:${runId}`, () => void drain());
      const heartbeat = setInterval(() => subscriber.next({ comment: "keepalive" }), 15000);
      const fallback = setInterval(() => void drain(), 30000);
      return (): void => {
        closed = true;
        clearInterval(heartbeat);
        clearInterval(fallback);
        unwatch();
      };
    });
  }
  private contract(event: Event): RunEvent {
    return RunEventSchema.parse({
      id: event.id,
      workspaceId: event.workspaceId,
      schemaVersion: event.schemaVersion,
      runId: event.runId,
      stepId: event.stepId,
      sequence: event.sequence,
      type: event.type,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    });
  }
  public async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.publisher.disconnect();
  }
}

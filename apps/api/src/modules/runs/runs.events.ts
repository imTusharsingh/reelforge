import { RunEventSchema, type RunEvent } from "@reelforge/contracts";
import { Redis } from "ioredis";
import { Observable } from "rxjs";
import type { MessageEvent } from "@nestjs/common";
import type { Context, Event } from "./runs.types.js";
import type { RunsStore } from "./runs.store.js";

/** Postgres is the replay log. Redis is a wake-up signal, never the ordering authority. */
export class RunsEvents {
  private readonly publisher: Redis;
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
      const redis = this.publisher.duplicate();
      let cursor = after,
        draining = false,
        closed = false;
      const drain = async (): Promise<void> => {
        if (closed || draining) return;
        draining = true;
        try {
          let batch: Event[];
          do {
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
          } while (batch.length === 500);
        } catch (error) {
          subscriber.error(error);
        } finally {
          draining = false;
        }
      };
      redis.on("error", () => undefined);
      redis.on("message", () => {
        void drain();
      });
      void redis.subscribe(`runs:${context.workspaceId}:${runId}`).then(drain).catch(drain);
      const timer = setInterval(() => {
        void drain();
      }, 1000);
      return (): void => {
        closed = true;
        clearInterval(timer);
        redis.disconnect();
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
    this.publisher.disconnect();
  }
}

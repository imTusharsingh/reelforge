import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProviderHttp } from "./http.js";
import { Interactions } from "./interactions.js";
import { createPaidTextTransport, type PaidTextTransport } from "./paid-text-transport.js";
import { GeminiText } from "./text.js";

const key = "AIza" + "aB1".repeat(12);
const dispatchKey = "local-dispatch-key";
const spec = {
  prompt: "a deterministic test prompt",
  jsonSchema: { type: "object" },
  parse: (value: unknown): unknown => value,
};
const usage = { input_tokens: 10 };

function harness(): {
  port: GeminiText;
  transport: PaidTextTransport;
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  req: EventEmitter;
  reply: (status: number, body: unknown) => void;
  headers: (status: number) => PassThrough;
} {
  const req = new EventEmitter();
  const end = vi.fn();
  const destroy = vi.fn();
  let onResponse: ((value: IncomingMessage) => void) | undefined;
  let signal: AbortSignal | undefined;
  const send = vi.fn(
    (_url: string, _options: RequestOptions, response: (value: IncomingMessage) => void) => {
      onResponse = response;
      signal = _options.signal;
      return Object.assign(req, { end, destroy }) as unknown as ClientRequest;
    },
  );
  const paidTransport = createPaidTextTransport(send);
  const http = new ProviderHttp(key, "gemini", undefined, 1000, paidTransport);
  const client = new Interactions(http, {
    save: async (): Promise<never> => {
      throw new Error("unexpected media request");
    },
  });
  const headers = (status: number): PassThrough => {
    const stream = Object.assign(new PassThrough(), {
      statusCode: status,
      rawHeaders: ["Content-Type", "application/json"],
    });
    signal?.addEventListener("abort", () => stream.destroy(new Error("response timed out")), {
      once: true,
    });
    onResponse?.(stream as unknown as IncomingMessage);
    return stream;
  };
  return {
    port: new GeminiText(client, "fixture"),
    transport: paidTransport,
    send,
    end,
    req,
    headers,
    reply: (status, body): void => {
      headers(status).end(JSON.stringify(body));
    },
  };
}

describe("paid Gemini text wire evidence", () => {
  it("does not record handoff merely after invoking end or after a pre-handoff reset", async () => {
    const { port, send, end, req } = harness();
    const sent = vi.fn(async (): Promise<void> => Promise.resolve());
    const completion = port.completePaid(spec, dispatchKey, sent);
    expect(end).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
    req.emit("error", new Error("reset before finish"));
    await expect(completion).rejects.toMatchObject({ kind: "OUTAGE", dispatched: true });
    expect(sent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("awaits persistence of the actual handoff even if the response is lost", async () => {
    const { port, send, end, req } = harness();
    const persistence = Promise.withResolvers<void>();
    const sent = vi.fn(() => persistence.promise);
    const failure = port.completePaid(spec, dispatchKey, sent).catch((error: unknown) => error);
    const finished = vi.fn();
    void failure.then(finished);
    expect(sent).not.toHaveBeenCalled();
    req.emit("finish");
    req.emit("error", new Error("remote reset after finish"));
    await Promise.resolve();
    expect(sent).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    persistence.resolve();
    expect(await failure).toMatchObject({ kind: "OUTAGE", dispatched: true });
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toMatchObject({
      store: false,
      background: false,
    });
  });

  it("returns a real provider completion even if writing handoff evidence fails", async () => {
    const { port, send, req, reply } = harness();
    const sent = vi.fn().mockRejectedValueOnce(new Error("handoff journal unavailable"));
    const completion = port.completePaid(spec, dispatchKey, sent);
    req.emit("finish");
    reply(200, {
      id: "google-job",
      status: "completed",
      usage,
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"score":8}' }] }],
    });
    await expect(completion).resolves.toEqual({
      output: { score: 8 },
      dispatchKey,
      providerJobId: "google-job",
      usage,
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([200, 401])(
    "consumes the streaming %s response while handoff persistence stalls",
    async (status) => {
      const { port, req, headers } = harness();
      const stalled = Promise.withResolvers<void>();
      const sent = vi.fn(() => stalled.promise);
      const pending = port.completePaid(spec, dispatchKey, sent);
      const result = pending.catch((error: unknown) => error);
      try {
        req.emit("finish");
        const stream = headers(status);
        stream.write("{");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sent).toHaveBeenCalledOnce();
        stream.end(
          JSON.stringify(
            status === 401
              ? { error: { status: "UNAUTHENTICATED" } }
              : {
                  status: "completed",
                  usage,
                  steps: [
                    { type: "model_output", content: [{ type: "text", text: '{"ok":true}' }] },
                  ],
                },
          ).slice(1),
        );
        expect(await result).toMatchObject(
          status === 401
            ? { dispatched: false, http: { status, code: "UNAUTHENTICATED" } }
            : { dispatchKey, output: { ok: true } },
        );
      } finally {
        stalled.resolve();
      }
    },
  );

  it("preserves the original socket reset when writing handoff evidence also fails", async () => {
    const { transport, send, req } = harness();
    const sent = vi.fn().mockRejectedValueOnce(new Error("handoff journal unavailable"));
    const reset = new Error("original socket reset");
    const pending = transport(
      "https://fixture.invalid/interactions",
      { body: "{}", headers: {}, signal: new AbortController().signal },
      sent,
    );
    req.emit("finish");
    req.emit("error", reset);
    await expect(pending).rejects.toBe(reset);
    expect(sent).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("retains definitive Google rejection only when response content confirms it", async () => {
    const confirmed = harness();
    const sent = vi.fn().mockRejectedValueOnce(new Error("handoff journal unavailable"));
    const rejected = confirmed.port.completePaid(spec, dispatchKey, sent);
    confirmed.req.emit("finish");
    confirmed.reply(400, { error: { status: "INVALID_ARGUMENT" } });
    await expect(rejected).rejects.toMatchObject({
      kind: "INVALID",
      dispatched: false,
      http: { status: 400, code: "INVALID_ARGUMENT" },
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(confirmed.send).toHaveBeenCalledOnce();

    const ambiguous = harness();
    const noHandoff = vi.fn();
    const lost = ambiguous.port.completePaid(spec, dispatchKey, noHandoff);
    ambiguous.reply(504, { error: { code: 504 } });
    await expect(lost).rejects.toMatchObject({
      kind: "OUTAGE",
      dispatched: true,
      http: { status: 504 },
    });
    expect(noHandoff).not.toHaveBeenCalled();
  });

  it("retains separate correlation for id-less results and real Google evidence for invalid output", async () => {
    const completed = {
      status: "completed",
      usage,
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"score":8}' }] }],
    };
    const valid = harness();
    const receipt = valid.port.completePaid(spec, dispatchKey);
    valid.req.emit("finish");
    valid.reply(200, completed);
    expect(await receipt).toEqual({
      providerJobId: null,
      dispatchKey,
      output: { score: 8 },
      usage,
    });
    const invalid = harness();
    const unusable = invalid.port.completePaid(spec, dispatchKey);
    invalid.req.emit("finish");
    invalid.reply(200, { ...completed, id: "google-job", steps: [] });
    await expect(unusable).rejects.toMatchObject({
      providerJobId: "google-job",
      dispatchKey,
      usage,
    });
  });

  it("fails without dispatch when a custom fetcher supplied no paid transport", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new ProviderHttp(key, "gemini", fetcher);
    const client = new Interactions(http, {
      save: async (): Promise<never> => {
        throw new Error("unexpected media request");
      },
    });
    await expect(
      new GeminiText(client, "fixture").completePaid(spec, dispatchKey),
    ).rejects.toMatchObject({
      kind: "NOT_CONFIGURED",
      dispatched: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

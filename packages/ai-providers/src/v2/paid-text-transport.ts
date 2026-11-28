import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export type PaidTextRequest = Readonly<{
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}>;

export type PaidTextTransport = (
  url: string,
  input: PaidTextRequest,
  onBodySent: () => Promise<void>,
) => Promise<Response>;

type HttpsRequest = (
  url: string,
  options: RequestOptions,
  onResponse: (incoming: IncomingMessage) => void,
) => ClientRequest;

function readResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 502;
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2)
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  if ([204, 205, 304].includes(status)) {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers });
}

/** A single POST, without redirects or automatic replays. The finish event is local wire evidence. */
export function createPaidTextTransport(send: HttpsRequest = request): PaidTextTransport {
  return async (url, input, onBodySent): Promise<Response> => {
    let req: ClientRequest | undefined;
    let handoff: Promise<void> | undefined;
    const pending = new Promise<Response>((resolve, reject) => {
      req = send(
        url,
        {
          method: "POST",
          agent: false,
          signal: input.signal,
          headers: {
            ...input.headers,
            "Content-Length": String(Buffer.byteLength(input.body, "utf8")),
            "Accept-Encoding": "identity",
          },
        },
        (incoming) => {
          try {
            resolve(readResponse(incoming));
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      req.once("error", reject);
      // Node emits finish after handing the last request bytes to the OS, not when end() is called.
      // It does NOT mean the provider has accepted, completed, or billed the interaction.
      req.once("finish", () => {
        // Handoff persistence is independent evidence: its failure cannot replace
        // the stronger provider response, or disguise the original transport error.
        handoff = Promise.resolve()
          .then(onBodySent)
          .catch(() => undefined);
      });
      req.end(input.body);
    });
    try {
      return await pending;
    } catch (error) {
      req?.destroy();
      await handoff;
      throw error;
    }
  };
}

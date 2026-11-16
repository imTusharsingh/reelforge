import { ProviderFailure, record, requiredString } from "./http.js";
import { Interactions } from "./interactions.js";
import type { TextPort, TextSpec } from "./ports.js";

export class GeminiText implements TextPort {
  public constructor(
    private readonly client: Interactions,
    private readonly model: string,
  ) {}
  public async complete<T>(
    spec: TextSpec<T>,
    key: string,
  ): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> {
    if (!spec.prompt.trim()) throw new ProviderFailure("INVALID", false);
    const response = await this.client.result(
      {
        model: this.model,
        input: [{ type: "text", text: spec.prompt }, ...(spec.media ?? [])],
        ...(spec.systemPrompt ? { system_instruction: spec.systemPrompt } : {}),
        ...(spec.grounding ? { tools: [{ type: "google_search" }] } : {}),
        response_format: { type: "json", schema: spec.jsonSchema },
      },
      key,
    );
    return {
      ...this.parseResponse(response, spec.parse),
      providerJobId: requiredString(response.id),
    };
  }

  public async submit<T>(spec: TextSpec<T>, key: string): Promise<{ providerJobId: string }> {
    if (!spec.prompt.trim()) throw new ProviderFailure("INVALID", false);
    return this.client.submit(
      {
        model: this.model,
        input: [{ type: "text", text: spec.prompt }, ...(spec.media ?? [])],
        ...(spec.systemPrompt ? { system_instruction: spec.systemPrompt } : {}),
        ...(spec.grounding ? { tools: [{ type: "google_search" }] } : {}),
        response_format: { type: "json", schema: spec.jsonSchema },
      },
      key,
    );
  }
  public poll(id: string): ReturnType<Interactions["poll"]> {
    return this.client.poll(id);
  }
  public async fetch<T>(
    id: string,
    parse: (value: unknown) => T,
  ): Promise<{ output: T; usage: Record<string, unknown> }> {
    return this.parseResponse(await this.client.get(id), parse);
  }
  private parseResponse<T>(
    response: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): { output: T; usage: Record<string, unknown> } {
    if (response.status === "refused") throw new ProviderFailure("REFUSAL", true);
    if (response.status !== "completed") throw new ProviderFailure("INVALID", true);
    const output = this.client
      .outputs(response)
      .filter((item) => item.type === "text")
      .map((item) => requiredString(item.text))
      .join("");
    try {
      return {
        output: parse(JSON.parse(output) as unknown),
        usage: response.usage ? record(response.usage) : {},
      };
    } catch {
      throw new ProviderFailure("INVALID", true);
    }
  }
}

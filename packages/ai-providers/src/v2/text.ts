import { ProviderFailure, record, requiredString } from "./http.js";
import { Interactions } from "./interactions.js";
import type { TextPort, TextSpec } from "./ports.js";

/** The provider completed the call and returned billing evidence, but no usable output. */
export class InvalidCompletedText extends ProviderFailure {
  public constructor(
    public readonly providerJobId: string,
    public readonly usage: Record<string, unknown>,
  ) {
    super("INVALID", true);
  }
}

export class GeminiText implements TextPort {
  public constructor(
    private readonly client: Interactions,
    private readonly model: string,
  ) {}
  public async complete<T>(
    spec: TextSpec<T>,
    key: string,
  ): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> {
    if (!key.trim() || !spec.prompt.trim()) throw new ProviderFailure("INVALID", false);
    const response = await this.client.result(
      {
        model: this.model,
        input: [{ type: "text", text: spec.prompt }, ...(spec.media ?? [])],
        ...(spec.systemPrompt ? { system_instruction: spec.systemPrompt } : {}),
        ...(spec.grounding ? { tools: [{ type: "google_search" }] } : {}),
        response_format: { type: "text", mime_type: "application/json", schema: spec.jsonSchema },
      },
      key,
    );
    // Unstored sync completions may omit id. Correlate the terminal receipt with the
    // original dispatch key; replaying a paid POST to obtain a remote id is unsafe.
    const reference = typeof response.id === "string" && response.id.trim() ? response.id : key;
    try {
      return {
        ...this.parseResponse(response, spec.parse),
        providerJobId: reference,
      };
    } catch (error) {
      if (response.status !== "completed") throw error;
      const usage = response.usage;
      throw new InvalidCompletedText(
        reference,
        usage && typeof usage === "object" && !Array.isArray(usage) ? record(usage) : {},
      );
    }
  }

  public async submit<T>(spec: TextSpec<T>, key: string): Promise<{ providerJobId: string }> {
    if (!spec.prompt.trim()) throw new ProviderFailure("INVALID", false);
    return this.client.submit(
      {
        model: this.model,
        input: [{ type: "text", text: spec.prompt }, ...(spec.media ?? [])],
        ...(spec.systemPrompt ? { system_instruction: spec.systemPrompt } : {}),
        ...(spec.grounding ? { tools: [{ type: "google_search" }] } : {}),
        response_format: { type: "text", mime_type: "application/json", schema: spec.jsonSchema },
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

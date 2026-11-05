import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, PaginationRequestSchema } from "./api.js";

describe("shared API contracts", () => {
  it("rejects error envelopes without correlation IDs", () => {
    expect(() => ErrorEnvelopeSchema.parse({ error: { code: "BAD_REQUEST", message: "Invalid" } })).toThrow();
  });

  it("enforces the maximum page size", () => {
    expect(() => PaginationRequestSchema.parse({ limit: 101 })).toThrow();
  });
});

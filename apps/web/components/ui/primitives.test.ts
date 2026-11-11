import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./primitives.tsx", import.meta.url), "utf8");

describe("M21 shared primitives source contracts", () => {
  it("declares loading, disabled and busy button states", () => {
    expect(source).toContain("disabled={disabled || loading}");
    expect(source).toContain("aria-busy={loading || undefined}");
  });

  it("associates text-field hints and errors with their labels", () => {
    expect(source).toContain("<label htmlFor={id}>");
    expect(source).toContain("aria-describedby={helpId}");
    expect(source).toContain("aria-invalid={Boolean(error) || undefined}");
  });

  it("uses named error alerts and status messages", () => {
    expect(source).toContain('kind === "error" ? "alert" : "status"');
    expect(source).toContain('tone === "danger" ? "alert" : "status"');
    expect(source).toContain("title: string;");
  });
});

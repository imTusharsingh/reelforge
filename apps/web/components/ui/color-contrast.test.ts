import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("../../styles/design-tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = tokens.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i"));
  if (!match?.[1]) throw new Error(`Unknown hex token: ${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const values = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}

function ratio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

describe("M21 static token contrast checks", () => {
  it("keeps primary action text legible at normal text size", () => {
    expect(ratio(token("rf-ink"), token("rf-orange"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("rf-paper"), token("rf-orange-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps brand navigation text and light surfaces legible", () => {
    expect(ratio(token("rf-canvas-warm"), token("rf-ink"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("rf-ink"), token("rf-paper"))).toBeGreaterThanOrEqual(4.5);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(new URL("../../styles/design-tokens.css", import.meta.url), "utf8");
const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const [lightTokens = "", darkTokens = ""] = tokens.split('[data-theme="dark"]');

function token(name: string, dark = false): string {
  const expression = new RegExp(`--${name}: ([^;]+);`);
  const fromDark = dark ? darkTokens.match(expression)?.[1] : undefined;
  const raw = fromDark ?? lightTokens.match(expression)?.[1];
  if (!raw) throw new Error(`Missing semantic token: ${name}`);
  const reference = /^var\(--([\w-]+)\)$/.exec(raw.trim());
  if (reference) return token(reference[1]!, dark);
  if (!/^#[0-9a-f]{6}$/i.test(raw.trim())) {
    throw new Error(`Expected six-digit sRGB color for ${name}: ${raw}`);
  }
  return raw.trim();
}

function luminance(hex: string): number {
  const values = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("M21 semantic accent contrast", () => {
  it.each([false, true])("keeps primary and hover text >= 4.5:1 (dark=%s)", (dark) => {
    const primaryText = token("rf-on-accent", dark);
    const primaryBackground = token("rf-accent", dark);
    expect(contrast(primaryText, primaryBackground)).toBeGreaterThanOrEqual(4.5);
    const hoverText = token("rf-on-accent-hover", dark);
    const hoverBackground = token("rf-accent-hover", dark);
    expect(contrast(hoverText, hoverBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it("requires the actual component styles to consume semantic foregrounds", () => {
    expect(css).toContain(".rf-button--primary {\n  color: var(--rf-on-accent);");
    expect(css).toContain("color: var(--rf-on-accent-hover);");
    expect(css).toContain(".rf-hero-glyph {\n  background: var(--rf-accent);\n  color: var(--rf-on-accent);");
  });
});

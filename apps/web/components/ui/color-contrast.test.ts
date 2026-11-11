import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokenFile = new URL("../../styles/design-tokens.css", import.meta.url);
const styleFile = new URL("../../app/globals.css", import.meta.url);
const tokens = readFileSync(tokenFile, "utf8");
const styles = readFileSync(styleFile, "utf8");
const parts = tokens.split('[data-theme="dark"]');
const lightTokens = parts[0] ?? "";
const darkTokens = parts[1] ?? "";

function color(name: string, dark: boolean): string {
  const pattern = new RegExp(`--${name}: ([^;]+);`);
  const override = dark ? darkTokens.match(pattern)?.[1] : undefined;
  const value = override ?? lightTokens.match(pattern)?.[1];
  if (!value) throw new Error(`Missing token: ${name}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(value.trim());
  if (alias) return color(alias[1]!, dark);
  if (!/^#[0-9a-f]{6}$/i.test(value.trim())) {
    throw new Error(`Non-color token: ${name}`);
  }
  return value.trim();
}

function luminance(hex: string): number {
  const components = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const red = components[0]! * 0.2126;
  const green = components[1]! * 0.7152;
  const blue = components[2]! * 0.0722;
  return red + green + blue;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("M21 semantic accent contrast", () => {
  it.each([false, true])("checks both themes (dark=%s)", (dark) => {
    const foreground = color("rf-on-accent", dark);
    const background = color("rf-accent", dark);
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);

    const hoverText = color("rf-on-accent-hover", dark);
    const hoverBackground = color("rf-accent-hover", dark);
    expect(contrast(hoverText, hoverBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it("requires the stylesheet to use semantic foregrounds", () => {
    expect(styles).toContain("color: var(--rf-on-accent);");
    expect(styles).toContain("color: var(--rf-on-accent-hover);");
    expect(styles).toContain("background: var(--rf-accent);");
  });
});

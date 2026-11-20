import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("creator studio shell accessibility", () => {
  it("uses a mobile dialog and restores focus to the opener", () => {
    expect(shell).toContain('aria-haspopup="dialog"');
    expect(shell).toContain('title="Studio navigation"');
    expect(shell).toContain("menu.current?.showModal()");
    expect(shell).toContain("trigger.current?.focus()");
    expect(styles).toContain(".rf-menu-toggle");
  });

  it("provides skip navigation, current-page semantics and session actions", () => {
    expect(shell).toContain('href="#main-content"');
    expect(shell).toContain("studioDestinations()");
    expect(shell).toContain("aria-current={");
    expect(shell).toContain("shellActions");
  });
});

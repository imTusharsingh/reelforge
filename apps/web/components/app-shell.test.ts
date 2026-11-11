import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("M21 responsive shell source contracts", () => {
  it("keeps an inspector trigger and labelled native dialog", () => {
    expect(shell).toContain('aria-haspopup="dialog"');
    expect(shell).toContain("View context");
    expect(shell).toContain('aria-label="Context panel"');
    expect(shell).toContain('label="Close context panel"');
    expect(shell).toContain("inspectorDialog.current?.showModal()");
    expect(shell).toContain("inspectorDialog.current?.close()");
  });

  it("returns focus when either dialog closes", () => {
    expect(shell).toContain("inspectorTrigger.current?.focus()");
    expect(shell).toContain("trigger.current?.focus()");
  });

  it("makes the mobile context accessible with a visible toggle", () => {
    expect(styles).toContain(".rf-inspector-trigger {");
    expect(styles).toContain("display: inline-flex;");
    expect(styles).toContain(".rf-context-dialog {");
    expect(styles).toContain(".rf-context-dialog::backdrop {");
  });

  it("keeps Operations as a real enabled route with active-page semantics", () => {
    expect(shell).toContain('{ name: "Operations", href: "/operations" }');
    expect(shell).toContain('aria-current={pathname === href ? "page" : undefined}');
    expect(shell).toContain("shellActions");
  });
});

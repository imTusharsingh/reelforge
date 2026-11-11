import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("M21 responsive context access", () => {
  it("renders the context dialog, accessible trigger and close action", () => {
    const inspector = createElement("p", null, "Selected item details");
    const children = createElement("h1", null, "Overview");
    const app = createElement(AppShell, { inspector, children });
    const html = renderToStaticMarkup(app);
    expect(html).toContain("View context");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Context panel"');
    expect(html).toContain('aria-label="Close context panel"');
    expect(html).toContain("Selected item details");
    expect(html).toContain('class="rf-inspector"');
  });

  it("omits context dialog and trigger when no inspector exists", () => {
    const children = createElement("h1", null, "Overview");
    const app = createElement(AppShell, { children });
    const html = renderToStaticMarkup(app);
    expect(html).not.toContain("View context");
    expect(html).not.toContain('aria-label="Context panel"');
  });

  it("shows a context disclosure below the desktop breakpoint", () => {
    expect(styles).toContain(".rf-inspector-trigger {");
    expect(styles).toContain("display: inline-flex;");
    expect(styles).toContain(".rf-context-dialog {");
    expect(styles).toContain(".rf-context-dialog::backdrop {");
  });
});

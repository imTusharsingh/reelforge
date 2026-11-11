import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("M21 responsive context access", () => {
  it("renders a real context drawer trigger and labelled native dialog", () => {
    const html = renderToStaticMarkup(
      <AppShell inspector={<p>Selected item details</p>}>
        <h1>Overview</h1>
      </AppShell>,
    );
    expect(html).toContain("View context");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Context panel"');
    expect(html).toContain('aria-label="Close context panel"');
    expect(html).toContain("Selected item details");
    expect(html).toContain('class="rf-inspector"');
  });

  it("omits the context drawer trigger if no inspector was supplied", () => {
    const html = renderToStaticMarkup(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    expect(html).not.toContain("View context");
    expect(html).not.toContain('aria-label="Context panel"');
  });

  it("has a small-screen toggle instead of permanently hidden context", () => {
    expect(styles).toContain(".rf-inspector-trigger {");
    expect(styles).toContain("display: inline-flex;");
    expect(styles).toContain(".rf-context-dialog {");
    expect(styles).toContain(".rf-context-dialog::backdrop {");
  });
});

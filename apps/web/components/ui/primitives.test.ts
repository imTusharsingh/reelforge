import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert, Badge, Button, Field, StateMessage } from "./primitives";

describe("M21 shared UI accessibility and state contracts", () => {
  it("disables a loading button and announces busy state", () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true }, "Save"));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Working…");
  });

  it("associates field labels and validation errors", () => {
    const field = createElement(Field, { id: "name", label: "Workspace name", error: "Name required" });
    const html = renderToStaticMarkup(field);
    expect(html).toContain('for="name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="name-help"');
    expect(html).toContain('id="name-help"');
  });

  it("exposes errors as alerts with actionable description", () => {
    const html = renderToStaticMarkup(
      createElement(StateMessage, {
        kind: "error",
        description: "Try again after checking your connection.",
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
  });

  it("pairs status colors with text", () => {
    const html = renderToStaticMarkup(createElement(Badge, { tone: "warning" }, "Not configured"));
    expect(html).toContain("Not configured");
    expect(html).toContain("rf-badge--warning");
  });

  it("provides an explicit alert title", () => {
    const alert = createElement(Alert, { tone: "danger", title: "Unable to save" }, "Check connection.");
    const html = renderToStaticMarkup(alert);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Unable to save");
  });
});

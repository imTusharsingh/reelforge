import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Alert, Badge, Button, Field, StateMessage } from "./primitives";

describe("M21 shared UI accessibility and state contracts", () => {
  it("disables a loading button and announces busy state", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Working…");
  });

  it("keeps a field label and error association", () => {
    const html = renderToStaticMarkup(
      <Field id="name" label="Workspace name" error="A name is required" />,
    );
    expect(html).toContain('for="name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="name-help"');
    expect(html).toContain('id="name-help"');
  });

  it("renders recoverable error information with alert semantics", () => {
    const html = renderToStaticMarkup(
      <StateMessage kind="error" description="Try again after checking your connection." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
  });

  it("pairs a meaningful status label with a tone", () => {
    const html = renderToStaticMarkup(<Badge tone="warning">Not configured</Badge>);
    expect(html).toContain("Not configured");
    expect(html).toContain("rf-badge--warning");
  });

  it("provides an explicit alert title", () => {
    const html = renderToStaticMarkup(
      <Alert tone="danger" title="Unable to save">
        Check your connection.
      </Alert>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Unable to save");
  });
});

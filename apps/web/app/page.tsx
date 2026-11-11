import type { JSX } from "react";
import { AppShell } from "../components/app-shell";
import { Alert, Badge, Panel, StateMessage } from "../components/ui/primitives";
import { Tabs } from "../components/ui/tabs";

export default function HomePage(): JSX.Element {
  return (
    <AppShell
      inspector={
        <>
          <p className="rf-eyebrow">Context rail</p>
          <h2>Built for focused work</h2>
          <p>This rail is reserved for item details in future milestones.</p>
          <div className="rf-divider" />
          <Badge tone="warning">Not connected</Badge>
          <p>No accounts or provider data are loaded in this foundation preview.</p>
        </>
      }
    >
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Overview</p>
        <h1>Your production space</h1>
        <p>Organize creative work from first idea to final review, one clear step at a time.</p>
      </header>
      <Panel className="rf-hero-panel">
        <div className="rf-hero-glyph" aria-hidden="true">
          R
        </div>
        <p className="rf-eyebrow">Getting started</p>
        <h2>Make room for your next great idea.</h2>
        <p>
          The foundation is ready for review. Workspace creation, generation, and publishing belong
          to later milestones and are not available on this screen.
        </p>
        <Badge tone="info">Foundation preview only</Badge>
      </Panel>
      <section className="rf-pattern-section" aria-labelledby="patterns-heading">
        <div className="rf-section-header">
          <div>
            <p className="rf-eyebrow">System language</p>
            <h2 id="patterns-heading">Clear status at every step</h2>
          </div>
          <p>Illustrative states, not live activity.</p>
        </div>
        <Tabs
          label="State examples"
          items={[
            {
              id: "empty",
              label: "Empty",
              content: (
                <StateMessage
                  kind="empty"
                  description="No creator projects are available yet. Workspace setup arrives in M22."
                />
              ),
            },
            {
              id: "loading",
              label: "Loading",
              content: (
                <StateMessage kind="loading" description="Content would load here when available." />
              ),
            },
            {
              id: "error",
              label: "Error",
              content: (
                <StateMessage
                  kind="error"
                  description="If a request fails, this space will explain what happened and how to retry."
                />
              ),
            },
            {
              id: "success",
              label: "Success",
              content: (
                <StateMessage kind="success" description="A completed action will be confirmed here." />
              ),
            },
            {
              id: "forbidden",
              label: "Permission",
              content: (
                <StateMessage
                  kind="forbidden"
                  description="Ask a workspace owner for access when your role cannot perform an action."
                />
              ),
            },
            {
              id: "unavailable",
              label: "Unavailable",
              content: (
                <StateMessage
                  kind="unavailable"
                  description="Provider setup is not available in this foundation preview."
                />
              ),
            },
          ]}
        />
      </section>
      <Alert tone="info" title="Design preview — no live integrations">
        Navigation destinations and state examples are illustrative. No accounts, metrics, videos, or
        provider calls are connected to this page.
      </Alert>
    </AppShell>
  );
}

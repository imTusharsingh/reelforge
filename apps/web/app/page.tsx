import type { JSX } from "react";
import { AppShell } from "../components/app-shell";
import { Alert, Badge, Panel, StateMessage } from "../components/ui/primitives";
import { Tabs } from "../components/ui/tabs";

const stateExamples = [
  {
    id: "empty",
    label: "Empty",
    content: <StateMessage kind="empty" description="No projects yet. Setup arrives in M22." />,
  },
  {
    id: "loading",
    label: "Loading",
    content: <StateMessage kind="loading" description="Content will load here." />,
  },
  {
    id: "error",
    label: "Error",
    content: <StateMessage kind="error" description="A failed request needs a retry path." />,
  },
  {
    id: "success",
    label: "Success",
    content: <StateMessage kind="success" description="An action is complete." />,
  },
  {
    id: "forbidden",
    label: "Permission",
    content: <StateMessage kind="forbidden" description="Ask the owner for access." />,
  },
  {
    id: "unavailable",
    label: "Unavailable",
    content: <StateMessage kind="unavailable" description="Provider not configured." />,
  },
];

export default function HomePage(): JSX.Element {
  return (
    <AppShell
      inspector={
        <>
          <p className="rf-eyebrow">Context rail</p>
          <h2>Built for focused work</h2>
          <p>Details appear here in later milestones.</p>
          <div className="rf-divider" />
          <Badge tone="warning">Not connected</Badge>
          <p>No accounts or provider data are loaded.</p>
        </>
      }
    >
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Overview</p>
        <h1>Your production space</h1>
        <p>Organize creative work, one clear step at a time.</p>
      </header>
      <Panel className="rf-hero-panel">
        <div className="rf-hero-glyph" aria-hidden="true">
          R
        </div>
        <p className="rf-eyebrow">Getting started</p>
        <h2>Make room for your next great idea.</h2>
        <p>Workspace setup and publishing arrive in later milestones.</p>
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
        <Tabs label="State examples" items={stateExamples} />
      </section>
      <Alert tone="info" title="Design preview — no live integrations">
        Navigation and status examples are illustrative, not connected data.
      </Alert>
    </AppShell>
  );
}

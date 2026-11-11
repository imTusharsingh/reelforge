"use client";
import { useState, type JSX } from "react";
import { Panel } from "../../components/ui/primitives";
import { segment } from "./api";
import { SelectedRead } from "./content-panels";
import {
  ActionForm,
  Picker,
  ReadCollection,
  RecordList,
  ResourceState,
  SavedData,
  useResource,
} from "./ui";
export function ConfigurationPanel({ channelId }: { channelId: string }): JSX.Element {
  const config = useResource("config", false, "record");
  const [snapshot, setSnapshot] = useState("");
  const snapshots = useResource("config/snapshots", true, "snapshot");
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Configuration visibility</h2>
        <p>
          Inspect workspace defaults, immutable snapshots and locked fields. Resolution and prompt
          previews are deterministic local operations; they do not call an AI provider.
        </p>
        <ResourceState {...config} empty={!config.data.length} />
        {config.data.map((v, i) => (
          <SavedData key={i} value={v} label="Workspace values, sources and locks" />
        ))}
      </Panel>
      <ActionForm
        title="Resolve this channel configuration"
        fields={[]}
        path="config/resolve"
        fixed={{ channelId }}
        readOnly
        submitLabel="Preview resolved configuration"
      />
      <ActionForm
        title="Save workspace configuration snapshot"
        fields={[
          { key: "values", label: "Workspace configuration values", kind: "object" },
          { key: "lockedFields", label: "Locked field paths", kind: "array" },
        ]}
        path="config"
        method="PUT"
        submitLabel="Save workspace snapshot"
      />
      <Panel>
        <h3>Workspace configuration history</h3>
        <ResourceState {...snapshots} empty={!snapshots.data.length} />
        <RecordList items={snapshots.data} />
        <Picker
          label="Workspace snapshot to activate"
          items={snapshots.data}
          value={snapshot}
          onChange={setSnapshot}
        />
      </Panel>
      {snapshot && (
        <ActionForm
          key={snapshot}
          title="Activate workspace snapshot"
          fields={[]}
          path={`config/snapshots/${segment(snapshot)}/activate`}
          confirm="Activate this workspace snapshot for future configuration resolution?"
          submitLabel="Activate snapshot"
        />
      )}
      <PromptPanel channelId={channelId} />
      <ReadCollection
        title="Captured prompt bundles"
        path="prompts/bundle-snapshots"
        shape="snapshot"
      />
    </div>
  );
}
function PromptPanel({ channelId }: { channelId: string }): JSX.Element {
  const templates = useResource("prompts/templates");
  const [chosen, setChosen] = useState("");
  const [version, setVersion] = useState("");
  return (
    <>
      <Panel>
        <h2>Prompt templates</h2>
        <ResourceState {...templates} empty={!templates.data.length} />
        <Picker
          label="Prompt template"
          items={templates.data}
          value={chosen}
          onChange={(v) => {
            setChosen(v);
            setVersion("");
          }}
        />
        {chosen && (
          <SavedData
            value={templates.data.find((t) => t.id === chosen)}
            label="Template and active version"
          />
        )}
      </Panel>
      {chosen && (
        <>
          <SelectedRead
            key={`${chosen}-versions`}
            title="Prompt versions"
            path={`prompts/templates/${segment(chosen)}/versions`}
            shape="version"
          />
          <ActionForm
            key={`${chosen}-preview`}
            title="Deterministic prompt preview"
            fields={[
              { key: "variables", label: "Template variable values", kind: "object" },
              { key: "additions", label: "Allowed prompt additions", kind: "array" },
            ]}
            fixed={{ channelId, template: { templateId: chosen } }}
            path="prompts/preview"
            readOnly
            submitLabel="Preview prompt"
          />
          <PromptVersions
            key={`${chosen}-selection`}
            templateId={chosen}
            version={version}
            onVersion={setVersion}
          />
        </>
      )}
    </>
  );
}
function PromptVersions({
  templateId,
  version,
  onVersion,
}: {
  templateId: string;
  version: string;
  onVersion: (v: string) => void;
}): JSX.Element {
  const versions = useResource(
    `prompts/templates/${segment(templateId)}/versions`,
    true,
    "version",
  );
  const chosen = versions.data.find((v) => v.id === version);
  return (
    <Panel>
      <h3>Published prompt version selection</h3>
      <p>Activation and rollback affect future prompts; historical bundles remain immutable.</p>
      <ResourceState {...versions} empty={!versions.data.length} />
      <Picker
        label="Prompt version"
        items={versions.data.filter((v) => v.status === "PUBLISHED")}
        value={version}
        onChange={onVersion}
      />
      {chosen && (
        <>
          <SavedData value={chosen} label="Selected published prompt version" />
          <ActionForm
            key={`${templateId}-${version}-activate`}
            title="Activate published prompt"
            fields={[]}
            path={`prompts/templates/${segment(templateId)}/versions/${segment(version)}/activate`}
            confirm="Use this published prompt version for future generation?"
            submitLabel="Activate prompt version"
          />
          <ActionForm
            key={`${templateId}-${version}-rollback`}
            title="Roll back to selected published prompt"
            fields={[]}
            fixed={{ versionId: version }}
            path={`prompts/templates/${segment(templateId)}/rollback`}
            confirm="Roll back future prompts to this published version?"
            submitLabel="Roll back prompt"
          />
        </>
      )}
    </Panel>
  );
}

"use client";
import { useState, type JSX } from "react";
import { Button, Panel } from "../../components/ui/primitives";
import { segment } from "./api";
import { genreFields, seriesFields } from "./catalog";
import { type RecordValue, text } from "./model";
import {
  ActionForm,
  Picker,
  ReadCollection,
  RecordList,
  ResourceState,
  SavedData,
  useResource,
} from "./ui";

export function GenrePanel(): JSX.Element {
  const [rev, setRev] = useState(0);
  const genres = useResource("genres", true, "named", rev);
  const templates = useResource("genre-templates");
  const [chosen, setChosen] = useState("");
  const [template, setTemplate] = useState("");
  const selected = genres.data.find((g) => g.id === chosen);
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Genres & content policies</h2>
        <p>
          Workspace genres define audience, tone, language, topics and safety preferences.
          Structured policy fields use JSON to preserve the existing contract.
        </p>
        <Button tone="ghost" onClick={() => setRev((v) => v + 1)}>
          Refresh genres
        </Button>
        <ResourceState {...genres} empty={!genres.data.length} />
        <RecordList items={genres.data} />
        <Picker label="Edit genre" items={genres.data} value={chosen} onChange={setChosen} />
      </Panel>
      {selected && (
        <ActionForm
          key={chosen}
          title="Edit genre"
          fields={genreFields}
          initial={selected}
          method="PATCH"
          path={`genres/${segment(chosen)}`}
          onSaved={() => setRev((v) => v + 1)}
        />
      )}
      <ActionForm
        title="Create custom genre"
        fields={genreFields}
        path="genres"
        submitLabel="Create genre"
        onSaved={() => setRev((v) => v + 1)}
      />
      <Panel>
        <h3>Starter genre templates</h3>
        <ResourceState {...templates} empty={!templates.data.length} />
        <Picker
          label="Genre template"
          items={templates.data}
          value={template}
          onChange={setTemplate}
        />
        {template && (
          <SavedData
            value={templates.data.find((t) => t.id === template)}
            label="Template policies"
          />
        )}
      </Panel>
      {template && (
        <ActionForm
          key={template}
          title="Clone genre template"
          fields={[{ key: "name", label: "New genre name" }]}
          path={`genres/from-template/${segment(template)}`}
          submitLabel="Clone template"
          onSaved={() => setRev((v) => v + 1)}
        />
      )}
    </div>
  );
}
export function SeriesPanel({ channelId }: { channelId: string }): JSX.Element {
  const [rev, setRev] = useState(0);
  const path = `channels/${segment(channelId)}/series`;
  const series = useResource(path, true, "named", rev);
  const genres = useResource("genres");
  const [chosen, setChosen] = useState("");
  const [genreId, setGenreId] = useState("");
  const selected = series.data.find((s) => s.id === chosen);
  const choose = (value: string): void => {
    setChosen(value);
    const found = series.data.find((s) => s.id === value);
    setGenreId(typeof found?.genreId === "string" ? found.genreId : "");
  };
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Series</h2>
        <p>
          Select the genre explicitly. The server checks that its language is compatible with this
          channel.
        </p>
        <Button tone="ghost" onClick={() => setRev((v) => v + 1)}>
          Refresh series
        </Button>
        <ResourceState {...series} empty={!series.data.length} />
        <RecordList items={series.data} />
        <Picker label="Series to edit" items={series.data} value={chosen} onChange={choose} />
        <ResourceState {...genres} empty={!genres.data.length} />
        <Picker label="Series genre" items={genres.data} value={genreId} onChange={setGenreId} />
      </Panel>
      {genreId ? (
        <ActionForm
          key={`${chosen}-${genreId}`}
          title={selected ? "Edit series" : "Create series"}
          fields={seriesFields}
          initial={selected ?? {}}
          fixed={{ genreId }}
          path={selected ? `${path}/${segment(chosen)}` : path}
          method={selected ? "PATCH" : "POST"}
          submitLabel={selected ? "Save series" : "Create series"}
          onSaved={() => setRev((v) => v + 1)}
        />
      ) : (
        <p>Choose a genre to configure a series.</p>
      )}
    </div>
  );
}
export function SelectedRead({
  title,
  path,
  list = true,
  shape = "record",
}: {
  title: string;
  path: string;
  list?: boolean;
  shape?: "record" | "named" | "version" | "snapshot" | "asset";
}): JSX.Element {
  const state = useResource(path, list, shape);
  return (
    <Panel>
      <h3>{title}</h3>
      <ResourceState {...state} empty={!state.data.length} />
      {list ? (
        <RecordList items={state.data} />
      ) : (
        state.data.map((item, index) => <SavedData key={index} value={item} label={title} />)
      )}
    </Panel>
  );
}
export function SnapshotsPanel({
  channelId,
  channel,
}: {
  channelId: string;
  channel: RecordValue;
}): JSX.Element {
  const path = `channels/${segment(channelId)}/snapshots`;
  const snapshots = useResource(path, true, "snapshot");
  const [chosen, setChosen] = useState("");
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Channel snapshots</h2>
        <p>
          Active snapshot: {text(channel.activeSnapshotId, "No active snapshot")}. Selecting a saved
          snapshot replaces the current channel configuration.
        </p>
        <ResourceState {...snapshots} empty={!snapshots.data.length} />
        <Picker
          label="Channel snapshot"
          items={snapshots.data}
          value={chosen}
          onChange={setChosen}
        />
        {chosen && (
          <SavedData
            value={snapshots.data.find((s) => s.id === chosen)}
            label="Saved configuration preview"
          />
        )}
      </Panel>
      {chosen && (
        <ActionForm
          title="Select channel snapshot"
          fields={[]}
          path={`${path}/${segment(chosen)}/select`}
          confirm="Replace the current channel configuration with this saved snapshot?"
          submitLabel="Select snapshot"
        />
      )}
      <ReadCollection
        title="Generation snapshots"
        path="config/generation-snapshots"
        shape="snapshot"
      />
    </div>
  );
}

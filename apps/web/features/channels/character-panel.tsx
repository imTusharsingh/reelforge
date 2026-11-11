"use client";
import { useState, type JSX } from "react";
import { Panel } from "../../components/ui/primitives";
import { segment } from "./api";
import { characterFields } from "./catalog";
import { SelectedRead } from "./content-panels";
import { ActionForm, Picker, RecordList, ResourceState, SavedData, useResource } from "./ui";
export function CharacterPanel(): JSX.Element {
  const [rev, setRev] = useState(0);
  const characters = useResource("characters", true, "named", rev);
  const templates = useResource("character-templates");
  const [chosen, setChosen] = useState("");
  const [template, setTemplate] = useState("");
  const selected = characters.data.find((c) => c.id === chosen);
  const starter = templates.data.find((t) => t.id === template);
  const path = `characters/${segment(chosen)}`;
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Characters & personas</h2>
        <p>
          Draft profiles can evolve; published versions and their pinned assets remain immutable.
          Publishing requires at least one published asset reference.
        </p>
        <ResourceState {...characters} empty={!characters.data.length} />
        <RecordList items={characters.data} />
        <Picker
          label="Character to inspect"
          items={characters.data}
          value={chosen}
          onChange={setChosen}
        />
      </Panel>
      <ActionForm
        title="Create custom character"
        fields={characterFields}
        path="characters"
        submitLabel="Create character"
        onSaved={() => setRev((v) => v + 1)}
      />
      <Panel>
        <h3>Starter character templates</h3>
        <ResourceState {...templates} empty={!templates.data.length} />
        <Picker
          label="Character template"
          items={templates.data}
          value={template}
          onChange={setTemplate}
        />
        {starter && <SavedData value={starter} label="Template profile and rights" />}
      </Panel>
      {starter && (
        <ActionForm
          key={template}
          title="Create from character template"
          fields={[{ key: "name", label: "Character name", optional: true }]}
          fixed={{ templateKey: starter.key }}
          path="characters"
          submitLabel="Use template"
          onSaved={() => setRev((v) => v + 1)}
        />
      )}
      {selected && (
        <>
          <SavedData value={selected} label="Current character profile" />
          {selected.status !== "ARCHIVED" && (
            <>
              <ActionForm
                key={chosen}
                title="Edit character draft"
                fields={characterFields}
                initial={selected}
                path={path}
                method="PATCH"
                onSaved={() => setRev((v) => v + 1)}
              />
              <ActionForm
                title="Publish immutable character version"
                fields={[]}
                path={`${path}/publish`}
                confirm="Publish an immutable version of this profile and its asset references?"
                submitLabel="Publish character"
                onSaved={() => setRev((v) => v + 1)}
              />
              <ActionForm
                title="Archive character"
                fields={[]}
                path={`${path}/archive`}
                confirm="Archive this character? Archived drafts cannot be edited or published."
                submitLabel="Archive character"
                onSaved={() => setRev((v) => v + 1)}
              />
            </>
          )}
          <SelectedRead
            key={`${chosen}-${rev}-versions`}
            title="Published character versions"
            path={`${path}/versions`}
            shape="version"
          />
          {typeof selected.activeVersionId === "string" && (
            <SelectedRead
              key={`${chosen}-${rev}-references`}
              title="Published reference package"
              path={`${path}/reference-package`}
              list={false}
            />
          )}
        </>
      )}
    </div>
  );
}
export function GroupPanel({ channelId }: { channelId: string }): JSX.Element {
  const [rev, setRev] = useState(0);
  const groups = useResource("character-groups", true, "named", rev);
  const [chosen, setChosen] = useState("");
  const [character, setCharacter] = useState("");
  const characters = useResource("characters");
  const path = `character-groups/${segment(chosen)}`;
  const selected = groups.data.find((g) => g.id === chosen);
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Character groups & assignments</h2>
        <p>
          Membership pins a published character version. Assign a group to this channel or an
          explicitly selected series.
        </p>
        <ResourceState {...groups} empty={!groups.data.length} />
        <RecordList items={groups.data} />
        <Picker label="Character group" items={groups.data} value={chosen} onChange={setChosen} />
      </Panel>
      <ActionForm
        title="Create character group"
        fields={[
          { key: "name", label: "Group name" },
          { key: "description", label: "Description", optional: true },
        ]}
        path="character-groups"
        submitLabel="Create group"
        onSaved={() => setRev((v) => v + 1)}
      />
      {selected && (
        <>
          <ActionForm
            key={chosen}
            title="Edit character group"
            fields={[
              { key: "name", label: "Group name" },
              { key: "description", label: "Description", optional: true },
            ]}
            initial={selected}
            path={path}
            method="PATCH"
            onSaved={() => setRev((v) => v + 1)}
          />
          <ActionForm
            title="Assign group to channel"
            fields={[]}
            fixed={{ channelId }}
            path={`${path}/assignments`}
            submitLabel="Assign to this channel"
            onSaved={() => setRev((v) => v + 1)}
          />
          <GroupSeriesAssignment
            key={`${chosen}-series`}
            groupId={chosen}
            channelId={channelId}
            onSaved={() => setRev((v) => v + 1)}
          />
          <Panel>
            <ResourceState {...characters} empty={!characters.data.length} />
            <Picker
              label="Group member character"
              items={characters.data}
              value={character}
              onChange={setCharacter}
            />
          </Panel>
          {character && (
            <>
              <PublishedMember
                key={`${chosen}-${character}`}
                groupId={chosen}
                characterId={character}
                onSaved={() => setRev((v) => v + 1)}
              />
              <ActionForm
                title="Remove selected group member"
                fields={[]}
                path={`${path}/members/${segment(character)}`}
                method="DELETE"
                confirm="Remove this character from the group?"
                submitLabel="Remove member"
                onSaved={() => setRev((v) => v + 1)}
              />
            </>
          )}
          <AssignmentRemoval groupId={chosen} revision={rev} onSaved={() => setRev((v) => v + 1)} />
          <SelectedRead
            key={chosen}
            title="Group reference package"
            path={`${path}/reference-package`}
            list={false}
          />
        </>
      )}
    </div>
  );
}
function AssignmentRemoval({
  groupId,
  revision,
  onSaved,
}: {
  groupId: string;
  revision: number;
  onSaved: () => void;
}): JSX.Element {
  const group = useResource(`character-groups/${segment(groupId)}`, false, "named", revision);
  const [assignment, setAssignment] = useState("");
  const raw = group.data[0]?.assignments;
  const items = Array.isArray(raw)
    ? raw.filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null && typeof v.id === "string",
      )
    : [];
  return (
    <Panel>
      <h3>Existing assignments</h3>
      <ResourceState {...group} empty={!items.length} />
      <SavedData value={items} />
      <Picker
        label="Assignment to remove"
        items={items.map((v) => ({ ...v, name: String(v.channelId ?? v.seriesId ?? v.id) }))}
        value={assignment}
        onChange={setAssignment}
      />
      {assignment && (
        <ActionForm
          key={`${groupId}-${assignment}`}
          title="Remove group assignment"
          fields={[]}
          path={`character-groups/${segment(groupId)}/assignments/${segment(assignment)}`}
          method="DELETE"
          confirm="Remove this assignment?"
          submitLabel="Remove assignment"
          onSaved={onSaved}
        />
      )}
    </Panel>
  );
}

export function GroupSeriesAssignment({
  groupId,
  channelId,
  onSaved,
}: {
  groupId: string;
  channelId: string;
  onSaved: () => void;
}): JSX.Element {
  const series = useResource(`channels/${segment(channelId)}/series`);
  const [chosen, setChosen] = useState("");
  const selected = series.data.find((item) => item.id === chosen && item.channelId === channelId);
  return (
    <Panel>
      <h3>Assign group to a series</h3>
      <ResourceState {...series} empty={!series.data.length} />
      <Picker
        label="Assignment series"
        items={series.data.filter((item) => item.channelId === channelId)}
        value={chosen}
        onChange={setChosen}
      />
      {selected && (
        <ActionForm
          key={chosen}
          title="Assign group to series"
          fields={[]}
          fixed={{ seriesId: selected.id }}
          path={`character-groups/${segment(groupId)}/assignments`}
          submitLabel="Assign to series"
          onSaved={onSaved}
        />
      )}
    </Panel>
  );
}
export function PublishedMember({
  groupId,
  characterId,
  onSaved,
}: {
  groupId: string;
  characterId: string;
  onSaved: () => void;
}): JSX.Element {
  const versions = useResource(`characters/${segment(characterId)}/versions`, true, "version");
  const [chosen, setChosen] = useState("");
  const available = versions.data.filter(
    (v) => v.status === "PUBLISHED" && v.characterId === characterId,
  );
  const selected = available.find((v) => v.id === chosen);
  return (
    <Panel>
      <h3>Add a published character version</h3>
      <ResourceState {...versions} empty={!available.length} />
      <Picker
        label="Published character version"
        items={available.map((v) => ({
          ...v,
          name: `Version ${String(v.version)} — ${typeof v.profile === "object" && v.profile !== null && "name" in v.profile ? String(v.profile.name) : "Published character"}`,
        }))}
        value={chosen}
        onChange={setChosen}
      />
      {selected && (
        <ActionForm
          key={chosen}
          title="Add pinned group member"
          fields={[]}
          fixed={{ characterId, characterVersionId: selected.id }}
          path={`character-groups/${segment(groupId)}/members`}
          submitLabel="Add member"
          onSaved={onSaved}
        />
      )}
    </Panel>
  );
}

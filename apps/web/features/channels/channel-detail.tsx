"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type JSX } from "react";
import { AppShell } from "../../components/app-shell";
import {
  Alert,
  Badge,
  Button,
  Field,
  Panel,
  StateMessage,
  TextAreaField,
} from "../../components/ui/primitives";
import { api, ApiError, type ApiRecord, type Channel, type Workspace } from "../../lib/api";
import { id, text } from "./types";

type Tab = "brand" | "content" | "series" | "characters" | "configuration";
function message(error: unknown): string {
  return error instanceof ApiError ? error.message : "The request could not be completed.";
}
function value(record: ApiRecord, key: string): string {
  return text(record[key], "Not set");
}

export function ChannelDetail({ channelId }: { channelId: string }): JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [genres, setGenres] = useState<ApiRecord[]>([]);
  const [series, setSeries] = useState<ApiRecord[]>([]);
  const [characters, setCharacters] = useState<ApiRecord[]>([]);
  const [assets, setAssets] = useState<ApiRecord[]>([]);
  const [config, setConfig] = useState<ApiRecord | null>(null);
  const [snapshots, setSnapshots] = useState<ApiRecord[]>([]);
  const [prompts, setPrompts] = useState<ApiRecord[]>([]);
  const [tab, setTab] = useState<Tab>("brand");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    name: "",
    handle: "",
    description: "",
    niche: "",
    language: "",
    audience: "",
    timezone: "",
  });
  const [genreName, setGenreName] = useState("");
  const [seriesName, setSeriesName] = useState("");
  const [characterName, setCharacterName] = useState("");

  const load = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const workspaces = await api.listWorkspaces();
      const selected = workspaces.find((item) => !item.archivedAt) ?? null;
      if (!selected) throw new Error("No active workspace is available.");
      const found = await api.getChannel(selected.id, channelId);
      if (found.workspaceId !== selected.id)
        throw new Error("Channel is outside the selected workspace.");
      setWorkspace(selected);
      setChannel(found);
      setForm({
        name: found.name,
        handle: text(found.handle, ""),
        description: text(found.description, ""),
        niche: text(found.niche, ""),
        language: text(found.language, ""),
        audience: text(found.audience, ""),
        timezone: text(found.timezone, ""),
      });
      const results = await Promise.allSettled([
        api.listGenres(selected.id),
        api.listSeries(selected.id, channelId),
        api.listCharacters(selected.id),
        api.listAssets(selected.id),
        api.getWorkspaceConfig(selected.id),
        api.listConfigSnapshots(selected.id),
        api.listPromptTemplates(selected.id),
      ]);
      const [g, s, c, a, cfg, ss, p] = results;
      if (g.status === "fulfilled") setGenres(g.value);
      if (s.status === "fulfilled") setSeries(s.value);
      if (c.status === "fulfilled") setCharacters(c.value);
      if (a.status === "fulfilled") setAssets(a.value);
      if (cfg.status === "fulfilled") setConfig(cfg.value);
      if (ss.status === "fulfilled") setSnapshots(ss.value);
      if (p.status === "fulfilled") setPrompts(p.value);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [channelId]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!workspace || !channel) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      setChannel(await api.updateChannel(workspace.id, channel.id, form));
      setNotice("Channel configuration saved and a new snapshot was created.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };
  const changeStatus = async (next: Channel["status"]): Promise<void> => {
    if (
      !workspace ||
      !channel ||
      (next === "ARCHIVED" &&
        !window.confirm("Archive this channel? It will no longer be available for production."))
    )
      return;
    try {
      setChannel(await api.setChannelStatus(workspace.id, channel.id, next));
    } catch (cause) {
      setError(message(cause));
    }
  };
  const addGenre = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!workspace || !genreName.trim()) return;
    try {
      const created = await api.createGenre(workspace.id, {
        name: genreName,
        audience: form.audience || "General audience",
        tone: "Clear and considered",
        topicsAllowed: [],
        topicsBlocked: [],
        language: form.language || "en",
        structure: {},
        durationPreference: {},
        safetyProfile: { requiresHumanReview: true },
      });
      setGenres((items) => [...items, created]);
      setGenreName("");
    } catch (cause) {
      setError(message(cause));
    }
  };
  const addSeries = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const genre = genres[0];
    if (!workspace || !channel || !seriesName.trim() || !genre) {
      setError("Create or select a genre before adding a series.");
      return;
    }
    try {
      const created = await api.createSeries(workspace.id, channel.id, {
        name: seriesName,
        genreId: id(genre.id),
        format: "Short-form video",
        frequency: "Flexible",
        characterGroupRefs: [],
        promptRefs: [],
      });
      setSeries((items) => [...items, created]);
      setSeriesName("");
    } catch (cause) {
      setError(message(cause));
    }
  };
  const addCharacter = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!workspace || !characterName.trim()) return;
    try {
      const created = await api.createCharacter(workspace.id, {
        name: characterName,
        description: "",
        personality: {},
        voicePreference: {},
        visualInvariants: {},
        variationRules: {},
        referenceAssets: [],
      });
      setCharacters((items) => [...items, created]);
      setCharacterName("");
    } catch (cause) {
      setError(message(cause));
    }
  };

  if (loading)
    return (
      <AppShell>
        <StateMessage kind="loading" description="Loading the channel workspace…" />
      </AppShell>
    );
  if (error && !channel)
    return (
      <AppShell>
        <StateMessage
          kind="error"
          description={error}
          action={
            <Link className="rf-button rf-button--secondary" href="/channels">
              Back to channels
            </Link>
          }
        />
      </AppShell>
    );
  if (!channel || !workspace)
    return (
      <AppShell>
        <StateMessage
          kind="unavailable"
          description="This channel is not available in the selected workspace."
        />
      </AppShell>
    );
  const tabs: Array<[Tab, string]> = [
    ["brand", "Brand identity"],
    ["content", "Content preferences"],
    ["series", "Genres & series"],
    ["characters", "Characters & assets"],
    ["configuration", "M05 configuration"],
  ];
  return (
    <AppShell>
      <div className="rf-page-heading">
        <p className="rf-eyebrow">
          <Link href="/channels">Channels</Link> / Detail
        </p>
        <div className="rf-channel-title">
          <div>
            <h1>{channel.name}</h1>
            <p>{channel.description || "Configure the editorial system for this channel."}</p>
          </div>
          <Badge
            tone={
              channel.status === "ACTIVE"
                ? "success"
                : channel.status === "PAUSED"
                  ? "warning"
                  : "danger"
            }
          >
            {channel.status.toLowerCase()}
          </Badge>
        </div>
      </div>
      {error && (
        <Alert tone="danger" title="Could not save changes">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" title="Saved">
          {notice}
        </Alert>
      )}
      <div className="rf-tabs">
        <div className="rf-tab-list" role="tablist" aria-label="Channel configuration sections">
          {tabs.map(([key, label]) => (
            <button
              className="rf-tab"
              role="tab"
              aria-selected={tab === key}
              key={key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "brand" && (
          <form className="rf-tab-panel rf-detail-form" onSubmit={save}>
            <div>
              <h2>Brand identity</h2>
              <p className="rf-muted">
                These verified channel fields are used by downstream generation and publishing
                workflows.
              </p>
            </div>
            <Field
              id="channel-name"
              label="Channel name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Field
              id="channel-handle"
              label="Handle"
              value={form.handle}
              onChange={(e) => setForm({ ...form, handle: e.target.value })}
            />
            <TextAreaField
              id="channel-description"
              label="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <Field
              id="channel-niche"
              label="Niche"
              value={form.niche}
              onChange={(e) => setForm({ ...form, niche: e.target.value })}
            />
            <div className="rf-two-column">
              <Field
                id="channel-language"
                label="Language"
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
              />
              <Field
                id="channel-audience"
                label="Audience"
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
              />
              <Field
                id="channel-timezone"
                label="Timezone"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              />
            </div>
            <div className="rf-action-row">
              <Button type="submit" loading={saving}>
                Save brand identity
              </Button>
              <Button
                tone="secondary"
                onClick={() => void changeStatus(channel.status === "ACTIVE" ? "PAUSED" : "ACTIVE")}
              >
                {channel.status === "ACTIVE" ? "Pause channel" : "Activate channel"}
              </Button>
              <Button tone="danger" onClick={() => void changeStatus("ARCHIVED")}>
                Archive
              </Button>
            </div>
          </form>
        )}
        {tab === "content" && (
          <div className="rf-tab-panel">
            <h2>Content preferences</h2>
            <p className="rf-muted">
              Content policy and production defaults are kept on the channel configuration snapshot.
            </p>
            <div className="rf-preference-grid">
              <Panel>
                <h3>Editorial direction</h3>
                <p>
                  Audience: <strong>{form.audience || "Not set"}</strong>
                </p>
                <p>
                  Niche: <strong>{form.niche || "Not set"}</strong>
                </p>
                <p>
                  Language: <strong>{form.language || "Not set"}</strong>
                </p>
              </Panel>
              <Panel>
                <h3>Safety checkpoint</h3>
                <p>
                  Human review remains explicit in downstream workflows. Provider status and media
                  previews are shown only when returned by the API.
                </p>
                <Badge tone="info">Review required where configured</Badge>
              </Panel>
            </div>
            <Button onClick={() => setTab("brand")}>Edit channel preferences</Button>
          </div>
        )}
        {tab === "series" && (
          <div className="rf-tab-panel">
            <h2>Genres, formats & series</h2>
            <p className="rf-muted">
              Genre compatibility and series assignments are validated by the existing M03 APIs.
            </p>
            <div className="rf-inline-create">
              <form onSubmit={addGenre}>
                <Field
                  id="genre-name"
                  label="New genre"
                  value={genreName}
                  onChange={(e) => setGenreName(e.target.value)}
                  placeholder="e.g. Science explainers"
                />
                <Button type="submit">Add genre</Button>
              </form>
              <form onSubmit={addSeries}>
                <Field
                  id="series-name"
                  label="New series"
                  value={seriesName}
                  onChange={(e) => setSeriesName(e.target.value)}
                  placeholder="e.g. One-minute myths"
                />
                <Button type="submit">Add series</Button>
              </form>
            </div>
            <div className="rf-data-list">
              <h3>Genres</h3>
              {genres.length ? (
                genres.map((genre) => (
                  <div className="rf-data-row" key={id(genre.id)}>
                    <strong>{value(genre, "name")}</strong>
                    <span>{value(genre, "tone")}</span>
                  </div>
                ))
              ) : (
                <StateMessage
                  kind="empty"
                  description="No genres are configured for this workspace."
                />
              )}
              <h3>Series for {channel.name}</h3>
              {series.length ? (
                series.map((item) => (
                  <div className="rf-data-row" key={id(item.id)}>
                    <strong>{value(item, "name")}</strong>
                    <span>{value(item, "format")}</span>
                  </div>
                ))
              ) : (
                <StateMessage kind="empty" description="No series are assigned to this channel." />
              )}
            </div>
          </div>
        )}
        {tab === "characters" && (
          <div className="rf-tab-panel">
            <h2>Characters, groups & assets</h2>
            <p className="rf-muted">
              Character profiles reference published assets; uploads and rights are handled by the
              existing asset API.
            </p>
            <form className="rf-inline-create" onSubmit={addCharacter}>
              <Field
                id="character-name"
                label="New character"
                value={characterName}
                onChange={(e) => setCharacterName(e.target.value)}
                placeholder="e.g. Mina"
              />
              <Button type="submit">Create draft character</Button>
            </form>
            <div className="rf-data-list">
              <h3>Characters</h3>
              {characters.length ? (
                characters.map((item) => (
                  <div className="rf-data-row" key={id(item.id)}>
                    <strong>{value(item, "name")}</strong>
                    <Badge tone={value(item, "status") === "PUBLISHED" ? "success" : "warning"}>
                      {value(item, "status")}
                    </Badge>
                  </div>
                ))
              ) : (
                <StateMessage kind="empty" description="No characters are configured yet." />
              )}
              <h3>Workspace assets</h3>
              {assets.length ? (
                assets.map((item) => (
                  <div className="rf-data-row" key={id(item.id)}>
                    <strong>{value(item, "filename")}</strong>
                    <span>{value(item, "mediaType")}</span>
                  </div>
                ))
              ) : (
                <StateMessage
                  kind="empty"
                  description="No assets are available. Asset rights must be verified before use."
                />
              )}
            </div>
          </div>
        )}
        {tab === "configuration" && (
          <div className="rf-tab-panel">
            <h2>M05 configuration visibility</h2>
            <p className="rf-muted">
              Inspect resolved configuration, snapshots, and prompt references without claiming
              unsupported previews or provider connectivity.
            </p>
            <div className="rf-config-summary">
              <Panel>
                <h3>Resolved workspace configuration</h3>
                <pre>
                  {config ? JSON.stringify(config, null, 2) : "Configuration is not available."}
                </pre>
              </Panel>
              <Panel>
                <h3>Generation snapshots</h3>
                <p>{snapshots.length} snapshot(s) returned for this workspace.</p>
                {snapshots.slice(0, 5).map((snapshot) => (
                  <div className="rf-data-row" key={id(snapshot.id)}>
                    <strong>Version {value(snapshot, "version")}</strong>
                    <span>{value(snapshot, "fingerprintSha256")}</span>
                  </div>
                ))}
              </Panel>
              <Panel>
                <h3>Prompt visibility</h3>
                <p>
                  {prompts.length} prompt template(s) returned by the API. Templates remain
                  inspectable and editable through the configuration workflow.
                </p>
              </Panel>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

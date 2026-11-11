/** Test-only persisted API response fixtures; never loaded by the application. */
import type { Idea, Script, ScriptDocument } from "../model";
export const document: ScriptDocument = {
  schemaVersion: "1.0",
  title: "A small creative habit",
  hook: "Start with one minute",
  dialogue: "",
  cta: "Try it today",
  metadata: { genre: "Education", targetDurationSeconds: 20, factual: false },
  scenes: [
    {
      id: "scene-one",
      startSeconds: 0,
      durationSeconds: 10,
      characterRefs: [],
      dialogue: "Begin here",
      visualDescription: "Morning desk",
      camera: "Close up",
      audioCues: [],
    },
    {
      id: "scene-two",
      startSeconds: 10,
      durationSeconds: 10,
      characterRefs: [],
      dialogue: "Then continue",
      visualDescription: "Open notebook",
      camera: "Wide",
      audioCues: [],
    },
  ],
};
export const idea: Idea = {
  id: "idea-one",
  workspaceId: "workspace-one",
  channelId: "channel-one",
  seriesId: null,
  title: "A creative habit",
  topic: "Creativity",
  hook: "One minute",
  angle: "Small steps",
  audience: "Creators",
  expectedFormat: "short-form-video",
  references: ["https://example.com/source"],
  sourceNotes: "A useful starting point",
  status: "DRAFT",
  updatedAt: "2026-11-11T10:00:00.000Z",
  archivedAt: null,
  scheduledAt: null,
};
export const script: Script = {
  id: "script-one",
  workspaceId: "workspace-one",
  status: "DRAFT",
  currentRevision: 1,
  revisions: [{ id: "revision-one", revision: 1, createdAt: "2026-11-11T10:00:00.000Z", document }],
};

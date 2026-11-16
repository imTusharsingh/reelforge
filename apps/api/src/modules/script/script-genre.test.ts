import { expect, it, vi } from "vitest";
import type { Database } from "../identity/identity.types.js";
import { resolveScriptGenre } from "./script-genre.js";
import { parseScriptDocument } from "./script.validation.js";
it("resolves a configured genre case-insensitively and remains tenant-scoped", async () => {
  const findFirst = vi.fn().mockResolvedValue({ id: "configured", safetyProfile: {} });
  const db = { genre: { findFirst } } as unknown as Database;
  expect((await resolveScriptGenre(db, "owned-workspace", "  eXpLaInEr ")).id).toBe("configured");
  expect(findFirst.mock.calls[0]?.[0].where).toEqual({
    workspaceId: "owned-workspace",
    name: { equals: "eXpLaInEr", mode: "insensitive" },
  });
});
it("falls back for an unknown genre and fails closed if the seed is missing", async () => {
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: "default", safetyProfile: {} })
    .mockResolvedValue(null);
  const db = { genre: { findFirst } } as unknown as Database;
  expect((await resolveScriptGenre(db, "owned", "not configured")).id).toBe("default");
  expect(findFirst.mock.calls[1]?.[0].where).toEqual({
    workspaceId: "owned",
    name: { equals: "Explainer", mode: "insensitive" },
  });
  await expect(resolveScriptGenre(db, "owned", "missing")).rejects.toThrow("Default genre");
});
it("fills an absent or blank genre without requiring a user choice", () => {
  const doc = {
    schemaVersion: "1.0",
    title: "T",
    hook: "H",
    dialogue: "",
    cta: "C",
    metadata: { targetDurationSeconds: 3, factual: false },
    scenes: [
      {
        id: "one",
        startSeconds: 0,
        durationSeconds: 3,
        characterRefs: [],
        dialogue: "",
        visualDescription: "Tree",
        camera: "wide",
        audioCues: [],
      },
    ],
  };
  expect(parseScriptDocument(doc).metadata.genre).toBe("Explainer");
  expect(
    parseScriptDocument({ ...doc, metadata: { ...doc.metadata, genre: "  " } }).metadata.genre,
  ).toBe("Explainer");
});

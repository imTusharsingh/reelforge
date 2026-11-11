import { describe, expect, it } from "vitest";
import {
  parseChannel,
  parseGenre,
  parseSeries,
  parseAssetReference,
  parseCharacter,
  parseCharacterVersion,
  parseGroup,
  parsePromptTemplate,
  parsePromptVersion,
  parseSnapshot,
  parseAsset,
} from "./dto";
import {
  ids,
  channel,
  genre,
  series,
  character,
  characterVersion,
  group,
  promptTemplate,
  promptVersion,
  snapshot,
} from "./verification/fixtures";
describe("feature-owned M02–M05 runtime DTOs", () => {
  it("parses real-shaped channel, genre and series payloads", () => {
    expect(parseChannel(channel, ids.workspace).id).toBe(ids.channel);
    expect(parseGenre(genre, ids.workspace).durationPreference).toEqual({
      minSeconds: 15,
      maxSeconds: 45,
    });
    expect(parseSeries(series, ids.workspace, ids.channel).genreId).toBe(ids.genre);
  });
  it.each([42, {}, []])("rejects malformed optional branding fields", (handle) => {
    expect(() => parseChannel({ ...channel, handle }, ids.workspace)).toThrow(/handle/);
  });
  it("rejects channel ownership and foreign active-snapshot nesting", () => {
    expect(() =>
      parseChannel({ ...channel, workspaceId: ids.otherWorkspace }, ids.workspace),
    ).toThrow(/ownership/);
    expect(() =>
      parseChannel(
        { ...channel, activeSnapshot: { ...snapshot, workspaceId: ids.otherWorkspace } },
        ids.workspace,
      ),
    ).toThrow(/ownership/);
  });
  it("rejects a series from another channel and malformed references", () => {
    expect(() =>
      parseSeries({ ...series, channelId: ids.otherChannel }, ids.workspace, ids.channel),
    ).toThrow(/series channel/);
    expect(() => parseSeries({ ...series, promptRefs: {} }, ids.workspace, ids.channel)).toThrow(
      /prompt references/,
    );
  });
  it("rejects malformed topic/structure containers", () => {
    expect(() => parseGenre({ ...genre, topicsAllowed: {} }, ids.workspace)).toThrow();
    expect(() => parseGenre({ ...genre, structure: [] }, ids.workspace)).toThrow();
  });
  it("validates immutable character versions and reference pins", () => {
    expect(parseCharacter(character, ids.workspace).name).toBe("Nova");
    expect(parseCharacterVersion(characterVersion, ids.workspace, ids.character).version).toBe(1);
    expect(() => parseAssetReference({ assetId: ids.channel, version: 0 })).toThrow();
    expect(() => parseAssetReference({ assetId: "not-an-id", version: 1 })).toThrow();
  });
  it("rejects a version with another character, invalid profile or checksum", () => {
    expect(() =>
      parseCharacterVersion(
        { ...characterVersion, characterId: ids.otherChannel },
        ids.workspace,
        ids.character,
      ),
    ).toThrow();
    expect(() =>
      parseCharacterVersion(
        { ...characterVersion, profile: { name: "Nova", personality: [] } },
        ids.workspace,
        ids.character,
      ),
    ).toThrow();
    expect(() =>
      parseCharacterVersion(
        { ...characterVersion, checksumSha256: "bad" },
        ids.workspace,
        ids.character,
      ),
    ).toThrow();
  });
  it("checks nested group membership ownership and pinned version identity", () => {
    expect(parseGroup(group, ids.workspace).members?.[0]?.characterVersionId).toBe(ids.version);
    expect(() =>
      parseGroup(
        {
          ...group,
          members: [
            {
              ...group.members[0],
              characterVersion: { ...characterVersion, workspaceId: ids.otherWorkspace },
            },
          ],
        },
        ids.workspace,
      ),
    ).toThrow(/ownership/);
    expect(() =>
      parseGroup(
        { ...group, members: [{ ...group.members[0], characterVersionId: ids.secondVersion }] },
        ids.workspace,
      ),
    ).toThrow(/pinned member/);
  });
  it("rejects assignments with ambiguous targets", () => {
    expect(() =>
      parseGroup(
        { ...group, assignments: [{ ...group.assignments[0], seriesId: ids.series }] },
        ids.workspace,
      ),
    ).toThrow(/assignment target/);
  });
  it("validates prompt bodies, template ownership and active version links", () => {
    expect(parsePromptTemplate(promptTemplate, ids.workspace).activeVersionId).toBe(ids.version);
    expect(parsePromptVersion(promptVersion, ids.workspace, ids.template).version).toBe(1);
    expect(() =>
      parsePromptTemplate({ ...promptTemplate, activeVersionId: ids.secondVersion }, ids.workspace),
    ).toThrow(/active prompt/);
    expect(() =>
      parsePromptVersion(
        { ...promptVersion, body: { sections: { instructions: 42 } } },
        ids.workspace,
        ids.template,
      ),
    ).toThrow();
  });
  it("rejects foreign or malformed snapshots", () => {
    expect(parseSnapshot(snapshot, ids.workspace).version).toBe(1);
    expect(() =>
      parseSnapshot({ ...snapshot, workspaceId: ids.otherWorkspace }, ids.workspace),
    ).toThrow();
    expect(() => parseSnapshot({ ...snapshot, config: [] }, ids.workspace)).toThrow();
  });
  it("validates asset metadata and published checksums", () => {
    const asset = {
      id: ids.channel,
      workspaceId: ids.workspace,
      rootAssetId: ids.channel,
      version: 1,
      mediaType: "image/png",
      status: "PUBLISHED",
      filename: "cover.png",
      byteSize: 64,
      checksumSha256: "a".repeat(64),
    };
    expect(parseAsset(asset, ids.workspace).byteSize).toBe(64);
    expect(() => parseAsset({ ...asset, byteSize: "64" }, ids.workspace)).toThrow();
    expect(() => parseAsset({ ...asset, status: "CONNECTED" }, ids.workspace)).toThrow();
  });
});

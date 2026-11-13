export type Item = Record<string, unknown>;
export type Snapshot = Item & {
  id: string;
  key: string;
  value: number | null;
  remoteEntityId: string | null;
  completeness: string;
  availability: string;
  unavailableReason: string | null;
  periodStart: string;
  periodEnd: string;
  collectedAt: string;
  sourceApi: string;
};
export type VideoSummary = { id: string; views: number | null; rows: Snapshot[]; label: string };

export function publishedVideoLabel(record: Item | undefined, id: string): string {
  const title = record?.["title"];
  if (typeof title === "string" && title.length > 0) return title;
  const publishedAt = record?.["publishedAt"];
  return `${typeof publishedAt === "string" ? publishedAt : "Published date unavailable"} · ${id}`;
}

export function rankVideos(snapshots: Snapshot[], labels: Item[]): VideoSummary[] {
  const grouped = snapshots.reduce<Record<string, Snapshot[]>>((result, row) => {
    if (row.remoteEntityId !== null) (result[row.remoteEntityId] ??= []).push(row);
    return result;
  }, {});
  return Object.entries(grouped)
    .map(([id, rows]) => {
      const viewValues = rows
        .filter((row) => row.key === "views" && row.availability === "AVAILABLE")
        .map((row) => row.value)
        .filter((value): value is number => value !== null);
      return {
        id,
        rows,
        views:
          viewValues.length === 0 ? null : viewValues.reduce((total, value) => total + value, 0),
        label: publishedVideoLabel(
          labels.find((record) => record["platformPostId"] === id),
          id,
        ),
      };
    })
    .sort((left, right) => (right.views ?? -1) - (left.views ?? -1));
}

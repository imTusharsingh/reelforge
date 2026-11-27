import {
  StoredChannelBriefSchema,
  type ChannelBrief,
} from "../../../../packages/contracts/src/foundations";
import { api, type Workspace } from "../../lib/api";

export type SetupAction = "create" | "queue";

export type Progress = {
  checkpointKey?: string;
  workspace?: Workspace;
  workspaceId?: string;
  channelId?: string;
  brief?: ChannelBrief;
  key: string;
  needsLanguageRepair?: boolean;
  action?: SetupAction;
  completed?: boolean;
};

type SavedAttempt = Pick<
  Progress,
  "workspaceId" | "channelId" | "brief" | "key" | "needsLanguageRepair" | "action" | "completed"
>;

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function readSavedAttempt(input: unknown): SavedAttempt {
  if (typeof input !== "object" || input === null) throw new SubmissionCheckpointError();
  const { workspaceId, channelId, brief, key, needsLanguageRepair, action, completed } =
    input as Record<string, unknown>;
  if (
    (workspaceId !== undefined && !isUuid(workspaceId)) ||
    ((channelId !== undefined || brief !== undefined) && !workspaceId) ||
    (channelId !== undefined && !isUuid(channelId)) ||
    typeof key !== "string" ||
    (brief === undefined ? key !== "" : !isUuid(key)) ||
    (needsLanguageRepair !== undefined && typeof needsLanguageRepair !== "boolean") ||
    (action !== undefined && action !== "create" && action !== "queue") ||
    (completed !== undefined && typeof completed !== "boolean") ||
    (completed && (!brief || !action || needsLanguageRepair))
  )
    throw new SubmissionCheckpointError();
  return {
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    key,
    ...(channelId !== undefined ? { channelId } : {}),
    ...(brief !== undefined ? { brief: StoredChannelBriefSchema.parse(brief) } : {}),
    ...(needsLanguageRepair !== undefined ? { needsLanguageRepair } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(completed !== undefined ? { completed } : {}),
  };
}

export class SubmissionCheckpointError extends Error {
  public constructor() {
    super("Setup could not verify the saved submission in this tab. No new Short was sent.");
  }
}

// History identifies the wizard across steps and reloads. Checkpoints live in
// this tab and are separate for every authenticated user and initial workspace.
export async function submissionCheckpoint(
  progress: Progress,
  scope: string | undefined,
): Promise<() => void> {
  const { userId } = await api.me();
  try {
    const wizardId: unknown = history.state?.briefWizardId;
    if (!isUuid(wizardId)) throw new SubmissionCheckpointError();
    const storageKey = `rf:onboarding:${userId}:${scope ?? "new"}:${wizardId}`;
    if (progress.checkpointKey && progress.checkpointKey !== storageKey)
      throw new SubmissionCheckpointError();
    restoreCheckpoint(progress, scope, storageKey);
    progress.checkpointKey = storageKey;
    return (): void => saveCheckpoint(progress, storageKey);
  } catch {
    throw new SubmissionCheckpointError();
  }
}

function restoreCheckpoint(
  progress: Progress,
  scope: string | undefined,
  storageKey: string,
): void {
  const raw = sessionStorage.getItem(storageKey);
  if (raw === null) {
    if (history.state?.briefAttempt === storageKey) throw new SubmissionCheckpointError();
    return;
  }
  const saved = readSavedAttempt(JSON.parse(raw));
  if (
    (scope && scope !== saved.workspaceId) ||
    (progress.workspace && progress.workspace.id !== saved.workspaceId) ||
    (saved.brief &&
      (saved.brief.workspaceId !== saved.workspaceId ||
        saved.brief.channelId !== saved.channelId ||
        !saved.key))
  )
    throw new SubmissionCheckpointError();
  Object.assign(progress, saved);
}

function saveCheckpoint(progress: Progress, storageKey: string): void {
  try {
    const saved = readSavedAttempt({
      workspaceId: progress.workspace?.id ?? progress.workspaceId,
      channelId: progress.channelId,
      brief: progress.brief,
      key: progress.key,
      needsLanguageRepair: progress.needsLanguageRepair,
      action: progress.action,
      completed: progress.completed,
    });
    sessionStorage.setItem(storageKey, JSON.stringify(saved));
    history.replaceState({ ...history.state, briefAttempt: storageKey }, "");
  } catch {
    throw new SubmissionCheckpointError();
  }
}

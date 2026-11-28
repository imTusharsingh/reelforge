import {
  defaultBrief,
  type BriefInput,
  type OnboardingInput,
} from "../../../../packages/contracts/src/channel-brief";
import { ensureCsrfToken } from "../../lib/csrf";
import { api, type Workspace } from "../../lib/api";
import { BriefClient, UnsupportedNarrationLanguageError } from "./client";
import { submissionCheckpoint, SubmissionCheckpointError, type Progress } from "./wizard-attempt";

export async function submitSetup(
  input: OnboardingInput,
  progress: Progress,
  budgetPolicy: BriefInput["budgetPolicy"],
  queue: boolean,
  scope: string | undefined,
): Promise<Workspace> {
  await ensureCsrfToken();
  const checkpoint = await submissionCheckpoint(progress, scope);
  const action = queue ? "queue" : "create";
  if (progress.action && progress.action !== action)
    throw new SubmissionCheckpointError(
      progress.action === "queue"
        ? "An earlier first Short submission is saved. No new Short was sent. Choose the Short action to continue."
        : "This setup was saved as create-only. No Short was sent.",
    );
  progress.action = action;
  checkpoint();
  if (!progress.workspace) {
    progress.workspaceId ??= (await api.createWorkspace(input.niche)).id;
    checkpoint();
    const authorized = (await api.listWorkspaces()).find(
      (item) => item.id === progress.workspaceId,
    );
    if (!authorized) throw new Error("Workspace access could not be verified.");
    progress.workspace = authorized;
  }
  if (progress.completed) return progress.workspace;
  const client = new BriefClient(progress.workspace.id);
  progress.channelId ??= await client.createChannel(input.niche);
  checkpoint();
  if (!progress.brief || progress.needsLanguageRepair) {
    progress.brief = await client.save(progress.channelId, {
      ...defaultBrief(input),
      budgetPolicy,
    });
    // The unsupported-language response is definitive: no run was created for the old Brief.
    progress.key = crypto.randomUUID();
    progress.needsLanguageRepair = false;
    if (action === "create") progress.completed = true;
    checkpoint();
  }
  if (action === "create") return progress.workspace;
  await queueFirstShort(client, progress, checkpoint);
  progress.completed = true;
  try {
    checkpoint();
  } catch {
    // An acknowledged action is still complete; its saved intent and key prevent an unsafe retry.
  }
  return progress.workspace;
}
async function queueFirstShort(
  client: BriefClient,
  progress: Progress,
  checkpoint: () => void,
): Promise<void> {
  if (!progress.brief) throw new SubmissionCheckpointError();
  try {
    await client.queue(progress.brief, progress.key);
  } catch (error) {
    if (error instanceof UnsupportedNarrationLanguageError) {
      progress.needsLanguageRepair = true;
      checkpoint();
    }
    throw error;
  }
}

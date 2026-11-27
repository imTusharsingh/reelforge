import { z } from "zod";
import { StoredChannelBriefSchema } from "../../../../packages/contracts/src/foundations";
import { api, type Workspace } from "../../lib/api";

const savedAttempt = z.object({
  workspaceId: z.uuid(), channelId: z.uuid().optional(),
  brief: StoredChannelBriefSchema.optional(), key:z.string(), needsLanguageRepair:z.boolean().optional(),
});
export type Progress = {
  workspace?: Workspace; workspaceId?:string; channelId?:string;
  brief?:z.infer<typeof StoredChannelBriefSchema>; key:string; needsLanguageRepair?:boolean;
};

// Every history entry in one wizard shares an ID. Scope its tab-local checkpoint
// to the signed-in user, and validate the saved workspace before reusing it.
export async function submissionCheckpoint(progress: Progress): Promise<() => void> {
  const {userId} = await api.me();
  const wizardId = z.uuid().parse(history.state?.briefWizardId);
  const key = `rf:onboarding:${userId}:${wizardId}`;
  const raw = sessionStorage.getItem(key);
  if (raw) {
    const saved = savedAttempt.parse(JSON.parse(raw));
    if (progress.workspace && progress.workspace.id !== saved.workspaceId)
      throw new Error("The saved submission belongs to another workspace");
    if (saved.brief && (saved.brief.workspaceId !== saved.workspaceId || saved.brief.channelId !== saved.channelId || !saved.key))
      throw new Error("Invalid saved Brief submission");
    Object.assign(progress,saved);
  }
  return ():void => {
    sessionStorage.setItem(key,JSON.stringify({
      workspaceId:progress.workspace?.id ?? progress.workspaceId,channelId:progress.channelId,
      brief:progress.brief,key:progress.key,needsLanguageRepair:progress.needsLanguageRepair,
    }));
  };
}

"use client";
import { useRef, useState, type FormEvent, type JSX } from "react";
import {
  defaultBrief,
  type OnboardingInput,
} from "../../../../packages/contracts/src/channel-brief";
import type { ChannelBrief } from "../../../../packages/contracts/src/foundations";
import {
  Alert,
  Button,
  Field,
  Panel,
  SelectField,
  StateMessage,
} from "../../components/ui/primitives";
import { api, type Workspace } from "../../lib/api";
import { BriefClient } from "./client";

type Progress = { workspace?: Workspace; channelId?: string; brief?: ChannelBrief; key: string };
async function start(input: OnboardingInput, progress: Progress): Promise<Workspace> {
  if (!progress.workspace) {
    const created = await api.createWorkspace(input.niche);
    const authorized = (await api.listWorkspaces()).find((item) => item.id === created.id);
    if (!authorized) throw new Error("Workspace access could not be verified.");
    progress.workspace = authorized;
  }
  const client = new BriefClient(progress.workspace.id);
  progress.channelId ??= await client.createChannel(input.niche);
  progress.brief ??= await client.save(progress.channelId, defaultBrief(input));
  await client.queue(progress.brief, progress.key);
  return progress.workspace;
}
export function Onboarding({
  onComplete,
}: {
  onComplete?: ((workspace: Workspace) => void) | undefined;
}): JSX.Element {
  const state = useOnboardingState({ onComplete });
  return <OnboardingView {...state} />;
}
type OnboardingState = {
  input: OnboardingInput;
  setInput: (value: OnboardingInput) => void;
  busy: boolean;
  error: string;
  queued: boolean;
  progress: import("react").RefObject<Progress>;
  submit: (event: FormEvent) => Promise<void>;
};
function useOnboardingState({
  onComplete,
}: {
  onComplete?: ((workspace: Workspace) => void) | undefined;
}): OnboardingState {
  const [input, setInput] = useState<OnboardingInput>({
    niche: "",
    audience: "",
    language: "English",
    voiceId: "Kore",
    cadence: {
      shortsPerDay: 1,
      localTime: "18:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  const progress = useRef<Progress>({ key: "" });
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");
    progress.current.key ||= crypto.randomUUID();
    try {
      const workspace = await start(input, progress.current);
      setQueued(true);
      onComplete?.(workspace);
    } catch {
      setError(
        "Setup could not finish. Retry to continue with the saved channel and Brief. The first run service may still be unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { input, setInput, busy, error, queued, progress, submit };
}
function OnboardingView({
  input,
  setInput,
  busy,
  error,
  queued,
  progress,
  submit,
}: ReturnType<typeof useOnboardingState>): JSX.Element {
  if (queued) return <StateMessage kind="success" description="Your first Short is queued." />;
  return (
    <Panel aria-labelledby="onboarding-title">
      <h1 id="onboarding-title">Your first Short</h1>
      <p>
        Five inputs. Everything else starts with safe defaults: L2 approval, $6 target / $8 cap,
        $20/day and $180/month.
      </p>
      {error && (
        <Alert tone="danger" title="Setup needs attention">
          {error}
        </Alert>
      )}
      <form onSubmit={submit} className="rf-form">
        <fieldset disabled={busy || Boolean(progress.current.brief)}>
          <legend>Channel Brief</legend>
          <SetupFields input={input} setInput={setInput} />
        </fieldset>
        <Button type="submit" loading={busy}>
          {progress.current.brief ? "Retry first Short" : "Create channel and start first Short"}
        </Button>
      </form>
    </Panel>
  );
}

function SetupFields({
  input,
  setInput,
}: Pick<OnboardingState, "input" | "setInput">): JSX.Element {
  return (
    <>
      {" "}
      <Field
        id="setup-niche"
        label="Niche or topic"
        required
        value={input.niche}
        onChange={(e) => setInput({ ...input, niche: e.target.value })}
      />
      <Field
        id="setup-audience"
        label="Audience"
        required
        value={input.audience}
        onChange={(e) => setInput({ ...input, audience: e.target.value })}
      />
      <Field
        id="setup-language"
        label="Language"
        required
        value={input.language}
        onChange={(e) => setInput({ ...input, language: e.target.value })}
      />
      <SelectField
        id="setup-voice"
        label="Narrator voice"
        value={input.voiceId}
        onChange={(e) => setInput({ ...input, voiceId: e.target.value })}
      >
        <option value="Kore">Kore</option>
        <option value="Puck">Puck</option>
      </SelectField>
      <Field
        id="setup-cadence"
        label={`Daily publishing time (${input.cadence.timezone})`}
        type="time"
        required
        value={input.cadence.localTime}
        onChange={(e) =>
          setInput({ ...input, cadence: { ...input.cadence, localTime: e.target.value } })
        }
      />
    </>
  );
}

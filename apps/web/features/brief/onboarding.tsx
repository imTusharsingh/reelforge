"use client";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import {
  defaultBrief,
  OnboardingInputSchema,
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
import { BrandLogo } from "../../components/brand-logo";
import { StudioLink } from "../../components/studio-link";
import { ensureCsrfToken } from "../../lib/csrf";
import { api, type Workspace } from "../../lib/api";
import { BriefClient, UnsupportedNarrationLanguageError } from "./client";

type Progress = {
  workspace?: Workspace;
  workspaceId?: string;
  channelId?: string;
  brief?: ChannelBrief;
  key: string;
  needsLanguageRepair?: boolean;
};
const audienceStep = OnboardingInputSchema.pick({ niche: true, audience: true, language: true });
const cadenceStep = OnboardingInputSchema.pick({ voiceId: true, cadence: true });
const normalizedLanguage = (language: string): string => language.trim().toLowerCase();

async function start(input: OnboardingInput, progress: Progress): Promise<Workspace> {
  await ensureCsrfToken();
  if (!progress.workspace) {
    progress.workspaceId ??= (await api.createWorkspace(input.niche)).id;
    const authorized = (await api.listWorkspaces()).find(
      (item) => item.id === progress.workspaceId,
    );
    if (!authorized) throw new Error("Workspace access could not be verified.");
    progress.workspace = authorized;
  }
  const client = new BriefClient(progress.workspace.id);
  progress.channelId ??= await client.createChannel(input.niche);
  if (!progress.brief || progress.needsLanguageRepair) {
    progress.brief = await client.save(progress.channelId, defaultBrief(input));
    // The unsupported-language response is definitive: no run was created for the old Brief.
    progress.key = crypto.randomUUID();
    progress.needsLanguageRepair = false;
  }
  try {
    await client.queue(progress.brief, progress.key);
  } catch (error) {
    if (error instanceof UnsupportedNarrationLanguageError) progress.needsLanguageRepair = true;
    throw error;
  }
  return progress.workspace;
}
export function Onboarding({
  onComplete,
  workspace,
}: {
  workspace?: Workspace | undefined;
  onComplete?: ((workspace: Workspace) => void) | undefined;
}): JSX.Element {
  const state = useOnboardingState({ onComplete, workspace });
  return <OnboardingView {...state} />;
}
type OnboardingState = {
  input: OnboardingInput;
  setInput: (value: OnboardingInput) => void;
  busy: boolean;
  error: string;
  languageError: string;
  queued: boolean;
  progress: import("react").RefObject<Progress>;
  step: number;
  back: () => void;
  submit: (event: FormEvent) => Promise<void>;
};
function initialInput(): OnboardingInput {
  return {
    niche: "",
    audience: "",
    language: "English",
    voiceId: "Kore",
    cadence: {
      shortsPerDay: 1,
      localTime: "18:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}
function useOnboardingDraft(): Pick<OnboardingState, "input" | "setInput" | "languageError"> & {
  setLanguageError: (message: string) => void;
} {
  const [input, setInput] = useState(initialInput);
  const [languageError, setLanguageError] = useState("");
  return {
    input,
    languageError,
    setLanguageError,
    setInput: (next): void => {
      if (next.language !== input.language) setLanguageError("");
      setInput(next);
    },
  };
}
function useOnboardingState({
  onComplete,
  workspace,
}: {
  workspace?: Workspace | undefined;
  onComplete?: ((workspace: Workspace) => void) | undefined;
}): OnboardingState {
  const { setLanguageError, ...draft } = useOnboardingDraft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  const [step, setStep] = useState(0);
  const progress = useRef<Progress>({ key: "", ...(workspace ? { workspace } : {}) });
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || queued) return;
    setError("");
    if (step < 2) {
      const issue = stepError(step, draft.input, progress.current);
      if (issue?.language) setLanguageError(issue.message);
      else if (issue) setError(issue.message);
      else setStep(step + 1);
      return;
    }
    const validated = OnboardingInputSchema.safeParse(draft.input);
    if (!validated.success) {
      setError(validated.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setBusy(true);
    try {
      const workspace = await start(validated.data, progress.current);
      setQueued(true);
      onComplete?.(workspace);
    } catch (error) {
      if (error instanceof UnsupportedNarrationLanguageError) {
        setLanguageError(error.message);
        setStep(0);
      } else {
        setError(
          "Setup could not finish. Retry to continue with the saved channel and Brief. The first run service may still be unavailable.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    ...draft,
    busy,
    error,
    queued,
    progress,
    step,
    back: () => setStep(step - 1),
    submit,
  };
}
function stepError(
  step: number,
  { niche, audience, language, voiceId, cadence }: OnboardingInput,
  progress: Progress,
): { language: boolean; message: string } | undefined {
  const result =
    step === 0
      ? audienceStep.safeParse({ niche, audience, language })
      : cadenceStep.safeParse({ voiceId, cadence });
  if (!result.success) {
    if (result.error.issues.some((issue) => issue.path[0] === "language"))
      return { language: true, message: "Enter a narration language." };
    return {
      language: false,
      message:
        step === 0
          ? "Enter a niche and audience (up to 200 characters each)."
          : "Check your voice and publishing time.",
    };
  }
  if (
    step === 0 &&
    progress.needsLanguageRepair &&
    progress.brief &&
    normalizedLanguage(progress.brief.languages.narration) === normalizedLanguage(language)
  )
    return { language: true, message: new UnsupportedNarrationLanguageError().message };
}
function OnboardingView({ error, queued, ...form }: OnboardingState): JSX.Element {
  if (queued)
    return (
      <StateMessage
        kind="success"
        description="Your first Short is queued."
        action={<StudioLink href="/">Open studio</StudioLink>}
      />
    );

  return (
    <Panel className="rf-wizard" aria-labelledby="onboarding-title">
      <BrandLogo inverse />
      <h1 id="onboarding-title">Create a Channel Brief</h1>
      <WizardProgress step={form.step} />
      {error && (
        <Alert tone="danger" title="Setup needs attention">
          {error}
        </Alert>
      )}
      {form.progress.current.needsLanguageRepair && (
        <p>Your channel is saved. Correct the language here to try the first Short again.</p>
      )}
      <OnboardingForm {...form} />
    </Panel>
  );
}

function OnboardingForm({
  input,
  setInput,
  busy,
  languageError,
  progress,
  step,
  back,
  submit,
}: Omit<OnboardingState, "error" | "queued">): JSX.Element {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (step === 0 && languageError)
      form.current?.querySelector<HTMLElement>("#setup-language")?.focus();
  }, [step, languageError]);
  const editingLocked = !!progress.current.channelId && !progress.current.needsLanguageRepair;
  return (
    <form ref={form} onSubmit={submit} className="rf-form">
      <fieldset key={step} disabled={busy || editingLocked}>
        <StepLegend step={step} />
        {step === 0 && (
          <AudienceFields input={input} setInput={setInput} languageError={languageError} />
        )}
        {step === 1 && <CadenceFields input={input} setInput={setInput} />}
        {step === 2 && (
          <p>
            {input.niche} · {input.audience} · {input.language} · {input.voiceId} ·{" "}
            {input.cadence.localTime} ({input.cadence.timezone}). Starts at L2 with a $6 target, $8
            per Short cap, $20 daily cap and $180 monthly cap.
          </p>
        )}
      </fieldset>
      <div className="rf-actions">
        {step > 0 && !editingLocked && (
          <Button tone="secondary" disabled={busy} onClick={back}>
            Back
          </Button>
        )}
        <Button type="submit" loading={busy}>
          {step < 2
            ? "Continue"
            : progress.current.needsLanguageRepair
              ? "Save corrected Brief and start first Short"
              : progress.current.brief
                ? "Retry first Short"
                : "Create channel and start first Short"}
        </Button>
      </div>
    </form>
  );
}

function StepLegend({ step }: { step: number }): JSX.Element {
  const legend = useRef<HTMLLegendElement>(null);
  useEffect(() => {
    if (step > 0) legend.current?.focus();
  }, [step]);
  return (
    <legend ref={legend} tabIndex={-1}>
      {wizardSteps[step]}
    </legend>
  );
}

const wizardSteps = ["Audience", "Voice & cadence", "Confirm"];

function WizardProgress({ step }: { step: number }): JSX.Element {
  return (
    <ol className="rf-wizard-steps" aria-label="Setup progress">
      {wizardSteps.map((name, index) => (
        <li key={name} aria-current={step === index ? "step" : undefined}>
          {name}
        </li>
      ))}
    </ol>
  );
}
type Fields = Pick<OnboardingState, "input" | "setInput">;
function AudienceFields({
  input,
  setInput,
  languageError,
}: Fields & { languageError: string }): JSX.Element {
  return (
    <>
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
        error={languageError}
        value={input.language}
        onChange={(e) => setInput({ ...input, language: e.target.value })}
      />
    </>
  );
}

function CadenceFields({ input, setInput }: Fields): JSX.Element {
  return (
    <>
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

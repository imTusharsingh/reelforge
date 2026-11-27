"use client";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import {
  defaultBrief,
  defaultBudgetPolicy,
  type BriefInput,
  OnboardingInputSchema,
  type OnboardingInput,
} from "../../../../packages/contracts/src/channel-brief";
import {
  AudienceFields,
  CadenceFields,
  WizardActions,
  WizardProgress,
  StepLegend,
} from "./onboarding-fields";
import { BudgetFields } from "./fields";
import { useWizardLocation } from "./wizard-location";
import {
  BudgetPolicySchema,
  type ChannelBrief,
} from "../../../../packages/contracts/src/foundations";
import { Alert, Panel, StateMessage } from "../../components/ui/primitives";
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

async function start(
  input: OnboardingInput,
  progress: Progress,
  budgetPolicy: BriefInput["budgetPolicy"],
  queue: boolean,
): Promise<Workspace> {
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
    progress.brief = await client.save(progress.channelId, {
      ...defaultBrief(input),
      budgetPolicy,
    });
    // The unsupported-language response is definitive: no run was created for the old Brief.
    progress.key = crypto.randomUUID();
    progress.needsLanguageRepair = false;
  }
  if (!queue) return progress.workspace;
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
  createdOnly: boolean;
  budget: BriefInput["budgetPolicy"];
  setBudget: (policy: BriefInput["budgetPolicy"]) => void;
  attempted: boolean;
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
      timezone: Intl.DateTimeFormat()
        .resolvedOptions()
        .timeZone.replace("Asia/Calcutta", "Asia/Kolkata"),
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
  const [budget, setBudget] = useState<BriefInput["budgetPolicy"]>(defaultBudgetPolicy);
  const [attempted, setAttempted] = useState(false);
  const { step, setStep } = useWizardLocation(
    workspace?.id,
    draft.input,
    draft.setInput,
    budget,
    setBudget,
  );
  const progress = useRef<Progress>({ key: "", ...(workspace ? { workspace } : {}) });
  const { busy, error, queued, createdOnly, finish, setError } = useSetupSubmission(
    progress,
    budget,
    onComplete,
    (message) => {
      setLanguageError(message);
      setStep(0);
    },
  );
  const submit = wizardSubmit({
    input: draft.input,
    step,
    progress,
    budget,
    busy,
    queued,
    finish,
    setStep,
    setLanguageError,
    setError,
    setAttempted,
  });
  return {
    ...draft,
    budget,
    setBudget,
    attempted,
    createdOnly,
    busy,
    error,
    queued,
    progress,
    step,
    back: () => setStep(step - 1),
    submit,
  };
}
function useSetupSubmission(
  progress: OnboardingState["progress"],
  budget: OnboardingState["budget"],
  onComplete: ((workspace: Workspace) => void) | undefined,
  repair: (message: string) => void,
): Pick<OnboardingState, "busy" | "error" | "queued" | "createdOnly"> &
  Pick<SubmitState, "finish" | "setError"> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  const [createdOnly, setCreatedOnly] = useState(false);
  const finish = async (input: OnboardingInput, queue: boolean): Promise<void> => {
    setBusy(true);
    try {
      const workspace = await start(input, progress.current, budget, queue);
      setCreatedOnly(!queue);
      setQueued(true);
      onComplete?.(workspace);
    } catch (error) {
      if (error instanceof UnsupportedNarrationLanguageError) {
        repair(error.message);
      } else {
        setError(
          "Setup could not finish. Retry to continue with the saved channel and Brief. The first run service may still be unavailable.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, queued, createdOnly, finish, setError };
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
function OnboardingView({ error, queued, createdOnly, ...form }: OnboardingState): JSX.Element {
  if (queued)
    return (
      <StateMessage
        kind="success"
        description={
          createdOnly ? "Your channel and Brief are saved." : "Your first Short is queued."
        }
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
  budget,
  setBudget,
  attempted,
  progress,
  step,
  back,
  submit,
}: Omit<OnboardingState, "error" | "queued" | "createdOnly">): JSX.Element {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (step === 0 && languageError)
      form.current?.querySelector<HTMLElement>("#setup-language")?.focus();
  }, [step, languageError]);
  const editingLocked = !!progress.current.channelId && !progress.current.needsLanguageRepair;
  return (
    <form noValidate ref={form} onSubmit={submit} className="rf-form">
      <fieldset key={step} disabled={busy || editingLocked}>
        <StepLegend step={step} />
        {step === 0 && (
          <AudienceFields
            input={input}
            setInput={setInput}
            languageError={languageError}
            attempted={attempted}
          />
        )}
        {step === 1 && <CadenceFields input={input} setInput={setInput} />}
        {step === 2 && (
          <>
            <p>
              {input.niche} · {input.audience} · {input.language} · {input.voiceId} ·{" "}
              {input.cadence.localTime} ({input.cadence.timezone})
            </p>
            <p>
              A typical 45-second Short is estimated at $4.13, with about $4.93 needed for the base
              budget. Shot planning refines the estimate.
            </p>
            <BudgetFields policy={budget} onChange={setBudget} />
          </>
        )}
      </fieldset>
      <WizardActions {...{ step, busy, editingLocked, progress, back }} />
    </form>
  );
}

type SubmitState = Pick<
  OnboardingState,
  "input" | "step" | "progress" | "budget" | "busy" | "queued"
> & {
  finish: (input: OnboardingInput, queue: boolean) => Promise<void>;
  setStep: (value: number) => void;
  setLanguageError: (value: string) => void;
  setError: (value: string) => void;
  setAttempted: (value: boolean) => void;
};
function wizardSubmit({
  input,
  step,
  progress,
  budget,
  busy,
  queued,
  finish,
  setStep,
  setLanguageError,
  setError,
  setAttempted,
}: SubmitState): OnboardingState["submit"] {
  return async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || queued) return;
    setError("");
    if (step < 2) {
      setAttempted(true);
      const issue = stepError(step, input, progress.current);
      if (issue?.language) setLanguageError(issue.message);
      else if (issue) setError(issue.message);
      else {
        setAttempted(false);
        setStep(step + 1);
      }
      return;
    }
    const validated = OnboardingInputSchema.safeParse(input);
    if (!validated.success) {
      setError(validated.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    if (!BudgetPolicySchema.safeParse(budget).success) {
      setError("Enter positive caps and keep the target within the per-Short cap.");
      return;
    }
    const queue = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "queue";
    await finish(validated.data, queue);
  };
}

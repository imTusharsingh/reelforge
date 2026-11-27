import { useEffect, useRef, type JSX } from "react";
import type { OnboardingInput } from "../../../../packages/contracts/src/channel-brief";
import { Button, Field, SelectField } from "../../components/ui/primitives";
type Fields = { input: OnboardingInput; setInput: (value: OnboardingInput) => void };
export function AudienceFields({
  input,
  setInput,
  languageError,
  attempted,
}: Fields & { languageError: string; attempted: boolean }): JSX.Element {
  return (
    <>
      <Field
        id="setup-niche"
        error={attempted && !input.niche.trim() ? "Enter a niche." : ""}
        maxLength={200}
        label="Niche or topic"
        required
        value={input.niche}
        onChange={(e) => setInput({ ...input, niche: e.target.value })}
      />
      <Field
        id="setup-audience"
        error={attempted && !input.audience.trim() ? "Enter an audience." : ""}
        maxLength={200}
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

export function CadenceFields({ input, setInput }: Fields): JSX.Element {
  return (
    <>
      <SelectField
        id="setup-voice"
        label="Narrator voice"
        value={input.voiceId}
        onChange={(e) => setInput({ ...input, voiceId: e.target.value })}
      >
        {["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"].map((voice) => (
          <option key={voice}>{voice}</option>
        ))}
      </SelectField>
      <SelectField
        id="setup-timezone"
        label="Publishing timezone"
        value={input.cadence.timezone}
        onChange={(e) =>
          setInput({ ...input, cadence: { ...input.cadence, timezone: e.target.value } })
        }
      >
        {[
          ...new Set([
            "UTC",
            input.cadence.timezone,
            ...Intl.supportedValuesOf("timeZone").map((zone) =>
              zone.replace("Asia/Calcutta", "Asia/Kolkata"),
            ),
          ]),
        ].map((zone) => (
          <option key={zone}>{zone}</option>
        ))}
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

export function StepLegend({ step }: { step: number }): JSX.Element {
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

export function WizardProgress({ step }: { step: number }): JSX.Element {
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

export function WizardActions({
  step,
  busy,
  editingLocked,
  progress,
  back,
}: {
  step: number;
  busy: boolean;
  back: () => void;
  progress: { current: { brief?: unknown; needsLanguageRepair?: boolean } };
  editingLocked: boolean;
}): JSX.Element {
  return (
    <div className="rf-actions">
      {step > 0 && !editingLocked && (
        <Button tone="secondary" disabled={busy} onClick={back}>
          Back
        </Button>
      )}
      {step === 2 && !progress.current.brief && (
        <Button type="submit" loading={busy}>
          Create channel
        </Button>
      )}
      <Button
        type="submit"
        value="queue"
        tone={step === 2 ? "secondary" : "primary"}
        loading={busy}
      >
        {step < 2
          ? "Continue"
          : progress.current.needsLanguageRepair
            ? "Save corrected Brief and start first Short"
            : progress.current.brief
              ? "Retry first Short"
              : "Create channel and start first Short"}
      </Button>
    </div>
  );
}

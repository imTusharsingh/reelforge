import { useState, type JSX } from "react";
import type { BriefInput } from "../../../../packages/contracts/src/channel-brief";
import { Field, SelectField, TextAreaField } from "../../components/ui/primitives";

type Props = { value: BriefInput; onChange: (value: BriefInput) => void; offerL3: boolean };
export function IdentityFields({ value, onChange, offerL3 }: Props): JSX.Element {
  return (
    <fieldset>
      <legend>Channel direction</legend>
      {(["topic", "niche", "audience"] as const).map((key) => (
        <Field
          key={key}
          id={`brief-${key}`}
          label={key[0]!.toUpperCase() + key.slice(1)}
          required
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        />
      ))}
      {(["script", "narration", "captions"] as const).map((key) => (
        <Field
          key={key}
          id={`language-${key}`}
          label={`${key[0]!.toUpperCase() + key.slice(1)} language`}
          required
          value={value.languages[key]}
          onChange={(e) =>
            onChange({
              ...value,
              languages: { ...value.languages, [key]: e.target.value },
              ...(key === "narration"
                ? {
                    narrationLanguage: e.target.value,
                    narratorVoice: value.narratorVoice
                      ? { ...value.narratorVoice, language: e.target.value }
                      : null,
                  }
                : {}),
            })
          }
        />
      ))}
      <Field
        id="target-duration"
        label="Target video length (seconds)"
        type="number"
        min={30}
        max={45}
        required
        hint="Choose a target between 30 and 45 seconds."
        value={value.targetDurationSeconds}
        onChange={(e) => onChange({ ...value, targetDurationSeconds: Number(e.target.value) })}
      />
      <AutonomyField {...{ value, onChange, offerL3 }} />
    </fieldset>
  );
}
export function ScheduleBudget({ value, onChange }: Omit<Props, "offerL3">): JSX.Element {
  return (
    <fieldset>
      <legend>Cadence and budget</legend>
      <Field
        id="shorts-per-day"
        label="Shorts per day"
        type="number"
        min={1}
        max={24}
        value={value.cadence.shortsPerDay}
        onChange={(e) =>
          onChange({
            ...value,
            cadence: { ...value.cadence, shortsPerDay: Number(e.target.value) },
          })
        }
      />
      <Field
        id="local-time"
        label="Local publishing time"
        type="time"
        value={value.cadence.localTime}
        onChange={(e) =>
          onChange({ ...value, cadence: { ...value.cadence, localTime: e.target.value } })
        }
      />
      <Field
        id="timezone"
        label="Channel timezone"
        value={value.cadence.timezone}
        onChange={(e) =>
          onChange({ ...value, cadence: { ...value.cadence, timezone: e.target.value } })
        }
      />
      <BudgetFields
        policy={value.budgetPolicy}
        onChange={(budgetPolicy) => onChange({ ...value, budgetPolicy })}
      />
    </fieldset>
  );
}
export function StyleFields({ value, onChange }: Omit<Props, "offerL3">): JSX.Element {
  return (
    <fieldset>
      <legend>Style bible and guardrails</legend>
      <Field
        id="visual-style"
        label="Visual style"
        value={value.styleBible.visualStyle}
        onChange={(e) =>
          onChange({ ...value, styleBible: { ...value.styleBible, visualStyle: e.target.value } })
        }
      />
      {(["palette", "bannedVisuals"] as const).map((key) => (
        <LinesField
          key={key}
          id={key}
          label={
            key === "palette" ? "Palette (one color per line)" : "Banned visuals (one per line)"
          }
          lines={value.styleBible[key]}
          onLines={(lines) =>
            onChange({
              ...value,
              styleBible: {
                ...value.styleBible,
                [key]: lines,
              },
            })
          }
        />
      ))}
      <GuardrailFields value={value} onChange={onChange} />
    </fieldset>
  );
}
export function JsonField({
  label,
  value,
  validate,
  onChange,
}: {
  label: string;
  value: unknown;
  validate?: ((value: unknown) => string) | undefined;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState(() => validate?.(value) ?? "");
  return (
    <TextAreaField
      id={`json-${label.replaceAll(" ", "-")}`}
      label={label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}
      hint="Advanced configuration in JSON. Preserve existing field names when editing."
      rows={5}
      value={raw}
      error={error}
      ref={(element) => {
        element?.setCustomValidity(error);
      }}
      onChange={(e) => {
        setRaw(e.target.value);
        try {
          const parsed: unknown = JSON.parse(e.target.value);
          onChange(parsed);
          const issue = validate?.(parsed) ?? "";
          setError(issue);
        } catch {
          setError("Enter valid JSON before saving.");
        }
      }}
    />
  );
}

function GuardrailFields({ value, onChange }: Omit<Props, "offerL3">): JSX.Element {
  return (
    <>
      {" "}
      {(["bannedTopics", "topicsToAvoid"] as const).map((key) => (
        <LinesField
          key={key}
          id={key}
          label={
            key === "bannedTopics"
              ? "Banned topics (one per line)"
              : "Topics to avoid (one per line)"
          }
          lines={value.guardrails[key]}
          onLines={(lines) =>
            onChange({
              ...value,
              guardrails: {
                ...value.guardrails,
                [key]: lines,
              },
            })
          }
        />
      ))}
      <SelectField
        id="fact-check"
        label="Fact-check strictness"
        value={value.guardrails.factCheckStrictness}
        onChange={(e) =>
          onChange({
            ...value,
            guardrails: {
              ...value.guardrails,
              factCheckStrictness: e.target.value as "STANDARD" | "STRICT",
            },
          })
        }
      >
        <option>STANDARD</option>
        <option>STRICT</option>
      </SelectField>
      <p>
        Real people and brands are blocked. AI personas cannot give health, legal, finance or
        political advice. AI disclosure is always on.
      </p>
    </>
  );
}

function LinesField({
  id,
  label,
  lines,
  onLines,
}: {
  id: string;
  label: string;
  lines: string[];
  onLines: (lines: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(lines.join("\n"));
  return (
    <TextAreaField
      id={id}
      label={label}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        onLines(
          raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

export function BudgetFields({
  policy,
  onChange,
}: {
  policy: BriefInput["budgetPolicy"];
  onChange: (value: BriefInput["budgetPolicy"]) => void;
}): JSX.Element {
  return (
    <>
      {" "}
      {(["targetMinor", "hardCapMinor", "dailyLimitMinor", "monthlyLimitMinor"] as const).map(
        (key) => (
          <Field
            key={key}
            id={`budget-${key}`}
            label={`${{ targetMinor: "Target per Short", hardCapMinor: "Hard cap per Short", dailyLimitMinor: "Daily cap", monthlyLimitMinor: "Monthly cap" }[key]} (USD cents)`}
            type="number"
            min={0}
            step={1}
            value={policy[key]}
            onChange={(e) => onChange({ ...policy, [key]: Number(e.target.value) })}
          />
        ),
      )}
    </>
  );
}

function AutonomyField({ value, onChange, offerL3 }: Props): JSX.Element {
  return (
    <>
      {" "}
      <SelectField
        id="brief-autonomy"
        label="Autonomy"
        value={value.requestedAutonomy}
        onChange={(e) =>
          onChange({
            ...value,
            requestedAutonomy: e.target.value as BriefInput["requestedAutonomy"],
          })
        }
      >
        <option value="L1">L1 — approve each stage</option>
        <option value="L2">L2 — approve before publish</option>
        <option value="L3" disabled={!offerL3}>
          L3 — full auto{offerL3 ? "" : " (locked until 10 approved Shorts)"}
        </option>
      </SelectField>
      <p>Hard safety and budget gates always apply.</p>
    </>
  );
}

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
          label={key}
          required
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        />
      ))}
      {(["script", "narration", "captions"] as const).map((key) => (
        <Field
          key={key}
          id={`language-${key}`}
          label={`${key} language`}
          required
          value={value.languages[key]}
          onChange={(e) =>
            onChange({
              ...value,
              languages: { ...value.languages, [key]: e.target.value },
              ...(key === "narration" ? { narrationLanguage: e.target.value } : {}),
            })
          }
        />
      ))}
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
      {(["targetMinor", "hardCapMinor", "dailyLimitMinor", "monthlyLimitMinor"] as const).map(
        (key) => (
          <Field
            key={key}
            id={`budget-${key}`}
            label={`${{ targetMinor: "Target per Short", hardCapMinor: "Hard cap per Short", dailyLimitMinor: "Daily cap", monthlyLimitMinor: "Monthly cap" }[key]} (USD cents)`}
            type="number"
            min={0}
            step={1}
            value={value.budgetPolicy[key]}
            onChange={(e) =>
              onChange({
                ...value,
                budgetPolicy: { ...value.budgetPolicy, [key]: Number(e.target.value) },
              })
            }
          />
        ),
      )}
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
        <TextAreaField
          key={key}
          id={key}
          label={
            key === "palette" ? "Palette (one color per line)" : "Banned visuals (one per line)"
          }
          value={value.styleBible[key].join("\n")}
          onChange={(e) =>
            onChange({
              ...value,
              styleBible: {
                ...value.styleBible,
                [key]: e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
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
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  return (
    <TextAreaField
      id={`json-${label.replaceAll(" ", "-")}`}
      label={label}
      rows={5}
      value={raw}
      error={error}
      onChange={(e) => {
        setRaw(e.target.value);
        e.target.setCustomValidity("");
        try {
          const parsed: unknown = JSON.parse(e.target.value);
          onChange(parsed);
          setError("");
        } catch {
          e.target.setCustomValidity("Enter valid JSON before saving.");
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
        <TextAreaField
          key={key}
          id={key}
          label={
            key === "bannedTopics"
              ? "Banned topics (one per line)"
              : "Topics to avoid (one per line)"
          }
          value={value.guardrails[key].join("\n")}
          onChange={(e) =>
            onChange({
              ...value,
              guardrails: {
                ...value.guardrails,
                [key]: e.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
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

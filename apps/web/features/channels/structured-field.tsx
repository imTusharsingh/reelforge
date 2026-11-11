"use client";
import type { JSX } from "react";
import { Field, SelectField, TextAreaField } from "../../components/ui/primitives";
import { isRecord, pretty, type ApiObject, type CommonField, type FieldSpec } from "./model";
export function StructuredField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  let object: ApiObject | null = null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) object = parsed;
  } catch {
    /* Keep invalid advanced JSON available for correction. */
  }
  const update = (common: CommonField, next: string): void => {
    if (!object) return;
    const updated = { ...object };
    if (!next.trim()) delete updated[common.key];
    else if (common.kind === "lines")
      updated[common.key] = next
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean);
    else if (common.kind === "number") updated[common.key] = Number(next);
    else if (common.kind === "boolean") updated[common.key] = next === "true";
    else updated[common.key] = next;
    onChange(pretty(updated));
  };
  return (
    <section className="rf-structured-field" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{field.label}</h4>
      {!object && <p role="alert">Correct the advanced JSON before using these controls.</p>}
      {field.common?.map((common) => {
        const raw = object?.[common.key];
        const display = Array.isArray(raw) ? raw.join("\n") : raw === undefined ? "" : String(raw);
        const props = {
          id: `${id}-${common.key}`,
          label: common.label,
          value: display,
          disabled: !object,
          onChange: (e: { target: { value: string } }): void => update(common, e.target.value),
        };
        if (common.choices || common.kind === "boolean")
          return (
            <SelectField key={common.key} {...props}>
              <option value="">Not configured</option>
              {(common.choices ?? ["true", "false"]).map((choice) => (
                <option key={choice} value={choice}>
                  {choice === "true" ? "Yes" : choice === "false" ? "No" : choice}
                </option>
              ))}
            </SelectField>
          );
        if (common.kind === "lines")
          return <TextAreaField key={common.key} {...props} hint="One item per line" rows={3} />;
        return (
          <Field
            key={common.key}
            {...props}
            type={common.kind === "number" ? "number" : common.kind === "time" ? "time" : "text"}
          />
        );
      })}
      <details>
        <summary>Advanced {field.label.toLowerCase()} JSON</summary>
        <TextAreaField
          id={id}
          label={`${field.label} JSON`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          hint={field.hint ?? "Additional settings are preserved when common fields change."}
        />
      </details>
    </section>
  );
}

"use client";
import { useId, type JSX } from "react";
import { Alert, SelectField, StateMessage } from "../../components/ui/primitives";
import { record } from "./model";
export function LoadState({
  loading,
  error,
  empty = false,
}: {
  loading: boolean;
  error: string;
  empty?: boolean;
}): JSX.Element | null {
  if (error)
    return (
      <Alert tone="danger" title="Planning data unavailable">
        {error}
      </Alert>
    );
  if (loading)
    return <StateMessage kind="loading" description="Loading persisted planning data…" />;
  if (empty) return <StateMessage kind="empty" description="Nothing has been saved here yet." />;
  return null;
}
export function Choice({
  label,
  items,
  value,
  onChange,
  disabled = false,
  emptyLabel = "Choose an item",
}: {
  label: string;
  items: Record<string, unknown>[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}): JSX.Element {
  const id = useId();
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {items
        .filter((v) => typeof v.id === "string")
        .map((v) => (
          <option key={String(v.id)} value={String(v.id)}>
            {typeof v.name === "string"
              ? v.name
              : record(v.profile) && typeof v.profile.name === "string"
                ? `${v.profile.name} — version ${String(v.version)}`
                : `Version ${String(v.version ?? v.id)}`}
          </option>
        ))}
    </SelectField>
  );
}
export const json = (v: unknown): string => JSON.stringify(v, null, 2);
export function SafeReferences({ items }: { items: string[] }): JSX.Element {
  return (
    <ul>
      {items.map((ref, index) => (
        <li key={index}>
          {/^https?:\/\//i.test(ref) ? (
            <a href={ref} target="_blank" rel="noreferrer">
              {ref}
            </a>
          ) : (
            ref
          )}
        </li>
      ))}
    </ul>
  );
}

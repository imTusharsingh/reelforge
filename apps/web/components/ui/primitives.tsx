import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  JSX,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  loading?: boolean;
  children: ReactNode;
};

export function Button({
  tone = "primary",
  loading = false,
  disabled,
  children,
  className = "",
  type = "button",
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      type={type}
      className={`rf-button rf-button--${tone} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? "Working…" : children}
    </button>
  );
}

type IconButtonProps = Omit<ButtonProps, "children"> & {
  label: string;
  children: ReactNode;
};

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <Button {...props} className={`rf-icon-button ${className}`.trim()} aria-label={label}>
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ id, label, hint, error, ...props }: FieldProps): JSX.Element {
  const helpId = hint || error ? `${id}-help` : undefined;
  return (
    <div className="rf-field">
      <label htmlFor={id}>{label}</label>
      <input {...props} id={id} className="rf-input" aria-invalid={Boolean(error) || undefined} aria-describedby={helpId} />
      {helpId && (
        <p id={helpId} className={error ? "rf-field-error" : "rf-field-hint"}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
};

export function TextAreaField({
  id,
  label,
  hint,
  error,
  ...props
}: TextAreaFieldProps): JSX.Element {
  const helpId = hint || error ? `${id}-help` : undefined;
  return (
    <div className="rf-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        {...props}
        id={id}
        className="rf-input rf-textarea"
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={helpId}
      />
      {helpId && (
        <p id={helpId} className={error ? "rf-field-error" : "rf-field-hint"}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  id: string;
  label: string;
  children: ReactNode;
};

export function SelectField({ id, label, children, ...props }: SelectFieldProps): JSX.Element {
  return (
    <div className="rf-field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id} className="rf-input">
        {children}
      </select>
    </div>
  );
}

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}): JSX.Element {
  return <span className={`rf-badge rf-badge--${tone}`}>{children}</span>;
}

export function Panel({
  children,
  className = "",
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }): JSX.Element {
  return (
    <section {...props} className={`rf-panel ${className}`.trim()}>
      {children}
    </section>
  );
}

type StateKind = "loading" | "empty" | "error" | "success" | "forbidden" | "unavailable";
const stateLabels: Record<StateKind, string> = {
  loading: "Loading",
  empty: "Nothing here yet",
  error: "Something went wrong",
  success: "Completed",
  forbidden: "Access restricted",
  unavailable: "Not configured",
};

export function StateMessage({
  kind,
  description,
  action,
}: {
  kind: StateKind;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className={`rf-state rf-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="rf-state__symbol" aria-hidden="true">
        {kind === "success" ? "✓" : kind === "error" ? "!" : "·"}
      </span>
      <div>
        <strong>{stateLabels[kind]}</strong>
        <p>{description}</p>
        {action}
      </div>
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`rf-alert rf-alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

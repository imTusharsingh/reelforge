import type { JSX, ReactNode } from "react";

export function PageHeading({
  label,
  title,
  children,
  actions,
  hero = false,
}: {
  label: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  hero?: boolean;
}): JSX.Element {
  return (
    <header className={hero ? "rf-page-heading rf-page-heading--hero" : "rf-page-heading"}>
      <div className="rf-heading-copy">
        <p className="rf-eyebrow">{label}</p>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="rf-heading-actions">{actions}</div>}
      {hero && (
        <div className="rf-hero-art" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </header>
  );
}

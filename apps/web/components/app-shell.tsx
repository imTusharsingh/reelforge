"use client";

import { useRef, type JSX, type ReactNode } from "react";
import { BrandLogo } from "./brand-logo";
import { IconButton } from "./ui/primitives";

const destinations = ["Overview", "Production", "Review queue", "Publishing", "Insights"];

function Navigation({ mobile = false }: { mobile?: boolean }): JSX.Element {
  return (
    <nav aria-label={mobile ? "Mobile studio navigation" : "Studio navigation"}>
      <p className="rf-nav-caption">Studio</p>
      <ul className="rf-nav-list">
        {destinations.map((name, index) => (
          <li key={name}>
            {index === 0 ? (
              <span
                className="rf-nav-item rf-nav-item--current"
                aria-label="Overview, current view"
              >
                {name}
              </span>
            ) : (
              <span className="rf-nav-item rf-nav-item--disabled">
                {name} <span className="rf-nav-soon">Planned</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppShell({
  children,
  inspector,
}: {
  children: ReactNode;
  inspector?: ReactNode;
}): JSX.Element {
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openMenu = (): void => menu.current?.showModal();
  const closeMenu = (): void => menu.current?.close();
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const openInspector = (): void => inspectorDialog.current?.showModal();
  const closeInspector = (): void => inspectorDialog.current?.close();
  return (
    <div className="rf-shell">
      <a className="rf-skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="rf-sidebar" aria-label="Studio frame">
        <BrandLogo inverse />
        <Navigation />
        <p className="rf-sidebar-note">Foundation preview · M21</p>
      </aside>
      <div className="rf-shell-body">
        <header className="rf-shell-header">
          <div className="rf-mobile-brand">
            <BrandLogo inverse />
          </div>
          <span className="rf-breadcrumb">Studio / Overview</span>
          <span className="rf-shell-label">Design foundation</span>
          {inspector && (
            <button
              ref={inspectorTrigger}
              type="button"
              className="rf-button rf-button--secondary rf-inspector-trigger"
              onClick={openInspector}
              aria-haspopup="dialog"
            >
              View context
            </button>
          )}
          <div className="rf-mobile-menu">
            <button
              ref={trigger}
              type="button"
              className="rf-button rf-button--ghost rf-icon-button"
              onClick={openMenu}
              aria-label="Open studio navigation"
            >
              Menu
            </button>
          </div>
        </header>
        <div className="rf-workspace">
          <main id="main-content" className="rf-workspace-main" tabIndex={-1}>
            {children}
          </main>
          {inspector && (
            <aside className="rf-inspector" aria-label="Context panel">
              {inspector}
            </aside>
          )}
        </div>
      </div>
      {inspector && (
        <dialog
          ref={inspectorDialog}
          className="rf-context-dialog"
          aria-label="Context panel"
          onClose={() => inspectorTrigger.current?.focus()}
        >
          <div className="rf-context-dialog-header">
            <strong>Context panel</strong>
            <IconButton label="Close context panel" tone="ghost" onClick={closeInspector}>
              Close
            </IconButton>
          </div>
          {inspector}
        </dialog>
      )}
      <dialog
        ref={menu}
        className="rf-mobile-dialog"
        aria-label="Studio navigation"
        onClose={() => trigger.current?.focus()}
      >
        <div className="rf-mobile-dialog-header">
          <strong>Studio navigation</strong>
          <IconButton label="Close studio navigation" tone="ghost" onClick={closeMenu}>
            Close
          </IconButton>
        </div>
        <Navigation mobile />
        <p className="rf-sidebar-note">Other sections arrive in later milestones.</p>
      </dialog>
    </div>
  );
}

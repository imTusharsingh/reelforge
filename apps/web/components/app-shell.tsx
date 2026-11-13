"use client";

import { useRef, type JSX, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { StudioLink } from "./studio-link";
import { BrandLogo } from "./brand-logo";
import { IconButton } from "./ui/primitives";

const destinations = [
  { name: "Overview", href: "/" },
  { name: "Channels", href: "/channels" },
  { name: "Planning", href: "/planning" },
  { name: "Operations", href: "/operations" },
  { name: "Production", href: "/production" },
  { name: "Review queue", href: "/review" },
  { name: "Publishing", href: null },
  { name: "Insights", href: null },
  { name: "Account", href: "/account" },
];

function Navigation({ mobile = false }: { mobile?: boolean }): JSX.Element {
  const pathname = usePathname();
  return (
    <nav aria-label={mobile ? "Mobile studio navigation" : "Studio navigation"}>
      <p className="rf-nav-caption">Studio</p>
      <ul className="rf-nav-list">
        {destinations.map(({ name, href }) => (
          <li key={name}>
            {href ? (
              <StudioLink
                className={`rf-nav-item ${pathname === href || (href === "/channels" && pathname.startsWith("/channels/")) || (href === "/planning" && pathname.startsWith("/planning/")) || (href === "/production" && pathname.startsWith("/production/")) || (href === "/review" && pathname.startsWith("/review/")) || (href === "/account" && pathname.startsWith("/account")) ? "rf-nav-item--current" : ""}`.trim()}
                href={href}
                aria-current={
                  pathname === href ||
                  (href === "/channels" && pathname.startsWith("/channels/")) ||
                  (href === "/planning" && pathname.startsWith("/planning/")) ||
                  (href === "/production" && pathname.startsWith("/production/")) ||
                  (href === "/review" && pathname.startsWith("/review/")) ||
                  (href === "/account" && pathname.startsWith("/account"))
                    ? "page"
                    : undefined
                }
              >
                {name}
              </StudioLink>
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
  shellActions,
}: {
  children: ReactNode;
  inspector?: ReactNode;
  shellActions?: ReactNode;
}): JSX.Element {
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openMenu = (): void => menu.current?.showModal();
  const closeMenu = (): void => menu.current?.close();
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const openInspector = (): void => inspectorDialog.current?.showModal();
  const closeInspector = (): void => inspectorDialog.current?.close();
  const pathname = usePathname();
  const breadcrumb = pathname.startsWith("/review")
    ? "Studio / Review"
    : pathname.startsWith("/production")
      ? "Studio / Production"
      : pathname.startsWith("/planning")
        ? "Studio / Planning"
        : pathname.startsWith("/channels")
          ? "Studio / Channels"
          : pathname === "/operations"
            ? "Studio / Operations"
            : pathname.startsWith("/account")
              ? "Studio / Account"
              : "Studio / Overview";
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
          <span className="rf-breadcrumb">{breadcrumb}</span>
          <span className="rf-shell-label">Design foundation</span>
          {shellActions}
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

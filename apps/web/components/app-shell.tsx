"use client";

import { useRef, type JSX, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { StudioLink } from "./studio-link";
import { BrandLogo } from "./brand-logo";
import { Button } from "./ui/primitives";
import { Modal } from "./ui/studio";
import { Icon } from "./ui/icon";
import { studioDestinations } from "./pipeline-navigation";

function Navigation({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const route = usePathname();
  const pathname =
    route === "/account" || route === "/publishing/accounts" || route.startsWith("/channels/")
      ? "/settings"
      : route === "/runs" || route.startsWith("/runs/")
        ? "/"
        : route;
  return (
    <nav aria-label="Studio navigation">
      <ul className="rf-nav-list">
        {studioDestinations().map(({ name, href, icon }) => (
          <li key={href}>
            <StudioLink
              className="rf-nav-item"
              href={href}
              aria-current={
                pathname === href || (href !== "/" && pathname.startsWith(href + "/"))
                  ? "page"
                  : undefined
              }
              onClick={() => onNavigate?.()}
            >
              <span className="rf-nav-icon" aria-hidden="true">
                <Icon name={icon} />
              </span>
              {name}
            </StudioLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppShell({
  children,
  workspaceName,
  shellActions,
}: {
  children: ReactNode;
  workspaceName?: string;
  shellActions?: ReactNode;
}): JSX.Element {
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="rf-shell">
      <a className="rf-skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="rf-sidebar">
        <BrandLogo inverse />
        <p className="rf-sidebar-label">Workspace</p>
        <Navigation />
        <div className="rf-sidebar-note" aria-hidden="true">
          <Icon name="film" /> Short-form production
        </div>
      </aside>
      <div>
        <header className="rf-shell-header">
          <div className="rf-cluster rf-workspace-ident">
            <Button
              ref={trigger}
              className="rf-menu-toggle"
              tone="secondary"
              aria-haspopup="dialog"
              onClick={() => menu.current?.showModal()}
            >
              <Icon name="menu" /> Menu
            </Button>
            {workspaceName && (
              <div className="rf-workspace-label">
                <span className="rf-workspace-avatar" aria-hidden="true">
                  {workspaceName.trim().slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <span className="rf-workspace-caption">Active workspace</span>
                  <strong>{workspaceName}</strong>
                </div>
              </div>
            )}
          </div>
          {shellActions}
        </header>
        <main id="main-content" className="rf-workspace-main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <Modal dialog={menu} title="Studio navigation" onClose={() => trigger.current?.focus()}>
        <Navigation onNavigate={() => menu.current?.close()} />
      </Modal>
    </div>
  );
}

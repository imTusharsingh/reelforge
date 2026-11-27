"use client";

import { useId, useRef, type JSX, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { StudioLink } from "./studio-link";
import { BrandLogo } from "./brand-logo";
import { Button } from "./ui/primitives";
import { Modal } from "./ui/studio";
import { Icon } from "./ui/icon";
import { studioDestinations } from "./pipeline-navigation";

function Navigation({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const route = usePathname() ?? "/";
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
              onNavigate={() => onNavigate?.()}
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

function WorkspaceSwitch({ name, onSwitch }: { name: string; onSwitch: () => void }): JSX.Element {
  return (
    <Button
      className="rf-workspace-switch"
      tone="ghost"
      aria-label={`Switch workspace: ${name}`}
      title={`Switch workspace: ${name}`}
      onClick={onSwitch}
    >
      <span className="rf-workspace-avatar" aria-hidden="true">
        <Icon name="workspace" />
      </span>
      <span className="rf-workspace-name">{name}</span>
      <Icon name="chevron-down" />
    </Button>
  );
}

export function AppShell({
  children,
  workspaceName,
  onWorkspaceSwitch,
  onSignOut,
}: {
  children: ReactNode;
  workspaceName: string;
  onWorkspaceSwitch: () => void;
  onSignOut: () => boolean;
}): JSX.Element {
  const menu = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
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
          <Button
            ref={trigger}
            className="rf-menu-toggle"
            tone="ghost"
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-controls={menuId}
            onClick={() => menu.current?.showModal()}
          >
            <Icon name="menu" />
          </Button>
          <WorkspaceSwitch name={workspaceName} onSwitch={onWorkspaceSwitch} />
          <Button tone="ghost" className="rf-desktop-signout" onClick={onSignOut}>
            Sign out
          </Button>
        </header>
        <main id="main-content" className="rf-workspace-main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <Modal
        id={menuId}
        dialog={menu}
        title="Studio navigation"
        onClose={() => trigger.current?.focus()}
      >
        <Navigation onNavigate={() => menu.current?.close()} />
        <div className="rf-nav-footer">
          <Button
            tone="ghost"
            onClick={() => {
              if (onSignOut()) menu.current?.close();
            }}
          >
            Sign out
          </Button>
        </div>
      </Modal>
    </div>
  );
}

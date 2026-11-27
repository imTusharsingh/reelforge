import type { JSX, ReactNode } from "react";
import { Tabs } from "../../components/ui/tabs";
import { PageHeading } from "../../components/ui/page-heading";

const settings = [
  { label: "Provider keys", href: "/settings" },
  { label: "Channel Brief", href: "/settings/channel" },
  { label: "YouTube connection", href: "/publishing/accounts" },
  { label: "Account", href: "/account" },
];

export function StudioSettings({
  current,
  children,
}: {
  current: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="rf-stack">
      <PageHeading title="Settings">
        Manage your channel, provider connections, and account.
      </PageHeading>
      <Tabs label="Settings sections" items={settings} current={current} />
      {children}
    </section>
  );
}

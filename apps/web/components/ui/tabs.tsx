import type { JSX } from "react";
import { StudioLink } from "../studio-link";

export function Tabs({ label, items, current }: {
  label: string;
  items: { label: string; href: string }[];
  current: string;
}): JSX.Element {
  return (
    <nav className="rf-tabs" aria-label={label}>
      {items.map((item) => (
        <StudioLink key={item.href} className="rf-tab" href={item.href} aria-current={item.href === current ? "page" : undefined}>
          {item.label}
        </StudioLink>
      ))}
    </nav>
  );
}

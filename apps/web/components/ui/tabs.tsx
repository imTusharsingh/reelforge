"use client";

import { useId, useState, type JSX, type ReactNode } from "react";

type TabItem = { id: string; label: string; content: ReactNode };

export function Tabs({
  label,
  items,
}: {
  label: string;
  items: readonly TabItem[];
}): JSX.Element | null {
  const baseId = useId();
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  if (items.length === 0) return null;
  const current = items.some((item) => item.id === activeId) ? activeId : items[0]!.id;
  const activate = (index: number): void => {
    setActiveId(items[index]!.id);
    document.getElementById(`${baseId}-tab-${index}`)?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    activate(next);
  };
  return (
    <div className="rf-tabs">
      <div className="rf-tab-list" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.id}
            id={`${baseId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={current === item.id}
            aria-controls={`${baseId}-panel-${index}`}
            tabIndex={current === item.id ? 0 : -1}
            onClick={() => setActiveId(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="rf-tab"
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item, index) => (
        <div
          key={item.id}
          id={`${baseId}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${index}`}
          hidden={current !== item.id}
          tabIndex={0}
          className="rf-tab-panel"
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icon";

type Tone = "success" | "info" | "warning" | "danger";
type Notice = { tone: Tone; title: string; detail?: string };
type NoticeItem = Notice & { id: number };
type Notify = (notice: Notice) => void;

const Notifications = createContext<Notify>(() => undefined);
const noticeIcon: Record<Tone, IconName> = {
  success: "check",
  info: "info",
  warning: "warning",
  danger: "warning",
};

export function useNotify(): Notify {
  return useContext(Notifications);
}

export function NotificationProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<NoticeItem[]>([]);
  const sequence = useRef(0);
  const notify = useCallback<Notify>((notice) => {
    const id = ++sequence.current;
    setItems((current) =>
      [
        ...current.filter(
          (item) =>
            item.title !== notice.title ||
            item.tone !== notice.tone ||
            item.detail !== notice.detail,
        ),
        { ...notice, id },
      ].slice(-5),
    );
  }, []);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  return (
    <Notifications.Provider value={notify}>
      {children}
      {items.length > 0 && (
        <aside className="rf-notifications" aria-label="Notifications">
          {items.map((item) => (
            <NotificationCard key={item.id} item={item} dismiss={dismiss} />
          ))}
        </aside>
      )}
    </Notifications.Provider>
  );
}

function NotificationCard({
  item,
  dismiss,
}: {
  item: NoticeItem;
  dismiss: (id: number) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const { id, tone, title, detail } = item;
  useEffect(() => {
    if (hovered || focused || tone === "warning" || tone === "danger") return;
    const timer = window.setTimeout(() => dismiss(id), 6000);
    return (): void => window.clearTimeout(timer);
  }, [dismiss, focused, hovered, id, tone]);
  return (
    <div
      className={`rf-notification rf-notification--${tone}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon name={noticeIcon[tone]} />
      <div role={tone === "danger" ? "alert" : "status"} aria-atomic="true">
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      <button
        type="button"
        className="rf-notification__close"
        aria-label={`Dismiss notification: ${title}`}
        onClick={() => dismiss(id)}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

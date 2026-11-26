"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icon";

type Tone = "success" | "info" | "warning" | "danger";
type BlockingTone = Extract<Tone, "warning" | "danger">;
type Notice = { tone: Tone; title: string; detail?: string };
type NoticeItem = Notice & { id: number; route: string | null };
type InlineTarget = { node: HTMLDivElement; tone: BlockingTone };
type Notify = (notice: Notice) => void;
type Register = (target: InlineTarget) => () => void;

const Notifications = createContext<Notify>(() => undefined);
const InlineTargets = createContext<Register>(() => (): void => undefined);
const noticeIcon: Record<Tone, IconName> = {
  success: "check",
  info: "info",
  warning: "warning",
  danger: "warning",
};

export function useNotify(): Notify {
  return useContext(Notifications);
}

export function InlineNoticeSlot({ tone }: { tone: BlockingTone }): JSX.Element {
  const register = useContext(InlineTargets);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) return register({ node, tone });
  }, [register, tone]);
  return <div className="rf-inline-notice-slot" ref={ref} />;
}

function useInlineTargets(): { target: HTMLDivElement | undefined; register: Register } {
  const [targets, setTargets] = useState<InlineTarget[]>([]);
  const register = useCallback<Register>((target) => {
    setTargets((current) => [...current, target]);
    return (): void => setTargets((current) => current.filter((item) => item !== target));
  }, []);
  return { target: (targets.find((item) => item.tone === "danger") ?? targets[0])?.node, register };
}

export function NotificationProvider({ children }: { children: ReactNode }): JSX.Element {
  const route = usePathname();
  const [item, setItem] = useState<NoticeItem | null>(null);
  const sequence = useRef(0);
  const { target, register } = useInlineTargets();
  const notify = useCallback<Notify>(
    (notice) => {
      const id = ++sequence.current;
      setItem((current) =>
        current?.route === route &&
        current.tone === notice.tone &&
        current.title === notice.title &&
        current.detail === notice.detail
          ? current
          : { ...notice, id, route },
      );
    },
    [route],
  );
  const dismiss = useCallback((id: number) => {
    setItem((current) => (current?.id === id ? null : current));
  }, []);
  useEffect(() => {
    setItem((current) => (current?.route === route ? current : null));
  }, [route]);
  return (
    <Notifications.Provider value={notify}>
      <InlineTargets.Provider value={register}>{children}</InlineTargets.Provider>
      {item?.route === route && (
        <Feedback key={item.id} item={item} dismiss={dismiss} target={target} />
      )}
    </Notifications.Provider>
  );
}

function Feedback({
  item,
  dismiss,
  target,
}: {
  item: NoticeItem;
  dismiss: (id: number) => void;
  target: HTMLDivElement | undefined;
}): JSX.Element {
  const card = <NotificationCard item={item} dismiss={dismiss} inline={Boolean(target)} />;
  if (target) return createPortal(card, target);
  return (
    <aside className="rf-notifications" aria-label="Notifications">
      {card}
    </aside>
  );
}

function NotificationCard({
  item,
  dismiss,
  inline,
}: {
  item: NoticeItem;
  dismiss: (id: number) => void;
  inline: boolean;
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
      className={`rf-notification rf-notification--${tone}${inline ? " rf-notification--inline" : ""}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Icon name={noticeIcon[tone]} />
      <div role={tone === "danger" && !inline ? "alert" : "status"} aria-atomic="true">
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

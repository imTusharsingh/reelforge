"use client";
import Link from "next/link";
import { useEffect, type ComponentProps, type JSX } from "react";
import { usePathname } from "next/navigation";
import {
  installNavigationGuard,
  navigationCompleted,
  requestNavigationIntent,
} from "./studio-navigation";
export function StudioLink(props: ComponentProps<typeof Link>): JSX.Element {
  return (
    <Link
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !requestNavigationIntent(
            "route",
            typeof props.href === "string" ? props.href : String(props.href.pathname ?? "/"),
          )
        )
          event.preventDefault();
      }}
    />
  );
}
export function StudioNavigationGuard(): null {
  const pathname = usePathname();
  useEffect(() => installNavigationGuard(window), []);
  useEffect(() => {
    navigationCompleted();
  }, [pathname]);
  return null;
}

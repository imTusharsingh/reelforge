/** Browser harness substitute for Next's router only. Application uses the real Next components. */
import type { AnchorHTMLAttributes, JSX } from "react";
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  return <a {...props} />;
}
export function usePathname(): string {
  return location.pathname;
}

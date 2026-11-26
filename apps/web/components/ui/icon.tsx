import type { JSX } from "react";

const paths = {
  check: "m5 12 4 4L19 6",
  info: "M12 11v5m0-8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  warning:
    "M12 9v4m0 4h.01M10.3 4.2 2.8 18a1.6 1.6 0 0 0 1.4 2.4h15.6a1.6 1.6 0 0 0 1.4-2.4L13.7 4.2a2 2 0 0 0-3.4 0z",
  close: "M6 6l12 12M18 6 6 18",
  studio: "M4 4h16v16H4zM4 9h16M9 9v11",
  review: "M7 11l3 3 7-7M20 11v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12H3V7a2 2 0 0 1 2-2zM7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2",
  discovery: "M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z",
  settings: "M4 7h7m4 0h5M4 12h3m4 0h9M4 17h10m4 0h2M11 5v4m-4 1v4m7 1v4",
  menu: "M4 6h16M4 12h16M4 18h16",
  film: "M4 5h16v14H4zM8 5v14m8-14v14M4 10h4m-4 4h4m8-4h4m-4 4h4",
  play: "m9 5 11 7-11 7z",
  plus: "M12 5v14M5 12h14",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="rf-icon">
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

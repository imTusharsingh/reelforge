import type { IconName } from "./ui/icon";

type Destination = { name: string; href: string; icon: IconName };
export function studioDestinations(): Destination[] {
  return [
    { name: "Studio", href: "/", icon: "studio" },
    { name: "Review queue", href: "/approvals", icon: "review" },
    { name: "Schedule", href: "/publishing", icon: "calendar" },
    { name: "Discovery", href: "/ideas", icon: "discovery" },
    { name: "Settings", href: "/settings", icon: "settings" },
  ];
}

type Destination = { name: string; href: string; icon: string };
export function studioDestinations(): Destination[] {
  return [
    { name: "Studio", href: "/", icon: "▦" },
    { name: "Review queue", href: "/approvals", icon: "✓" },
    { name: "Schedule", href: "/publishing", icon: "▤" },
    { name: "Discovery", href: "/ideas", icon: "◇" },
    { name: "Settings", href: "/settings", icon: "⚙" },
  ];
}

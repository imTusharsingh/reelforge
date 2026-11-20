type Destination = { name: string; href: string };
export function studioDestinations(): Destination[] {
  return [
    { name: "Overview", href: "/" },
    { name: "Channels", href: "/channels" },
    { name: "Run timeline", href: "/runs" },
    { name: "Approval inbox", href: "/approvals" },
    { name: "Usage", href: "/usage" },
    { name: "Publishing", href: "/publishing" },
    { name: "Insights", href: "/insights" },
    { name: "Account", href: "/account" },
  ];
}

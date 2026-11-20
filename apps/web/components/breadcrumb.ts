type Route = { prefix?: string; exact?: string; label: string };

export const breadcrumbRoutes: readonly Route[] = [
  { prefix: "/publishing", label: "Publishing" },
  { prefix: "/runs", label: "Run timeline" },
  { prefix: "/approvals", label: "Approval inbox" },
  { prefix: "/usage", label: "Usage" },
  { prefix: "/channels", label: "Channels" },
  { prefix: "/insights", label: "Insights" },
  { prefix: "/account", label: "Account" },
];

export function getBreadcrumb(pathname: string): string {
  const route = breadcrumbRoutes.find(
    (candidate) =>
      (candidate.exact !== undefined && pathname === candidate.exact) ||
      (candidate.prefix !== undefined && pathname.startsWith(candidate.prefix)),
  );
  return route ? `Studio / ${route.label}` : "Studio / Overview";
}

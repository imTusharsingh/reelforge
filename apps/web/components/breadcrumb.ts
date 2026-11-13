type Route = { prefix?: string; exact?: string; label: string };

export const breadcrumbRoutes: readonly Route[] = [
  { prefix: "/publishing", label: "Publishing" },
  { prefix: "/review", label: "Review" },
  { prefix: "/production", label: "Production" },
  { prefix: "/planning", label: "Planning" },
  { prefix: "/channels", label: "Channels" },
  { prefix: "/insights", label: "Insights" },
  { exact: "/operations", label: "Operations" },
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

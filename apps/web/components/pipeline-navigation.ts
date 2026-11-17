type Destination = { name: string; href: string };
/** V8 switches only UI chrome; the V3 API/worker retain their existing server deployment flag. */
export function studioDestinations(
  v2 = process.env.NEXT_PUBLIC_PIPELINE_V2 !== "false",
): Destination[] {
  return [
    { name: "Overview", href: "/" },
    { name: "Channels", href: "/channels" },
    { name: "Ideas", href: "/planning" },
    { name: "Operations", href: "/operations" },
    ...(v2
      ? [
          { name: "Run timeline", href: "/runs" },
          { name: "Approval inbox", href: "/approvals" },
          { name: "Usage", href: "/usage" },
        ]
      : [
          { name: "Production", href: "/production" },
          { name: "Review queue", href: "/review" },
        ]),
    { name: "Publishing", href: "/publishing" },
    { name: "Insights", href: "/insights" },
    { name: "Account", href: "/account" },
  ];
}

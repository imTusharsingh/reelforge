import { expect, it } from "vitest";
import { studioDestinations } from "./pipeline-navigation";

it("links to the VideoRun timeline, approval inbox and usage", () => {
  const paths = studioDestinations().map(({ href }) => href);
  for (const path of ["/runs", "/approvals", "/usage"]) expect(paths).toContain(path);
  for (const path of ["/planning", "/production", "/review"]) expect(paths).not.toContain(path);
});

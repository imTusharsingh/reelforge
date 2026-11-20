import { expect, it } from "vitest";
import { studioDestinations } from "./pipeline-navigation";

it("links to the five creator studio destinations", () => {
  expect(studioDestinations().map(({ href }) => href)).toEqual([
    "/",
    "/approvals",
    "/publishing",
    "/ideas",
    "/settings",
  ]);
});

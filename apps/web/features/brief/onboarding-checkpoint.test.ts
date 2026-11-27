// @vitest-environment jsdom
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { Onboarding } from "./onboarding";
import { workspaceId } from "./setup.fixture";
import {
  change,
  container,
  render,
  stub,
  submit,
  submitOnboardingConfirm,
} from "./screens-harness.fixture";
it("never sends a paid retry when create-only uncovers a saved queue attempt", async () => {
  const workspace = { id: workspaceId, name: "Science", role: "OWNER" as const };
  stub.failRun = true;
  await render(createElement(Onboarding, { workspace }));
  await submitOnboardingConfirm();
  expect(stub.calls.filter(({ path }) => path.endsWith("/runs"))).toHaveLength(1);
  await render(null);
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
    throw new Error("Temporary storage read failure");
  });
  try {
    await render(createElement(Onboarding, { workspace }));
    const create = container.querySelector<HTMLButtonElement>('button[type="submit"]:not([value])');
    expect(create).not.toBeNull();
    await act(async () => create!.click());
    expect(container.textContent).toContain("An earlier first Short submission is saved");
    expect(stub.calls.filter(({ path }) => path.endsWith("/runs"))).toHaveLength(1);
    expect(container.querySelector('button[value="queue"]')?.textContent).toBe("Retry first Short");
    stub.failRun = false;
    await submit();
    const attempts = stub.calls.filter(({ path }) => path.endsWith("/runs"));
    expect(attempts).toHaveLength(2);
  } finally {
    read.mockRestore();
  }
});
it("restores create-only success from the saved Brief even if no final checkpoint exists", async () => {
  const workspace = { id: workspaceId, name: "Science", role: "OWNER" as const };
  await render(createElement(Onboarding, { workspace }));
  await change("#setup-niche", "Science");
  await change("#setup-audience", "Adults");
  await submit();
  await submit();
  const original = Storage.prototype.setItem;
  let briefWrites = 0;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    const saved = JSON.parse(value) as Record<string, unknown>;
    if (key.startsWith("rf:onboarding:") && saved.brief) {
      if (++briefWrites > 1) throw new Error("Final checkpoint write failed");
      // Also simulate old tabs which saved the Brief immediately before the completion flag.
      delete saved.completed;
      return original.call(this, key, JSON.stringify(saved));
    }
    return original.call(this, key, value);
  });
  try {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[type="submit"]:not([value])')!.click(),
    );
    expect(container.textContent).toContain("channel and Brief are saved");
    expect(briefWrites).toBe(1);
    await render(null);
    await render(createElement(Onboarding, { workspace }));
    expect(container.textContent).toContain("channel and Brief are saved");
    expect(stub.calls.filter(({ path }) => path.endsWith("/runs"))).toHaveLength(0);
  } finally {
    write.mockRestore();
  }
});

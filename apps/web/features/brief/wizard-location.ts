import { useEffect, useRef, useState } from "react";
import {
  OnboardingInputSchema,
  type OnboardingInput,
  type BriefInput,
} from "../../../../packages/contracts/src/channel-brief";
import { BudgetPolicySchema } from "../../../../packages/contracts/src/foundations";

const steps = ["audience", "voice", "confirm"];
type Budget = BriefInput["budgetPolicy"];
export function useWizardLocation(
  scope: string | undefined,
  input: OnboardingInput,
  setInput: (value: OnboardingInput) => void,
  budget: Budget,
  setBudget: (value: Budget) => void,
): { step: number; setStep: (step: number) => void } {
  const restored = useRef(false);
  const [step, update] = useState(0);
  useEffect(() => {
    const original = document.title;
    const read = (): void => {
      if (!history.state?.briefWizardId)
        history.replaceState({ ...history.state, briefWizardId: crypto.randomUUID() }, "");
      const state = history.state?.briefWizard;
      const saved = OnboardingInputSchema.safeParse(state?.input);
      const policy = BudgetPolicySchema.safeParse(state?.budget);
      const requested = steps.indexOf(new URL(location.href).searchParams.get("step") ?? "");
      const matches = state?.scope === (scope ?? "new");
      if (matches && saved.success) setInput(saved.data);
      if (matches && policy.success) setBudget(policy.data);
      const current = matches && saved.success ? Math.max(0, requested) : 0;
      restored.current = false;
      update(current);
      if (current !== requested) {
        const url = new URL(location.href);
        url.searchParams.set("step", steps[current]!);
        history.replaceState(history.state, "", url);
      }
    };
    read();
    window.addEventListener("popstate", read);
    return (): void => {
      window.removeEventListener("popstate", read);
      document.title = original;
    };
  }, [scope]);
  useEffect(() => {
    document.title = `${["Audience", "Voice and cadence", "Confirm"][step]} · Channel setup · ReelForge`;
  }, [step]);
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      return;
    }
    history.replaceState(
      { ...history.state, briefWizard: { scope: scope ?? "new", input, budget } },
      "",
    );
  }, [scope, input, budget]);
  const setStep = (next: number): void => {
    const state = { ...history.state, briefWizard: { scope: scope ?? "new", input, budget } };
    history.replaceState(state, "");
    const url = new URL(location.href);
    url.searchParams.set("step", steps[next]!);
    history.pushState(state, "", url);
    update(next);
  };
  return { step, setStep };
}

import type { WorkflowDefinition, WorkflowStepKey } from "./orchestration.types.js";

export type WorkflowStepDefinition = Readonly<{
  key: WorkflowStepKey;
  sequence: number;
  sideEffect: boolean;
  maxAttempts: number;
  provider: string;
  /** How often an external wait is re-checked (clamped to the 15-60 s policy). */
  pollMs?: number;
  /** Deadline for an external wait before it needs reconciliation. */
  externalTimeoutMs?: number;
}>;

const definitions: Readonly<Record<WorkflowDefinition, readonly WorkflowStepDefinition[]>> = {
  GENERATION: [
    { key: "VERIFY_CONTEXT", sequence: 1, sideEffect: false, maxAttempts: 3, provider: "internal" },
    { key: "SELECT_IDEA", sequence: 2, sideEffect: false, maxAttempts: 3, provider: "idea" },
    {
      key: "GENERATE_SCRIPT",
      sequence: 3,
      sideEffect: true,
      maxAttempts: 3,
      provider: "llm",
      // Waits (polling, no attempts) for the M07 human script approval.
      pollMs: 60_000,
      externalTimeoutMs: 72 * 60 * 60 * 1000,
    },
    {
      key: "GENERATE_SCENE_MEDIA",
      sequence: 4,
      sideEffect: true,
      maxAttempts: 3,
      provider: "media",
      pollMs: 30_000,
      externalTimeoutMs: 2 * 60 * 60 * 1000,
    },
    {
      key: "COMPOSE_RENDER",
      sequence: 5,
      sideEffect: true,
      maxAttempts: 3,
      provider: "render",
      pollMs: 30_000,
      externalTimeoutMs: 2 * 60 * 60 * 1000,
    },
    { key: "QUALITY_REVIEW", sequence: 6, sideEffect: true, maxAttempts: 2, provider: "quality" },
  ],
  PUBLISH: [
    { key: "VERIFY_CONTEXT", sequence: 1, sideEffect: false, maxAttempts: 3, provider: "internal" },
    {
      key: "PUBLISH",
      sequence: 2,
      sideEffect: true,
      maxAttempts: 3,
      provider: "publishing",
      pollMs: 60_000,
      externalTimeoutMs: 24 * 60 * 60 * 1000,
    },
    {
      key: "ANALYTICS_FOLLOW_UP",
      sequence: 3,
      sideEffect: true,
      maxAttempts: 3,
      provider: "analytics",
    },
  ],
  ANALYTICS: [
    { key: "VERIFY_CONTEXT", sequence: 1, sideEffect: false, maxAttempts: 3, provider: "internal" },
    {
      key: "ANALYTICS_FOLLOW_UP",
      sequence: 2,
      sideEffect: true,
      maxAttempts: 3,
      provider: "analytics",
    },
  ],
};

export function workflowDefinition(key: WorkflowDefinition): readonly WorkflowStepDefinition[] {
  return definitions[key];
}

export function firstStep(key: WorkflowDefinition): WorkflowStepDefinition {
  const step = definitions[key][0];
  if (!step) throw new Error(`Workflow definition ${key} has no steps`);
  return step;
}

export function stepDefinition(
  key: WorkflowDefinition,
  stepKey: WorkflowStepKey,
): WorkflowStepDefinition | undefined {
  return definitions[key].find((step) => step.key === stepKey);
}

export function nextStep(
  key: WorkflowDefinition,
  currentStepKey: string,
): WorkflowStepDefinition | undefined {
  const current = definitions[key].find((step) => step.key === currentStepKey);
  if (!current) return undefined;
  return definitions[key].find((step) => step.sequence === current.sequence + 1);
}

export function stepIdempotencyKey(
  definitionKey: WorkflowDefinition,
  runId: string,
  stepKey: WorkflowStepKey,
): string {
  return `${definitionKey}:${runId}:${stepKey}`;
}

import { validatePlanningShots } from "./planning-validation.js";
import { screenPlanningContent as screen, validatePlanningAccess } from "./planning-guardrails.js";
import { Inject, Injectable } from "@nestjs/common";
import {
  PlanningRequestSchema,
  PlanningScriptSchema,
  PlanningShotsSchema,
  validatePlanningScript,
  type PlanningRequest,
  type PlanningScript,
  type ShotSpec,
  type PlanningPromptReceipt,
} from "@reelforge/contracts";
import { PLANNING_TEXT, type TextPort } from "../reference-library/planning.ports.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { planningModels } from "../config/planning-prompts.js";
import type { WorkspaceContext } from "../identity/identity.types.js";

export interface Scriptwriter {
  write(
    context: WorkspaceContext,
    request: PlanningRequest,
  ): Promise<{ script: PlanningScript; prompt: PlanningPromptReceipt }>;
}
export interface Director {
  direct(
    context: WorkspaceContext,
    request: PlanningRequest,
    script: PlanningScript,
  ): Promise<{ shots: ShotSpec[]; prompt: PlanningPromptReceipt }>;
}
@Injectable()
export class ScriptwriterService implements Scriptwriter {
  public constructor(
    @Inject(PLANNING_TEXT) private readonly text: TextPort,
    private readonly prompts: PlanningPromptService,
  ) {}
  public async write(
    context: WorkspaceContext,
    value: PlanningRequest,
  ): Promise<{ script: PlanningScript; prompt: PlanningPromptReceipt }> {
    const request = PlanningRequestSchema.parse(value);
    validatePlanningAccess(context, request);

    const prompt = await this.prompts.capture(context, request.brief.channelId, "scriptwriter");
    let usedPrompt = prompt.receipt;
    const formatTemplate = await this.prompts.format(context, request.format);
    const validate = (value: unknown): PlanningScript => {
      const script = validatePlanningScript(value, request);
      screen(request, JSON.stringify(script));
      return script;
    };
    const output = await this.text.generate({
      workspaceId: context.workspaceId,
      runId: request.runId,
      idempotencyKey: `${request.runId}:scriptwriter`,
      modelId: planningModels.text,
      schema: PlanningScriptSchema,
      validateOutput: validate,
      promptVersion: prompt.receipt,
      onPromptUsed: (receipt) => {
        usedPrompt = receipt;
      },
      prompt: `${prompt.prompt}\n${JSON.stringify({ request, formatTemplate })}`,
    });
    return { script: validate(output), prompt: usedPrompt };
  }
}
@Injectable()
export class DirectorService implements Director {
  public constructor(
    @Inject(PLANNING_TEXT) private readonly text: TextPort,
    private readonly prompts: PlanningPromptService,
  ) {}
  public async direct(
    context: WorkspaceContext,
    value: PlanningRequest,
    valueScript: PlanningScript,
  ): Promise<{ shots: ShotSpec[]; prompt: PlanningPromptReceipt }> {
    const request = PlanningRequestSchema.parse(value);
    validatePlanningAccess(context, request);
    const script = validatePlanningScript(valueScript, request);
    screen(request, JSON.stringify(script));
    const prompt = await this.prompts.capture(context, request.brief.channelId, "director");
    let usedPrompt = prompt.receipt;
    const shots = PlanningShotsSchema.parse(
      await this.text.generate({
        workspaceId: context.workspaceId,
        runId: request.runId,
        idempotencyKey: `${request.runId}:director`,
        modelId: planningModels.text,
        schema: PlanningShotsSchema,
        validateOutput: (value): void => {
          validatePlanningShots(value, request, script);
        },
        promptVersion: prompt.receipt,
        onPromptUsed: (receipt) => {
          usedPrompt = receipt;
        },
        prompt: `${prompt.prompt}\n${JSON.stringify({ request, script })}`,
      }),
    );
    validatePlanningShots(shots, request, script);
    return { shots, prompt: usedPrompt };
  }
}

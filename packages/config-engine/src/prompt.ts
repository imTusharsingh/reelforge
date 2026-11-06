import { z } from "zod";
import {
  CreativeConfigSchema,
  PROTECTED_PROMPT_SECTIONS,
  type CreativeConfig,
  type ProtectedPromptSection,
  type PromptTemplateReference,
} from "./config.schema.js";
import { canonicalJson, jsonFingerprint, type JsonValue } from "./json.js";

export const PROMPT_BUNDLE_FORMAT_VERSION = "m05.1" as const;

export const PROMPT_SECTION_KEYS = [
  "system",
  "safety",
  "rights",
  "context",
  "instructions",
  "examples",
  "style",
  "output",
] as const;

export const EDITABLE_PROMPT_SECTIONS = [
  "context",
  "instructions",
  "examples",
  "style",
  "output",
] as const;

export type PromptSectionKey = (typeof PROMPT_SECTION_KEYS)[number];
export type EditablePromptSection = (typeof EDITABLE_PROMPT_SECTIONS)[number];

export const PromptSectionKeySchema = z.enum(PROMPT_SECTION_KEYS);
export const EditablePromptSectionSchema = z.enum(EDITABLE_PROMPT_SECTIONS);
export const PromptVariableNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "must be a lowercase snake_case variable name");

export const PromptVariableSchema = z
  .object({
    name: PromptVariableNameSchema,
    required: z.boolean().default(true),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

const PromptTextSchema = z.string().trim().min(1).max(20000);

export const PromptTemplateSectionsSchema = z
  .object({
    instructions: PromptTextSchema,
    context: PromptTextSchema.optional(),
    examples: PromptTextSchema.optional(),
    style: PromptTextSchema.optional(),
    output: PromptTextSchema.optional(),
  })
  .strict();

export const PromptTemplateVersionBodySchema = z
  .object({
    sections: PromptTemplateSectionsSchema,
    variables: z.array(PromptVariableSchema).max(100).default([]),
    allowedAdditionSections: z
      .array(EditablePromptSectionSchema)
      .min(1)
      .max(EDITABLE_PROMPT_SECTIONS.length)
      .default(["instructions"]),
  })
  .strict()
  .superRefine((body, context) => {
    const names = new Set<string>();
    for (const [index, variable] of body.variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          message: `variable "${variable.name}" is declared more than once`,
          path: ["variables", index, "name"],
        });
      }
      names.add(variable.name);
    }
    const sections = new Set<string>();
    for (const [index, section] of body.allowedAdditionSections.entries()) {
      if (sections.has(section)) {
        context.addIssue({
          code: "custom",
          message: `addition section "${section}" is listed more than once`,
          path: ["allowedAdditionSections", index],
        });
      }
      sections.add(section);
    }
  });

export const PromptAdditionInputSchema = z
  .object({
    section: EditablePromptSectionSchema,
    text: PromptTextSchema,
  })
  .strict();

export const PromptAdditionSchema = PromptAdditionInputSchema.extend({
  addedByUserId: z.uuid().optional(),
}).strict();

export type PromptVariable = z.infer<typeof PromptVariableSchema>;
export type PromptTemplateVersionBody = z.infer<typeof PromptTemplateVersionBodySchema>;
export type PromptAdditionInput = z.infer<typeof PromptAdditionInputSchema>;
export type PromptAddition = z.infer<typeof PromptAdditionSchema>;

export type PromptTemplateSelection = Readonly<{
  templateId: string;
  templateKey: string;
  templateName: string;
  versionId: string;
  version: number;
  checksumSha256: string;
  body: PromptTemplateVersionBody;
}>;

export type CompiledPromptBundle = Readonly<{
  formatVersion: typeof PROMPT_BUNDLE_FORMAT_VERSION;
  configSha256: string;
  template: Readonly<{
    templateId: string;
    templateKey: string;
    templateName: string;
    versionId: string;
    version: number;
    checksumSha256: string;
  }>;
  sections: Readonly<Record<PromptSectionKey, string>>;
  variables: Readonly<Record<string, string>>;
  additions: readonly PromptAddition[];
  renderedText: string;
  protectedSections: readonly ProtectedPromptSection[];
  fingerprintSha256: string;
}>;

export type PromptCompilationErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_TEMPLATE"
  | "INVALID_VARIABLES"
  | "INVALID_ADDITION"
  | "PROTECTED_SECTION"
  | "NON_APPENDABLE_SECTION"
  | "UNDECLARED_VARIABLE"
  | "MISSING_VARIABLE"
  | "UNKNOWN_VARIABLE";

export class PromptCompilationError extends Error {
  public readonly code: PromptCompilationErrorCode;
  public readonly details: readonly string[];

  public constructor(
    code: PromptCompilationErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "PromptCompilationError";
    this.code = code;
    this.details = details;
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

function zodDetails(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map((part) => String(part)).join(".") || "<root>"}: ${issue.message}`,
  );
}

export function parsePromptTemplateBody(value: unknown): PromptTemplateVersionBody {
  const parsed = PromptTemplateVersionBodySchema.safeParse(value);
  if (!parsed.success)
    throw new PromptCompilationError(
      "INVALID_TEMPLATE",
      "Prompt template version body is invalid",
      zodDetails(parsed.error),
    );
  return parsed.data;
}

export function parsePromptAdditions(value: unknown): PromptAdditionInput[] {
  if (value === undefined) return [];
  const parsed = z.array(PromptAdditionInputSchema).max(50).safeParse(value);
  if (!parsed.success)
    throw new PromptCompilationError(
      "INVALID_ADDITION",
      "Prompt user additions are invalid",
      zodDetails(parsed.error),
    );
  return parsed.data;
}

function renderText(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => variables[name] ?? "");
}

function placeholdersIn(text: string): string[] {
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, "g");
  const names: string[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    match = pattern.exec(text);
  }
  return names;
}

/**
 * Variables derived only from the resolved configuration. Templates declare which
 * of these they use; the values are platform/config data, never provider data.
 */
export function defaultPromptVariables(config: CreativeConfig): Record<string, string> {
  return {
    language: config.identity.language,
    audience: config.identity.audience,
    tone: config.identity.tone,
    niche: config.identity.niche,
    format: config.identity.format,
    frequency: config.identity.frequency,
    duration_min_seconds: String(config.duration.minSeconds),
    duration_max_seconds: String(config.duration.maxSeconds),
    safety_level: config.safetyProfile.level,
    aspect_ratio: config.video.aspectRatio,
    video_width: String(config.video.width),
    video_height: String(config.video.height),
    frame_rate: String(config.video.frameRate),
    topics_allowed: config.topics.allowed.join(", "),
    topics_blocked: config.topics.blocked.join(", "),
    characters: config.characters
      .map((character) => `${character.name} (v${character.version})`)
      .join(", "),
    structure: canonicalJson(config.structure as unknown as JsonValue),
  };
}

/** Protected prompt text always comes from platform policy, never from a workspace template. */
export function buildProtectedPromptSections(
  config: CreativeConfig,
): Record<ProtectedPromptSection, string> {
  return {
    system:
      `Platform system policy (${config.platformPolicy.defaultsVersion}, ` +
      `bundle format ${config.systemPolicy.bundleFormatVersion}). Follow platform constraints. ` +
      `Never bypass safety, rights, or system requirements.`,
    safety:
      `Safety policy: minimum level ${config.safetyPolicy.minimumLevel}; ` +
      `human review required: ${config.safetyPolicy.requiresHumanReview ? "yes" : "no"}; ` +
      `blocked topics: ${config.safetyPolicy.blockedTopics.join(", ")}.`,
    rights:
      `Rights policy: documented rights required: ${config.rightsPolicy.requireDocumentedRights ? "yes" : "no"}; ` +
      `unlicensed music allowed: ${config.rightsPolicy.allowUnlicensedMusic ? "yes" : "no"}; ` +
      `allowed license types: ${config.rightsPolicy.allowedLicenseTypes.join(", ")}.`,
  };
}

export type CompilePromptInput = Readonly<{
  config: CreativeConfig;
  configSha256?: string;
  template: PromptTemplateSelection;
  variables?: Readonly<Record<string, string>>;
  additions?: readonly PromptAddition[];
}>;

/**
 * Pure prompt compilation. It performs no I/O, provider call, or persistence.
 * The same configuration, template version, variables, and additions always
 * produce the same sections and fingerprint.
 */
export function compilePrompt(input: CompilePromptInput): CompiledPromptBundle {
  const configResult = CreativeConfigSchema.safeParse(input.config);
  if (!configResult.success)
    throw new PromptCompilationError(
      "INVALID_CONFIG",
      "Resolved configuration is invalid for prompt compilation",
      zodDetails(configResult.error),
    );
  const config = configResult.data;
  const body = parsePromptTemplateBody(input.template.body);

  if (!/^[0-9a-f]{64}$/.test(input.template.checksumSha256))
    throw new PromptCompilationError(
      "INVALID_TEMPLATE",
      "Prompt template version checksum must be a lowercase SHA-256 hex digest",
    );
  if (!Number.isInteger(input.template.version) || input.template.version < 1)
    throw new PromptCompilationError(
      "INVALID_TEMPLATE",
      "Prompt template version must be positive",
    );

  const supplied = z
    .record(PromptVariableNameSchema, z.string().max(20000))
    .safeParse(input.variables ?? {});
  if (!supplied.success)
    throw new PromptCompilationError(
      "INVALID_VARIABLES",
      "Prompt variables are invalid",
      zodDetails(supplied.error),
    );

  const declared = new Map(body.variables.map((variable) => [variable.name, variable]));
  const derived = defaultPromptVariables(config);
  const values: Record<string, string> = {};
  for (const [name, variable] of declared) {
    const explicit = supplied.data[name];
    const fallback = derived[name];
    if (explicit !== undefined) values[name] = explicit;
    else if (fallback !== undefined) values[name] = fallback;
    else if (variable.required)
      throw new PromptCompilationError(
        "MISSING_VARIABLE",
        `Required prompt variable "${name}" was not supplied and has no configuration default`,
      );
    else values[name] = "";
  }

  for (const name of Object.keys(supplied.data)) {
    if (!declared.has(name))
      throw new PromptCompilationError(
        "UNKNOWN_VARIABLE",
        `Prompt variable "${name}" is not declared by the selected template version`,
      );
  }

  const allTemplateText = [
    body.sections.instructions,
    body.sections.context,
    body.sections.examples,
    body.sections.style,
    body.sections.output,
  ]
    .filter((text): text is string => text !== undefined)
    .join("\n");

  for (const name of placeholdersIn(allTemplateText)) {
    if (!declared.has(name))
      throw new PromptCompilationError(
        "UNDECLARED_VARIABLE",
        `Template placeholder "{{${name}}}" is not declared in variables`,
      );
  }

  const additions: PromptAddition[] = [];
  for (const raw of input.additions ?? []) {
    const rawSection = (raw as { section?: unknown }).section;
    if (
      typeof rawSection === "string" &&
      (PROTECTED_PROMPT_SECTIONS as readonly string[]).includes(rawSection)
    )
      throw new PromptCompilationError(
        "PROTECTED_SECTION",
        `User additions cannot target protected section "${rawSection}"`,
      );
    const parsed = PromptAdditionSchema.safeParse(raw);
    if (!parsed.success)
      throw new PromptCompilationError(
        "INVALID_ADDITION",
        "Prompt user addition is invalid",
        zodDetails(parsed.error),
      );
    if (!body.allowedAdditionSections.includes(parsed.data.section))
      throw new PromptCompilationError(
        "NON_APPENDABLE_SECTION",
        `Template version does not allow user additions in section "${parsed.data.section}"`,
      );
    additions.push(parsed.data);
  }

  const orderedAdditions = [...additions].sort(
    (left, right) =>
      EDITABLE_PROMPT_SECTIONS.indexOf(left.section) -
      EDITABLE_PROMPT_SECTIONS.indexOf(right.section),
  );

  const editableSections: Partial<Record<EditablePromptSection, string>> = {};
  for (const section of EDITABLE_PROMPT_SECTIONS) {
    const source = body.sections[section];
    if (source === undefined) continue;
    const rendered = renderText(source, values);
    const appended = orderedAdditions
      .filter((addition) => addition.section === section)
      .map((addition) => addition.text.trim());
    editableSections[section] = [rendered, ...appended]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  const protectedSections = buildProtectedPromptSections(config);
  const sections: Record<PromptSectionKey, string> = {
    system: protectedSections.system,
    safety: protectedSections.safety,
    rights: protectedSections.rights,
    context: editableSections.context ?? "",
    instructions: editableSections.instructions ?? "",
    examples: editableSections.examples ?? "",
    style: editableSections.style ?? "",
    output: editableSections.output ?? "",
  };

  const renderedText = PROMPT_SECTION_KEYS.filter((section) => sections[section].length > 0)
    .map((section) => `[${section}]\n${sections[section]}`)
    .join("\n\n");

  const configSha256 = input.configSha256 ?? jsonFingerprint(config as unknown as JsonValue);

  const fingerprintSha256 = jsonFingerprint({
    formatVersion: PROMPT_BUNDLE_FORMAT_VERSION,
    configSha256,
    template: {
      templateId: input.template.templateId,
      templateKey: input.template.templateKey,
      versionId: input.template.versionId,
      version: input.template.version,
      checksumSha256: input.template.checksumSha256,
    },
    variables: values,
    additions: orderedAdditions.map((addition) => ({
      section: addition.section,
      text: addition.text.trim(),
    })),
    sections,
  });

  return {
    formatVersion: PROMPT_BUNDLE_FORMAT_VERSION,
    configSha256,
    template: {
      templateId: input.template.templateId,
      templateKey: input.template.templateKey,
      templateName: input.template.templateName,
      versionId: input.template.versionId,
      version: input.template.version,
      checksumSha256: input.template.checksumSha256,
    },
    sections,
    variables: values,
    additions: orderedAdditions,
    renderedText,
    protectedSections: [...PROTECTED_PROMPT_SECTIONS],
    fingerprintSha256,
  };
}

export type PromptTemplateReferenceTarget = Readonly<{
  templateId?: string;
  templateKey?: string;
  version?: number;
}>;

/** Converts a stored prompt reference to a lookup target without mutating it. */
export function promptTemplateReferenceTarget(
  reference: PromptTemplateReference,
): PromptTemplateReferenceTarget {
  if (typeof reference === "string") {
    if (z.uuid().safeParse(reference).success) return { templateId: reference };
    return { templateKey: reference };
  }
  return {
    ...(reference.templateId === undefined ? {} : { templateId: reference.templateId }),
    ...(reference.templateKey === undefined ? {} : { templateKey: reference.templateKey }),
    ...(reference.version === undefined ? {} : { version: reference.version }),
  };
}

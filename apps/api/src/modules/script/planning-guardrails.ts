import { NarratorPaceSchema, type PlanningRequest } from "@reelforge/contracts";
/** Local preflight runs before dispatch; all generated prompts are screened again before images. */
export function screenPlanningContent(request: PlanningRequest, content: string): void {
  const normalized = content.normalize("NFKC").toLocaleLowerCase("en");
  const banned = [
    ...request.brief.guardrails.bannedTopics,
    ...request.brief.guardrails.topicsToAvoid,
    ...request.brief.styleBible.bannedVisuals,
  ];
  if (banned.some((topic) => normalized.includes(topic.normalize("NFKC").toLocaleLowerCase("en"))))
    throw new Error("Banned topic or visual");
  if (
    /\b(real person|celebrity|brand|elon musk|taylor swift|donald trump|barack obama|narendra modi|nike|apple inc|coca-cola|disney|microsoft|google|adidas|adele|beyoncé|drake|marie curie|albert einstein|steve jobs)\b/iu.test(
      normalized,
    )
  )
    throw new Error("Real people and brands are prohibited");
  if (
    /\b(ai|virtual|robot|persona|avatar)\b.{0,80}\b(doctor|physician|lawyer|health advice|legal advice|financ(?:e|ial) advis[oe]r|political advice)\b/iu.test(
      normalized,
    ) ||
    /\b(financ(?:e|ial) advis[oe]r|doctor|physician|lawyer|political advis[oe]r)\b.{0,80}\b(ai|virtual|robot|persona|avatar)\b/iu.test(
      normalized,
    )
  )
    throw new Error("Persona advice is prohibited");
  if (/\b(lyrics|in the style of|artist voice|sing like)\b/iu.test(normalized))
    throw new Error("Artist and lyric requests are prohibited");
}
export function validatePlanningAccess(
  context: { workspaceId: string; role: string },
  request: PlanningRequest,
): void {
  if (request.brief.workspaceId !== context.workspaceId || context.role === "VIEWER")
    throw new Error("Owned Brief and editor permission required");
  if (!request.brief.narratorVoice) throw new Error("Channel narrator voice required");
  NarratorPaceSchema.parse(request.brief.narratorVoice.pace);
  if (request.brief.languages.script !== request.brief.languages.narration)
    throw new Error("Script and narration must use the same Brief language");
  screenPlanningContent(
    request,
    JSON.stringify({
      idea: request.idea,
      topic: request.brief.topic,
      niche: request.brief.niche,
      audience: request.brief.audience,
      style: {
        visualStyle: request.brief.styleBible.visualStyle,
        palette: request.brief.styleBible.palette,
      },
    }),
  );
}

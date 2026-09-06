import { z } from "zod";
import { defineAgent } from "@/ai/agents/types";
import { runAgent } from "@/ai/orchestrator";
import { getTrip, getTripDigitalTwin } from "@/modules/trip/trip-service";
import { generateRequestId } from "@/shared/api-response";
import { ProviderError, ValidationError } from "@/shared/errors";

/**
 * Unlike the Flight, Weather, and Currency agents, this genuinely
 * belongs in Phase 9's LLM orchestrator: "summarize only retrieved
 * information" is a synthesis task, not a deterministic data
 * transformation. There is no formula for turning five search snippets
 * into a coherent, appropriately-hedged answer.
 */

const researchQuestionSchema = z.object({
  question: z.string().trim().min(1, "A question is required.").max(500),
});

export const researchOutputSchema = z.object({
  answer: z.string().describe("The synthesized answer, with claims attributed to their source."),
  sources: z
    .array(z.object({ url: z.string(), title: z.string() }))
    .describe("Every source actually used to build the answer."),
  hasEvidence: z
    .boolean()
    .describe("False if the search results did not actually address the question."),
  confidence: z.number().min(0).max(1),
});

export type ResearchAgentOutput = z.infer<typeof researchOutputSchema>;

/**
 * The system prompt is the actual enforcement mechanism for "never
 * present search-generated information as verified fact without
 * evidence" and "summarize only retrieved information" -- there's no
 * code-level check that can verify an LLM's answer only used retrieved
 * facts, so the constraint has to be stated as forcefully and
 * unambiguously as possible here, with hasEvidence giving the caller an
 * explicit, checkable signal rather than trusting prose alone.
 */
export const researchAgent = defineAgent({
  name: "research_agent",
  role: `You are a travel research assistant. Answer the traveler's question using ONLY information you retrieve via the search_destination tool.

Rules, no exceptions:
- Call search_destination at least once before answering. Call it again with a refined query if the first results don't address the question.
- Base your answer ONLY on retrieved search results. Never fill gaps with your own general knowledge, even if you're confident it's correct -- the traveler needs to know this answer came from a live source, not from your training data.
- Attribute claims to their source in the answer text (e.g. "According to [source], ..."), not as bare, unattributed fact -- search results can be outdated or wrong.
- If the search results don't clearly answer the question, say so explicitly in the answer and set hasEvidence to false. Do not guess to fill the silence.
- Every entry in sources must be a URL you actually got back from search_destination -- never invent or guess a URL.
- get_trip is available if you need the trip's destination or dates for context, but is not a substitute for search_destination.`,
  allowedTools: ["get_trip", "search_destination"],
  outputSchema: researchOutputSchema,
});

/**
 * Pre-fetches the trip's destinations so the agent has immediate
 * context without necessarily spending a tool call on get_trip just to
 * find out where the trip is going -- get_trip remains available if it
 * wants more detail (dates, traveler count), but this keeps the common
 * case efficient within the orchestrator's tool-call budget.
 */
async function buildContextualQuestion(
  tripId: string,
  userId: string,
  question: string,
): Promise<string> {
  const twin = await getTripDigitalTwin(tripId, userId);
  const destinations = twin.destinations.map((d) => `${d.city}, ${d.country}`).join("; ");
  const context = destinations
    ? `Trip destinations: ${destinations}.`
    : "This trip has no destinations set yet.";
  return `${context}\n\nQuestion: ${question}`;
}

/**
 * User-facing entry point. Checks trip ownership up front (Phase 7)
 * even though search_destination re-verifies it internally on every
 * call (Phase 8) -- without this, an unauthorized request would only
 * surface as a confusing tool-result buried inside the orchestration
 * loop instead of failing cleanly before an LLM call is even made.
 */
export async function runResearchAgentForUser(
  tripId: string,
  userId: string,
  rawQuestion: string,
): Promise<ResearchAgentOutput> {
  await getTrip(tripId, userId);
  const { question } = researchQuestionSchema.parse({ question: rawQuestion });

  const contextualQuestion = await buildContextualQuestion(tripId, userId, question);
  const requestId = generateRequestId();

  const result = await runAgent(researchAgent, contextualQuestion, { userId, requestId });

  if (!result.success) {
    throw new ProviderError(
      "research_agent",
      `The research agent could not complete this request: ${result.reason}.`,
    );
  }

  // Defense in depth beyond the orchestrator's own schema validation:
  // if the model ever claims evidence without actually citing a source,
  // that's an internally inconsistent answer worth rejecting outright
  // rather than passing along to the traveler.
  if (result.data.hasEvidence && result.data.sources.length === 0) {
    throw new ValidationError(
      "The research agent claimed to have evidence but cited no sources -- rejecting rather than passing along an unattributed answer.",
    );
  }

  return result.data;
}

import { z } from "zod";
import type { ToolName } from "@/ai/tools/registry";

/**
 * One agent = one role, one allowed-tools subset, one structured output
 * shape. The 7 specialized agents the brief names (Flight/Weather/
 * Currency/Research/Document/Risk/Planning) are built on this in
 * Phases 10-13, 16-17, and 20 — this phase builds the framework and the
 * orchestration loop that runs any agent defined this way, not the
 * specialized agents' domain logic itself.
 */
export interface AgentDefinition<TOutput> {
  name: string;
  /** Becomes the system prompt. State the role narrowly -- what this agent does and does not do. */
  role: string;
  /**
   * A subset of the Phase 8 tool registry, not the whole thing. An
   * agent whose job is answering weather questions has no business
   * being offered create_alert -- narrowing this per agent is itself a
   * safety property, not just an optimization.
   */
  allowedTools: ToolName[];
  /** The agent's final answer must validate against this, or the run fails rather than returning unvalidated model output. */
  outputSchema: z.ZodType<TOutput>;
}

/**
 * TInput/TOutput default to `any` for the same reason as
 * ai/tools/types.ts's ToolDefinition: function-parameter contravariance
 * would otherwise make a heterogeneous list of agents (with different
 * concrete output types) impossible to type uniformly. Real safety comes
 * from each agent's own outputSchema.parse() at the end of a run, not
 * from this stored type.
 */
/**
 * TInput/TOutput default to `any` for the same reason as
 * ai/tools/types.ts's ToolDefinition: function-parameter contravariance
 * would otherwise make a heterogeneous list of agents (with different
 * concrete output types) impossible to type uniformly. Real safety comes
 * from each agent's own outputSchema.parse() at the end of a run, not
 * from this stored type.
 */
export function defineAgent<TSchema extends z.ZodType>(definition: {
  name: string;
  role: string;
  allowedTools: ToolName[];
  outputSchema: TSchema;
}): AgentDefinition<z.infer<TSchema>> {
  // Same narrow, justified assertion as ai/tools/types.ts's defineTool:
  // `definition`'s shape already structurally satisfies
  // AgentDefinition<z.infer<TSchema>> by construction, but Zod 4's
  // generic structure makes that hard for TS to prove automatically.
  return definition as AgentDefinition<z.infer<TSchema>>;
}

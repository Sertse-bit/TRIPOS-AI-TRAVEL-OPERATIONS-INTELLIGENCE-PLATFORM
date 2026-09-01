import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/config/env";
import { logger } from "@/infrastructure/logger";
import { callTool, getToolDefinition } from "@/ai/tools/registry";
import type { ToolContext } from "@/ai/tools/types";
import type { AgentDefinition } from "@/ai/agents/types";

/**
 * Hard limits, matching what docs/ARCHITECTURE.md Section 10 already
 * specified back in Phase 1 -- honoring that decision as the default
 * rather than inventing new numbers here. Injectable (not hardcoded
 * constants used directly) specifically so tests can exercise the
 * timeout/budget paths in milliseconds instead of waiting out a real
 * 30-second limit -- the production defaults are unchanged either way.
 */
export interface OrchestratorLimits {
  maxToolCalls: number;
  maxWallClockMs: number;
  maxTokenBudget: number;
}

const DEFAULT_LIMITS: OrchestratorLimits = {
  maxToolCalls: 8,
  maxWallClockMs: 30_000,
  maxTokenBudget: 50_000, // input + output tokens, cumulative across the whole run
};
const MODEL = "claude-sonnet-5";
const FINAL_ANSWER_TOOL_NAME = "provide_final_answer";

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  cachedClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cachedClient;
}

export type OrchestratorFailureReason =
  | "MAX_TOOL_CALLS_EXCEEDED"
  | "TIMEOUT"
  | "TOKEN_BUDGET_EXCEEDED"
  | "MODEL_STOPPED_WITHOUT_ANSWER"
  | "API_ERROR";

export type OrchestratorRunResult<T> =
  | { success: true; data: T; toolCallsUsed: number; durationMs: number; tokensUsed: number }
  | {
      success: false;
      reason: OrchestratorFailureReason;
      toolCallsUsed: number;
      durationMs: number;
      tokensUsed: number;
    };

/**
 * Strips the $schema key Zod 4's native toJSONSchema() includes, which
 * Anthropic's tool schema doesn't want, and which would otherwise sit in
 * every single tool definition sent to the model for no reason.
 */
function toAnthropicInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit $schema, which Anthropic's tool schema doesn't want
  const { $schema, ...rest } = jsonSchema;
  return rest as Anthropic.Tool.InputSchema;
}

export async function runAgent<T>(
  agent: AgentDefinition<T>,
  userMessage: string,
  toolContext: ToolContext,
  limitsOverride?: Partial<OrchestratorLimits>,
): Promise<OrchestratorRunResult<T>> {
  const limits: OrchestratorLimits = { ...DEFAULT_LIMITS, ...limitsOverride };
  const startedAt = Date.now();
  let toolCallsUsed = 0;
  let tokensUsed = 0;

  const toolDefs: Anthropic.Tool[] = agent.allowedTools.map((toolName) => {
    const def = getToolDefinition(toolName);
    return {
      name: toolName,
      description: def.description,
      input_schema: toAnthropicInputSchema(def.inputSchema),
    };
  });

  const finalAnswerTool: Anthropic.Tool = {
    name: FINAL_ANSWER_TOOL_NAME,
    description:
      "Call this exactly once, when you have everything needed to answer, to provide your final structured answer. Do not call any other tool after this.",
    input_schema: toAnthropicInputSchema(agent.outputSchema),
  };

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > limits.maxWallClockMs) {
      logger.warn({ agent: agent.name, elapsed }, "Agent run exceeded wall-clock limit");
      return { success: false, reason: "TIMEOUT", toolCallsUsed, durationMs: elapsed, tokensUsed };
    }
    if (tokensUsed > limits.maxTokenBudget) {
      return {
        success: false,
        reason: "TOKEN_BUDGET_EXCEEDED",
        toolCallsUsed,
        durationMs: Date.now() - startedAt,
        tokensUsed,
      };
    }

    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: agent.role,
        messages,
        tools: [...toolDefs, finalAnswerTool],
      });
    } catch (error) {
      logger.error({ agent: agent.name, err: error }, "Anthropic API call failed");
      return {
        success: false,
        reason: "API_ERROR",
        toolCallsUsed,
        durationMs: Date.now() - startedAt,
        tokensUsed,
      };
    }

    tokensUsed += response.usage.input_tokens + response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      // Model stopped talking without calling the final-answer tool --
      // not a crash, but not a usable result either.
      return {
        success: false,
        reason: "MODEL_STOPPED_WITHOUT_ANSWER",
        toolCallsUsed,
        durationMs: Date.now() - startedAt,
        tokensUsed,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.name === FINAL_ANSWER_TOOL_NAME) {
        const parsed = agent.outputSchema.safeParse(block.input);
        if (parsed.success) {
          return {
            success: true,
            data: parsed.data,
            toolCallsUsed,
            durationMs: Date.now() - startedAt,
            tokensUsed,
          };
        }
        // Give the model a chance to correct itself within budget,
        // rather than failing the whole run on one malformed attempt.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Your final answer didn't match the required shape: ${JSON.stringify(parsed.error.issues)}`,
          is_error: true,
        });
        continue;
      }

      toolCallsUsed += 1;
      if (toolCallsUsed > limits.maxToolCalls) {
        return {
          success: false,
          reason: "MAX_TOOL_CALLS_EXCEEDED",
          toolCallsUsed,
          durationMs: Date.now() - startedAt,
          tokensUsed,
        };
      }

      // This is the only place a "tool" is ever executed from within a
      // run -- callTool (Phase 8) can only invoke a registered tool, not
      // another agent, so agent-to-agent recursion is impossible by
      // construction here, not merely disallowed by convention.
      const result = await callTool(block.name, block.input, toolContext);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: !result.success,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

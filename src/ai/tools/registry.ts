import { logger } from "@/infrastructure/logger";
import { isAppError } from "@/shared/errors";
import type { ToolContext, ToolDefinition, ToolResult } from "@/ai/tools/types";
import { getTripTool, getTripDocumentsTool } from "@/ai/tools/trip-tools";
import {
  getCurrencyRateTool,
  getFlightStatusTool,
  getWeatherTool,
  searchDestinationTool,
} from "@/ai/tools/provider-tools";
import { searchTripKnowledgeTool } from "@/ai/tools/knowledge-tools";
import { calculateBudgetTool } from "@/ai/tools/budget-tools";
import { createAlertTool, createRecommendationTool } from "@/ai/tools/action-tools";

/**
 * The fixed, approved set. This map IS the security boundary the brief
 * means by "the AI layer should interact only with approved tools" --
 * there is no code path anywhere that can execute a tool by name unless
 * it's a key in this object. An orchestrator (Phase 9) can only ever
 * offer the LLM tool schemas built from this list; it cannot construct
 * or register a new one at runtime.
 */
const TOOL_REGISTRY = {
  get_trip: getTripTool,
  get_trip_documents: getTripDocumentsTool,
  get_flight_status: getFlightStatusTool,
  get_weather: getWeatherTool,
  get_currency_rate: getCurrencyRateTool,
  search_destination: searchDestinationTool,
  search_trip_knowledge: searchTripKnowledgeTool,
  calculate_budget: calculateBudgetTool,
  create_recommendation: createRecommendationTool,
  create_alert: createAlertTool,
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export function isApprovedTool(name: string): name is ToolName {
  return Object.hasOwn(TOOL_REGISTRY, name);
}

export function getAllToolDefinitions(): ToolDefinition[] {
  return Object.values(TOOL_REGISTRY);
}

/**
 * The single execution path every tool call goes through: reject
 * anything not in the registry, validate input against that tool's own
 * schema, execute with the caller-supplied (never LLM-supplied) context,
 * log the outcome either way, and always return a structured result --
 * a tool failure becomes data the orchestrator can react to, never an
 * unhandled exception that could crash an agent loop mid-run.
 */
export async function callTool(
  name: string,
  rawInput: unknown,
  context: ToolContext,
): Promise<ToolResult<unknown>> {
  if (!isApprovedTool(name)) {
    logger.warn(
      { toolName: name, requestId: context.requestId },
      "Rejected call to an unapproved tool",
    );
    return {
      success: false,
      error: { code: "UNKNOWN_TOOL", message: `"${name}" is not an approved tool.` },
    };
  }

  const tool: ToolDefinition = TOOL_REGISTRY[name];
  const parsed = tool.inputSchema.safeParse(rawInput);

  if (!parsed.success) {
    logger.warn(
      { toolName: name, requestId: context.requestId, issues: parsed.error.issues },
      "Tool input validation failed",
    );
    return {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Input did not match the tool's expected shape.",
      },
    };
  }

  const startedAt = Date.now();
  try {
    const data = await tool.execute(parsed.data, context);
    logger.info(
      {
        toolName: name,
        requestId: context.requestId,
        userId: context.userId,
        durationMs: Date.now() - startedAt,
      },
      "Tool executed successfully",
    );
    return { success: true, data };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAppError(error)) {
      logger.warn(
        {
          toolName: name,
          requestId: context.requestId,
          userId: context.userId,
          durationMs,
          code: error.code,
        },
        "Tool execution failed with a handled error",
      );
      return { success: false, error: { code: error.code, message: error.message } };
    }

    // Unexpected error: full detail to the server log, generic message
    // in the structured result -- the same "never leak internals"
    // principle as withApiHandler (Phase 2), applied here since tool
    // results may eventually be shown to the model or logged elsewhere.
    logger.error(
      {
        toolName: name,
        requestId: context.requestId,
        userId: context.userId,
        durationMs,
        err: error,
      },
      "Tool execution failed with an unexpected error",
    );
    return { success: false, error: { code: "INTERNAL_ERROR", message: "Tool execution failed." } };
  }
}

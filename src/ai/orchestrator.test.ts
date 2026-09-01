import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { pool } from "@/infrastructure/db";
import { createTrip } from "@/modules/trip/trip-service";
import { defineAgent } from "@/ai/agents/types";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return { messages: { create: mockCreate } };
    }),
  };
});

// vi.mock calls are hoisted above every import in this file by vitest's
// transform, static or otherwise -- a regular import here already sees
// the mocked module. An earlier version used a dynamic `await import()`
// specifically to dodge hoisting concerns that don't actually apply to
// this case, and that unusual pattern was the actual source of 8/9
// tests failing with a misleading API_ERROR (mockCreate() was returning
// undefined rather than the configured response) -- found by testing,
// not by assuming the workaround was correct.
import { runAgent } from "@/ai/orchestrator";

const OWNER_EMAIL = "orchestrator-owner@example.com";
let ownerId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

function anthropicResponse(content: unknown[], usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  };
}

// A minimal test-fixture agent -- the 7 specialized agents are Phases
// 10-13/16-17/20's job; this just needs to exercise the orchestration
// mechanism itself.
const testAgent = defineAgent({
  name: "test_agent",
  role: "You are a test agent that looks up trip information.",
  allowedTools: ["get_trip"],
  outputSchema: z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
  }),
});

beforeEach(async () => {
  mockCreate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
});

afterEach(async () => {
  await pool.query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL]);
});

describe("runAgent: basic success paths", () => {
  it("returns success immediately when the model answers without needing any tool", async () => {
    mockCreate.mockResolvedValueOnce(
      anthropicResponse([
        {
          type: "tool_use",
          id: "tu_1",
          name: "provide_final_answer",
          input: { summary: "No trip needed for this", confidence: 0.9 },
        },
      ]),
    );

    const result = await runAgent(testAgent, "hello", { userId: ownerId, requestId: "r1" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe("No trip needed for this");
      expect(result.toolCallsUsed).toBe(0);
    }
  });

  it("calls a real tool, feeds the real result back, then returns the final answer", async () => {
    const trip = await createTrip(ownerId, { title: "Orchestrator test trip" });

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          { type: "tool_use", id: "tu_1", name: "get_trip", input: { tripId: trip.id } },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            input: { summary: "Found the trip", confidence: 1.0 },
          },
        ]),
      );

    const result = await runAgent(testAgent, "what's my trip?", {
      userId: ownerId,
      requestId: "r2",
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsUsed).toBe(1);

    // Prove the SECOND call to the model actually received the REAL
    // tool result (not a stub) -- the real trip title should be in the
    // message history sent back to Claude.
    const secondCallArgs = mockCreate.mock.calls[1][0];
    const messagesJson = JSON.stringify(secondCallArgs.messages);
    expect(messagesJson).toContain("Orchestrator test trip");
  });
});

describe("runAgent: real tool failures propagate correctly, not as crashes", () => {
  it("feeds a genuine tool failure (nonexistent trip) back to the model as an error result, then still succeeds", async () => {
    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_1",
            name: "get_trip",
            input: { tripId: "00000000-0000-0000-0000-000000000000" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            input: { summary: "That trip does not exist", confidence: 0.95 },
          },
        ]),
      );

    const result = await runAgent(testAgent, "check a trip", {
      userId: ownerId,
      requestId: "r3",
    });

    expect(result.success).toBe(true); // the AGENT run succeeds even though the TOOL call failed

    // Prove the real NOT_FOUND error was genuinely fed back, not swallowed.
    const secondCallArgs = mockCreate.mock.calls[1][0];
    const toolResultMessage = secondCallArgs.messages[2];
    expect(JSON.stringify(toolResultMessage)).toContain("NOT_FOUND");
  });
});

describe("runAgent: structured output validation", () => {
  it("rejects an invalid final answer, feeds back the validation issue, and accepts a corrected retry", async () => {
    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_1",
            name: "provide_final_answer",
            input: { summary: "test", confidence: 5 }, // out of [0,1] bounds
          },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            input: { summary: "test", confidence: 0.5 }, // corrected
          },
        ]),
      );

    const result = await runAgent(testAgent, "answer something", {
      userId: ownerId,
      requestId: "r4",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(0.5);
    }
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe("runAgent: hard limits", () => {
  it("stops at MAX_TOOL_CALLS_EXCEEDED when the model never stops calling tools", async () => {
    const trip = await createTrip(ownerId, { title: "Limit test trip" });
    // Always returns a real, successful tool call -- never a final answer.
    mockCreate.mockResolvedValue(
      anthropicResponse([
        { type: "tool_use", id: "tu_x", name: "get_trip", input: { tripId: trip.id } },
      ]),
    );

    const result = await runAgent(
      testAgent,
      "keep going forever",
      { userId: ownerId, requestId: "r5" },
      { maxToolCalls: 2, maxWallClockMs: 30_000, maxTokenBudget: 50_000 },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("MAX_TOOL_CALLS_EXCEEDED");
    }
    expect(result.toolCallsUsed).toBe(3); // exceeded on the 3rd attempt past a limit of 2
  });

  it("genuinely times out across multiple slow iterations", async () => {
    const trip = await createTrip(ownerId, { title: "Timeout test trip" });
    mockCreate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return anthropicResponse([
        { type: "tool_use", id: "tu_x", name: "get_trip", input: { tripId: trip.id } },
      ]);
    });

    const result = await runAgent(
      testAgent,
      "this will definitely exceed the limit",
      { userId: ownerId, requestId: "r7" },
      { maxToolCalls: 100, maxWallClockMs: 90, maxTokenBudget: 50_000 },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("TIMEOUT");
    }
  });

  it("stops at TOKEN_BUDGET_EXCEEDED when cumulative usage exceeds the injected budget", async () => {
    const trip = await createTrip(ownerId, { title: "Token budget trip" });
    mockCreate.mockResolvedValue(
      anthropicResponse(
        [{ type: "tool_use", id: "tu_x", name: "get_trip", input: { tripId: trip.id } }],
        { input_tokens: 60, output_tokens: 60 }, // 120 tokens per call
      ),
    );

    const result = await runAgent(
      testAgent,
      "burn through the token budget",
      { userId: ownerId, requestId: "r8" },
      { maxToolCalls: 100, maxWallClockMs: 30_000, maxTokenBudget: 100 },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("TOKEN_BUDGET_EXCEEDED");
    }
  });
});

describe("runAgent: API and model-behavior error handling", () => {
  it("returns API_ERROR, not a thrown exception, when the Anthropic call itself fails", async () => {
    mockCreate.mockRejectedValue(new Error("simulated network failure"));

    const result = await runAgent(testAgent, "anything", { userId: ownerId, requestId: "r9" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("API_ERROR");
    }
  });

  it("returns MODEL_STOPPED_WITHOUT_ANSWER when the model responds with no tool use at all", async () => {
    mockCreate.mockResolvedValueOnce(
      anthropicResponse([{ type: "text", text: "I have thoughts but no tool call." }]),
    );

    const result = await runAgent(testAgent, "anything", { userId: ownerId, requestId: "r10" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("MODEL_STOPPED_WITHOUT_ANSWER");
    }
  });
});

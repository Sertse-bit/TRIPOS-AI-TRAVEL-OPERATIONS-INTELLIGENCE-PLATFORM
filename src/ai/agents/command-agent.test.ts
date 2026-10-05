import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { addDestinationToTrip, createTrip } from "@/modules/trip/trip-service";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

const mockCreate = vi.fn();

// `function`, not an arrow: the Anthropic client is constructed with
// `new`, and arrow functions have no [[Construct]]. Same constraint the
// research-agent and risk-agent tests document.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return { messages: { create: mockCreate } };
    }),
  };
});

/**
 * Mocked explicitly rather than relying on the environment: these tests
 * must behave identically on a developer machine (which may have a real
 * key) and in CI (which never does). The refusal path flips this back
 * to false per-test.
 */
vi.mock("@/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env")>();
  return {
    ...actual,
    providerAvailability: { ...actual.providerAvailability, anthropic: true },
  };
});

const { providerAvailability } = await import("@/config/env");

import {
  assertEvidenceWasInvoked,
  commandAgent,
  findUninvokedSources,
  runCommandForUser,
} from "@/ai/agents/command-agent";

const OWNER_EMAIL = "command-agent-owner@example.com";
const OTHER_EMAIL = "command-agent-other@example.com";
let ownerId: string;
let otherId: string;

async function createTestUser(email: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test') RETURNING id`,
    [email],
  );
  return result.rows[0].id;
}

function anthropicResponse(content: unknown[]) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function finalAnswer(input: Record<string, unknown>) {
  return anthropicResponse([
    { type: "tool_use", id: "tu_final", name: "provide_final_answer", input },
  ]);
}

const GROUNDED_ANSWER = {
  decision: "Everything is on track; no action needed.",
  evidence: [{ source: "get_trip", observation: "Trip status is DRAFT with 1 destination." }],
  reasoningSummary: "The stored trip record shows no disruptions.",
  recommendationText: "No action needed — keep the current plan.",
  confidence: 0.8,
  dataGaps: [],
};

beforeEach(async () => {
  mockCreate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

describe("command agent: the read-only invariant", () => {
  it("has no write tool in its allowed set", () => {
    // The same discipline as Phase 20's "no cost field" test: the
    // property is pinned by an assertion, not by a comment. A command
    // bar question must never mutate a trip.
    expect(commandAgent.allowedTools).not.toContain("create_recommendation");
    expect(commandAgent.allowedTools).not.toContain("create_alert");
    expect(commandAgent.allowedTools).toContain("get_trip");
  });
});

describe("findUninvokedSources: evidence must name a real invocation", () => {
  it("accepts a source that was called, even if the call itself failed", () => {
    expect(
      findUninvokedSources([{ source: "get_weather" }], [{ name: "get_weather", success: false }]),
    ).toEqual([]);
  });

  it("rejects a source that was never called", () => {
    expect(
      findUninvokedSources([{ source: "create_alert" }], [{ name: "get_trip", success: true }]),
    ).toEqual(["create_alert"]);
  });

  it("names every offending source in the thrown error", () => {
    expect(() =>
      assertEvidenceWasInvoked(
        [{ source: "get_trip" }, { source: "get_flight_status" }, { source: "get_risk" }],
        [{ name: "get_trip", success: true }],
      ),
    ).toThrow(/get_flight_status, get_risk/);
  });
});

describe("runCommandForUser: authorization happens before any LLM call", () => {
  it("rejects a non-owner without ever calling the model", async () => {
    const trip = await createTrip(ownerId, { title: "Private command trip" });

    await expect(runCommandForUser(trip.id, otherId, "is anything wrong?")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("runCommandForUser: input validation", () => {
  it("rejects a blank command before calling the model", async () => {
    const trip = await createTrip(ownerId, { title: "Blank command trip" });

    await expect(runCommandForUser(trip.id, ownerId, "   ")).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a command over 500 characters before calling the model", async () => {
    const trip = await createTrip(ownerId, { title: "Long command trip" });

    await expect(runCommandForUser(trip.id, ownerId, "x".repeat(501))).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("runCommandForUser: honest refusal without a key", () => {
  it("refuses with a ProviderError naming the missing key, without calling the model", async () => {
    vi.spyOn(providerAvailability, "anthropic", "get").mockReturnValue(false);
    const trip = await createTrip(ownerId, { title: "No key trip" });

    await expect(runCommandForUser(trip.id, ownerId, "is anything wrong?")).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("runCommandForUser: full pipeline against real trip data", () => {
  it("runs real tools, returns the structured answer, and reports the real call trail", async () => {
    const trip = await createTrip(ownerId, { title: "Command pipeline trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Nairobi", country: "Kenya" });

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          { type: "tool_use", id: "tu_1", name: "get_trip", input: { tripId: trip.id } },
        ]),
      )
      .mockResolvedValueOnce(finalAnswer(GROUNDED_ANSWER));

    const result = await runCommandForUser(trip.id, ownerId, "is anything about this trip off?");

    // The structured answer came through as-is.
    expect(result.decision).toBe(GROUNDED_ANSWER.decision);
    expect(result.recommendationText).toBe(GROUNDED_ANSWER.recommendationText);
    expect(result.confidence).toBe(0.8);
    expect(result.command).toBe("is anything about this trip off?");

    // The call trail is code-recorded, not model-reported.
    expect(result.toolCalls).toEqual([{ name: "get_trip", success: true }]);
    expect(result.toolCallsUsed).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensUsed).toBe(300); // two mocked responses, 150 tokens each

    // Pre-fetched context saved a tool call: the real destination is already
    // in the message the model received.
    expect(JSON.stringify(mockCreate.mock.calls[0][0].messages)).toContain("Nairobi, Kenya");
  });

  it("rejects an answer whose evidence cites a tool that was never called", async () => {
    const trip = await createTrip(ownerId, { title: "Fabricated provenance trip" });

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          { type: "tool_use", id: "tu_1", name: "get_trip", input: { tripId: trip.id } },
        ]),
      )
      .mockResolvedValueOnce(
        finalAnswer({
          ...GROUNDED_ANSWER,
          // get_weather is a real tool in the allowed set, but this run
          // never called it.
          evidence: [{ source: "get_weather", observation: "22°C and clear." }],
        }),
      );

    await expect(runCommandForUser(trip.id, ownerId, "what's the weather?")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("propagates an orchestrator-level failure as a ProviderError rather than crashing", async () => {
    const trip = await createTrip(ownerId, { title: "API failure trip" });
    mockCreate.mockRejectedValue(new Error("simulated network failure"));

    await expect(runCommandForUser(trip.id, ownerId, "anything")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

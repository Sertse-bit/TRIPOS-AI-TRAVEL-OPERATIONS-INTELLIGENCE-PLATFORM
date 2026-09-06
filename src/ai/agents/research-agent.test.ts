import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import { createTrip, addDestinationToTrip } from "@/modules/trip/trip-service";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

const mockCreate = vi.fn();

// Proper `function`, not an arrow function -- arrow functions have no
// [[Construct]] behavior and cannot be invoked with `new`, which is
// exactly what broke 8/9 of Phase 9's orchestrator tests the first time
// around. Applying that lesson from the start this time.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return { messages: { create: mockCreate } };
    }),
  };
});

import { runResearchAgentForUser } from "@/ai/agents/research-agent";

const OWNER_EMAIL = "research-agent-owner@example.com";
const OTHER_EMAIL = "research-agent-other@example.com";
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

beforeEach(async () => {
  mockCreate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
});

describe("runResearchAgentForUser: authorization happens before any LLM call", () => {
  it("rejects a non-owner without ever calling the model", async () => {
    const trip = await createTrip(ownerId, { title: "Private research trip" });

    await expect(
      runResearchAgentForUser(trip.id, otherId, "what's the visa requirement?"),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("runResearchAgentForUser: input validation", () => {
  it("rejects an empty question before calling the model", async () => {
    const trip = await createTrip(ownerId, { title: "Empty question trip" });

    await expect(runResearchAgentForUser(trip.id, ownerId, "   ")).rejects.toThrow();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("runResearchAgentForUser: full pipeline with real trip context", () => {
  it("includes the trip's real destinations in the context sent to the model", async () => {
    const trip = await createTrip(ownerId, { title: "Context trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Dubai", country: "UAE" });

    mockCreate.mockResolvedValueOnce(
      anthropicResponse([
        {
          type: "tool_use",
          id: "tu_1",
          name: "provide_final_answer",
          input: { answer: "test", sources: [], hasEvidence: false, confidence: 0.5 },
        },
      ]),
    );

    await runResearchAgentForUser(trip.id, ownerId, "is it safe to visit right now?");

    const firstCallArgs = mockCreate.mock.calls[0][0];
    expect(JSON.stringify(firstCallArgs.messages)).toContain("Dubai, UAE");
  });

  it("performs a real search and returns a structured, sourced answer", async () => {
    const trip = await createTrip(ownerId, { title: "Full research trip" });
    await addDestinationToTrip(trip.id, ownerId, { city: "Dubai", country: "UAE" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          organic: [
            {
              position: 1,
              title: "UAE Visa Requirements 2026",
              url: "https://example.gov/uae-visa",
              description: "Most nationalities receive a visa on arrival valid for 30 days.",
            },
          ],
        }),
      }),
    );

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_1",
            name: "search_destination",
            input: { tripId: trip.id, query: "UAE visa requirements 2026" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            input: {
              answer:
                "According to example.gov, most nationalities receive a visa on arrival valid for 30 days.",
              sources: [
                { url: "https://example.gov/uae-visa", title: "UAE Visa Requirements 2026" },
              ],
              hasEvidence: true,
              confidence: 0.85,
            },
          },
        ]),
      );

    const result = await runResearchAgentForUser(trip.id, ownerId, "do I need a visa for the UAE?");

    expect(result.hasEvidence).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe("https://example.gov/uae-visa");
    expect(result.answer).toContain("example.gov");
  });

  it("accepts an honest 'no evidence found' answer with an empty sources list", async () => {
    const trip = await createTrip(ownerId, { title: "No evidence trip" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organic: [] }) }),
    );

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_1",
            name: "search_destination",
            input: { tripId: trip.id, query: "extremely obscure question" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            input: {
              answer: "I couldn't find reliable information to answer this question.",
              sources: [],
              hasEvidence: false,
              confidence: 0.1,
            },
          },
        ]),
      );

    const result = await runResearchAgentForUser(trip.id, ownerId, "some obscure question");
    expect(result.hasEvidence).toBe(false);
    expect(result.sources).toEqual([]);
  });

  it("rejects an internally inconsistent answer: hasEvidence=true but no sources cited", async () => {
    const trip = await createTrip(ownerId, { title: "Inconsistent answer trip" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ organic: [{ position: 1, title: "x", url: "https://x.com" }] }),
      }),
    );

    mockCreate
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_1",
            name: "search_destination",
            input: { tripId: trip.id, query: "x" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        anthropicResponse([
          {
            type: "tool_use",
            id: "tu_2",
            name: "provide_final_answer",
            // Internally inconsistent: claims evidence exists but cites nothing.
            input: { answer: "Yes, definitely.", sources: [], hasEvidence: true, confidence: 0.9 },
          },
        ]),
      );

    await expect(runResearchAgentForUser(trip.id, ownerId, "is this true?")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("propagates an orchestrator-level failure as a ProviderError rather than crashing", async () => {
    const trip = await createTrip(ownerId, { title: "API failure trip" });
    mockCreate.mockRejectedValue(new Error("simulated network failure"));

    await expect(runResearchAgentForUser(trip.id, ownerId, "anything")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

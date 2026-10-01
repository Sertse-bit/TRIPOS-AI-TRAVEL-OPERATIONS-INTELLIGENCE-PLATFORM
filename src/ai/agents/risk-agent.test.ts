import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/infrastructure/db";
import {
  addDestinationToTrip,
  addFlightToTrip,
  createTrip,
  getTripEventHistory,
  getTripRecommendations,
} from "@/modules/trip/trip-service";
import { assessTripRisk } from "@/modules/risk/risk-service";
import {
  generateTripRecommendation,
  listTripRecommendations,
} from "@/modules/risk/recommendation-service";
import { NotFoundError, ProviderError, ValidationError } from "@/shared/errors";

const mockCreate = vi.fn();

// `function`, not an arrow: the Anthropic client is constructed with
// `new`, and arrow functions have no [[Construct]]. Same constraint the
// research-agent test documents.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(function MockAnthropic() {
      return { messages: { create: mockCreate } };
    }),
  };
});

/**
 * The agent refuses to run without a key, which is correct in production
 * but would make every test here assert the refusal instead of the
 * grounding logic. Mocked explicitly rather than relying on whatever
 * key happens to exist in the environment -- these tests must behave the
 * same on a developer machine and in CI.
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
  assertGroundedInFactors,
  clampConfidenceToAssessment,
  explainTripRisk,
  findUngroundedEvidence,
} from "@/ai/agents/risk-agent";

const OWNER_EMAIL = "risk-agent-owner@example.com";
const OTHER_EMAIL = "risk-agent-other@example.com";
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

/** A final-answer block carrying whatever explanation fields a test wants. */
function finalAnswer(input: Record<string, unknown>) {
  return anthropicResponse([{ type: "tool_use", id: "tu_1", name: "provide_final_answer", input }]);
}

async function cleanupTestUsers(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, OTHER_EMAIL]);
}

beforeEach(async () => {
  await cleanupTestUsers();
  mockCreate.mockReset();
  ownerId = await createTestUser(OWNER_EMAIL);
  otherId = await createTestUser(OTHER_EMAIL);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupTestUsers();
});

/** A trip with a real stored assessment, which is what the agent reads. */
async function assessedTrip(userId = ownerId) {
  const trip = await createTrip(userId, { title: "Explainable trip" });
  await addDestinationToTrip(trip.id, userId, { city: "Porto", country: "Portugal" });
  await addFlightToTrip(trip.id, userId, {
    flightNumber: "TP1353",
    airline: "TAP",
    departureAirport: "LIS",
    arrivalAirport: "OPO",
    scheduledDeparture: new Date(Date.now() + 3 * 60 * 60 * 1000),
    scheduledArrival: new Date(Date.now() + 4 * 60 * 60 * 1000),
  });
  const assessed = await assessTripRisk(trip.id, userId);
  return { trip, assessed };
}

describe("grounding checks (pure)", () => {
  const factors = [
    { key: "flightDisruption", label: "Flight disruption", points: 0, weight: 40 },
    { key: "weatherSeverity", label: "Weather severity", points: 0, weight: 20 },
  ];

  it("accepts evidence citing factors that exist in the assessment", () => {
    expect(
      findUngroundedEvidence(
        [{ factor: "flightDisruption" }, { factor: "weatherSeverity" }],
        factors,
      ),
    ).toEqual([]);
  });

  it("flags a factor the assessment never produced", () => {
    expect(findUngroundedEvidence([{ factor: "vibes" }], factors)).toEqual(["vibes"]);
  });

  it("throws when the explanation cites an invented factor", () => {
    expect(() =>
      assertGroundedInFactors(
        {
          decision: "d",
          evidence: [{ factor: "flightDisruption", observation: "o" }],
          reasoningSummary: "r",
          recommendationText: "t",
          confidence: 0.9,
        },
        factors,
      ),
    ).not.toThrow();

    expect(() =>
      assertGroundedInFactors(
        {
          decision: "d",
          evidence: [
            { factor: "flightDisruption", observation: "o" },
            { factor: "hotelWifiQuality", observation: "terrible" },
          ],
          reasoningSummary: "r",
          recommendationText: "t",
          confidence: 0.9,
        },
        factors,
      ),
    ).toThrow(ValidationError);
  });

  it("treats a malformed factors array as grounding nothing rather than everything", () => {
    expect(findUngroundedEvidence([{ factor: "flightDisruption" }], "not an array")).toEqual([
      "flightDisruption",
    ]);
  });
});

describe("confidence clamping (pure)", () => {
  it("never lets an explanation outrank the evidence behind its assessment", () => {
    // The model claims 0.95 on an assessment that only had half its
    // factors scored. Phase 16 defines that assessment's confidence as
    // 0.5, so 0.95 would be a claim the data cannot support.
    expect(clampConfidenceToAssessment(0.95, 0.5)).toBe(0.5);
  });

  it("leaves a lower model confidence untouched", () => {
    expect(clampConfidenceToAssessment(0.3, 0.9)).toBe(0.3);
  });

  it("keeps the result inside [0,1]", () => {
    expect(clampConfidenceToAssessment(-2, 0.5)).toBe(0);
    expect(clampConfidenceToAssessment(5, 1)).toBe(1);
  });
});

describe("explainTripRisk", () => {
  it("refuses clearly, without a model call, when no Anthropic key is configured", async () => {
    // Anthropic has no mock adapter by design -- a fabricated
    // explanation of a risk score is the exact thing this project
    // refuses to invent. So an unconfigured key must be reported as a
    // configuration problem, not a generic upstream 502.
    vi.spyOn(providerAvailability, "anthropic", "get").mockReturnValue(false);
    try {
      const { trip } = await assessedTrip();
      await expect(explainTripRisk(trip.id, ownerId)).rejects.toBeInstanceOf(ProviderError);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses to explain a trip that was never assessed", async () => {
    const trip = await createTrip(ownerId, { title: "Unassessed trip" });

    await expect(explainTripRisk(trip.id, ownerId)).rejects.toBeInstanceOf(ValidationError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before making any model call", async () => {
    const { trip } = await assessedTrip();

    await expect(explainTripRisk(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns the stored deterministic score alongside the model's prose", async () => {
    const { trip, assessed } = await assessedTrip();

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "This trip is calm but departs soon.",
        evidence: [
          { factor: "scheduleProximity", observation: "Next departure is in 180 minutes." },
        ],
        reasoningSummary: "Only the departure is close; no flight or weather disruption recorded.",
        recommendationText: "Confirm check-in and travel time.",
        confidence: 0.7,
      }),
    );

    const result = await explainTripRisk(trip.id, ownerId);

    // Score and severity come from the assessment, not the model.
    expect(result.riskScore).toBe(assessed.assessment.riskScore);
    expect(result.severity).toBe(assessed.assessment.severity);
    expect(result.riskAssessmentId).toBe(assessed.assessment.id);
    expect(result.confidence).toBeLessThanOrEqual(result.assessmentConfidence);
    expect(result.generatedAt).toEqual(assessed.assessment.generatedAt);
  });

  it("rejects an explanation that cites a factor the assessment never produced", async () => {
    const { trip } = await assessedTrip();

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "The hotel wifi is terrible.",
        evidence: [{ factor: "hotelWifiQuality", observation: "Two bars." }],
        reasoningSummary: "Connectivity will be poor.",
        recommendationText: "Bring a hotspot.",
        confidence: 0.8,
      }),
    );

    await expect(explainTripRisk(trip.id, ownerId)).rejects.toBeInstanceOf(ValidationError);
  });

  it("clamps a model confidence that outruns its assessment", async () => {
    const { trip, assessed } = await assessedTrip();
    // This trip has some unscored factors, so its stored confidence is
    // below 1 — a model claiming 0.99 must be cut down to it.
    expect(assessed.assessment.confidence).toBeLessThan(1);

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "Everything is fine.",
        evidence: [{ factor: "flightDisruption", observation: "Flight is on schedule." }],
        reasoningSummary: "Nothing is disrupted.",
        recommendationText: "Proceed as planned.",
        confidence: 0.99,
      }),
    );

    const result = await explainTripRisk(trip.id, ownerId);
    expect(result.confidence).toBe(assessed.assessment.confidence);
  });

  it("gives the agent only read-only risk tools", () => {
    // An agent that could write recommendations or alerts would be able
    // to act on its own explanation, past the caller's review.
    expect(mocksOfFirstCallSystemPrompt()).not.toContain("create_recommendation");
  });

  function mocksOfFirstCallSystemPrompt(): string {
    return JSON.stringify(mockCreate.mock.calls[0]?.[0]?.tools ?? []);
  }

  it("propagates an orchestrator failure as a ProviderError", async () => {
    const { trip } = await assessedTrip();
    mockCreate.mockRejectedValue(new Error("simulated network failure"));

    await expect(explainTripRisk(trip.id, ownerId)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("generateTripRecommendation", () => {
  it("persists the explanation linked to the assessment it was written for", async () => {
    const { trip, assessed } = await assessedTrip();

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "Departure is close but nothing is disrupted.",
        evidence: [{ factor: "scheduleProximity", observation: "Next departure in 180 minutes." }],
        reasoningSummary: "Schedule proximity is the only elevated factor.",
        recommendationText: "Leave for the airport in good time.",
        confidence: 0.6,
      }),
    );

    const result = await generateTripRecommendation(trip.id, ownerId);

    expect(result.recommendation.riskAssessmentId).toBe(assessed.assessment.id);
    expect(result.riskScore).toBe(assessed.assessment.riskScore);
    expect(result.severity).toBe(assessed.assessment.severity);

    const stored = result.recommendation.evidence as {
      factorsCited: Array<{ factor: string }>;
      riskScore: number;
    };
    expect(stored.riskScore).toBe(assessed.assessment.riskScore);
    expect(stored.factorsCited[0].factor).toBe("scheduleProximity");

    const events = await getTripEventHistory(trip.id, ownerId);
    expect(events.some((e) => e.eventType === "RECOMMENDATION_CREATED")).toBe(true);
  });

  it("never stores an explanation whose score disagrees with the assessment", async () => {
    const { trip, assessed } = await assessedTrip();

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        // Text asserting a severity the stored assessment contradicts.
        decision: "This trip is critical and should be abandoned.",
        evidence: [{ factor: "flightDisruption", observation: "Flight is on schedule." }],
        reasoningSummary: "It feels risky.",
        recommendationText: "Cancel the trip.",
        confidence: 0.5,
      }),
    );

    const result = await generateTripRecommendation(trip.id, ownerId);

    // The prose is the model's, but the recorded score is the real one,
    // so a reader always sees which is which.
    const stored = result.recommendation.evidence as { riskScore: number; severity: string };
    expect(stored.riskScore).toBe(assessed.assessment.riskScore);
    expect(stored.severity).toBe(assessed.assessment.severity);
  });

  it("writes nothing when the explanation is rejected as ungrounded", async () => {
    const { trip } = await assessedTrip();

    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "d",
        evidence: [{ factor: "inventedFactor", observation: "o" }],
        reasoningSummary: "r",
        recommendationText: "t",
        confidence: 0.8,
      }),
    );

    await expect(generateTripRecommendation(trip.id, ownerId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await getTripRecommendations(trip.id, ownerId)).toEqual([]);
  });

  it("lists only the requesting trip's recommendations", async () => {
    const { trip } = await assessedTrip();
    mockCreate.mockResolvedValueOnce(
      finalAnswer({
        decision: "d",
        evidence: [{ factor: "flightDisruption", observation: "o" }],
        reasoningSummary: "r",
        recommendationText: "t",
        confidence: 0.5,
      }),
    );
    await generateTripRecommendation(trip.id, ownerId);

    expect(await listTripRecommendations(trip.id, ownerId)).toHaveLength(1);
    await expect(listTripRecommendations(trip.id, otherId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

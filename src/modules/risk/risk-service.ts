import {
  getTrip,
  getTripDigitalTwin,
  getTripFlightStatuses,
  getTripWeatherSnapshots,
  emitTripEvent,
} from "@/modules/trip/trip-service";
import { getTripIndexStatus } from "@/modules/trip/rag-service";
import {
  type RiskAssessmentRecord,
  type RiskSeverity,
  createRiskAssessment,
  findLatestRiskAssessmentByTripId,
  findRiskAssessmentsByTripId,
} from "@/modules/risk/risk-repository";
import {
  type RiskFactorResult,
  type RiskScoreResult,
  scoreTripRisk,
} from "@/modules/risk/risk-scoring";

/**
 * Risk Service — Phase 16, the module's public interface.
 *
 * Owns exactly one job: turn the trip's real stored data into a
 * deterministic risk assessment, persist it, and say so in the event
 * history. All arithmetic lives in the pure scoring module; this file is
 * the I/O around it.
 *
 * It calls only the Trip Service's public functions — per the brief's
 * module boundary rule, never another module's repositories or models.
 */

export interface RiskAssessmentResult {
  assessment: RiskAssessmentRecord;
  factors: RiskFactorResult[];
  /** The input snapshot the score was computed from, for auditability. */
  evidence: {
    flights: Array<{
      flightNumber: string;
      status: string | null;
      delayMinutes: number | null;
      minutesToDeparture: number;
    }>;
    weather: Array<{
      city: string;
      condition: string;
      windSpeedKph: number | null;
      precipitationMm: number | null;
      ageHours: number | null;
    }>;
    documents: { total: number; ready: number; indexedChunks: number };
    itinerary: { destinations: number; travelers: number };
    operationalState: string;
  };
  confidence: number;
  dataGaps: number;
}

/**
 * Computes and stores a fresh assessment for a trip the caller owns.
 *
 * Every assessment is a new row (append-only, like the rest of this
 * project's history tables) and a RISK_ASSESSMENT_GENERATED event, so
 * the score's evolution is inspectable over time rather than
 * overwritten.
 */
export async function assessTripRisk(
  tripId: string,
  userId: string,
): Promise<RiskAssessmentResult> {
  await getTrip(tripId, userId);

  const [twin, flightStatuses, weatherSnapshots, indexStatus] = await Promise.all([
    getTripDigitalTwin(tripId, userId),
    getTripFlightStatuses(tripId, userId),
    getTripWeatherSnapshots(tripId, userId),
    getTripIndexStatus(tripId, userId),
  ]);

  const generatedAt = new Date();

  const flightEvidence = flightStatuses.map((flight) => ({
    flightNumber: flight.flightNumber,
    status: flight.status,
    delayMinutes: flight.delayMinutes,
    minutesToDeparture: Math.round(
      (flight.scheduledDeparture.getTime() - generatedAt.getTime()) / 60000,
    ),
  }));

  const weatherEvidence = weatherSnapshots.map((entry) => ({
    city: entry.city,
    condition: entry.snapshot?.condition ?? "unknown",
    windSpeedKph: entry.snapshot?.windSpeedKph ?? null,
    precipitationMm: entry.snapshot?.precipitationMm ?? null,
    ageHours: entry.snapshot
      ? (generatedAt.getTime() - entry.snapshot.fetchedAt.getTime()) / 3_600_000
      : null,
  }));

  const readyDocumentCount = twin.documents.filter((doc) => doc.status === "READY").length;
  const indexedDocumentIds = new Set(indexStatus.indexedDocumentIds);

  const scoring = scoreTripRisk({
    flights: flightEvidence,
    weather: weatherEvidence,
    documentCount: twin.documents.length,
    readyDocumentCount,
    indexedDocumentCount: twin.documents.filter((doc) => indexedDocumentIds.has(doc.id)).length,
    destinationCount: twin.destinations.length,
    travelerCount: twin.travelers.length,
  });

  const evidence = {
    flights: flightEvidence,
    weather: weatherEvidence,
    documents: {
      total: twin.documents.length,
      ready: readyDocumentCount,
      indexedChunks: indexStatus.indexedChunks,
    },
    itinerary: {
      destinations: twin.destinations.length,
      travelers: twin.travelers.length,
    },
    operationalState: twin.operationalState.state,
  };

  const assessment = await createRiskAssessment({
    tripId,
    riskScore: scoring.riskScore,
    severity: scoring.severity,
    factors: scoring.factors,
    evidence,
    confidence: scoring.confidence,
    generatedAt,
  });

  await emitTripEvent(tripId, userId, {
    eventType: "RISK_ASSESSMENT_GENERATED",
    entityType: "risk_assessment",
    entityId: assessment.id,
    metadata: {
      riskScore: assessment.riskScore,
      severity: assessment.severity,
      confidence: assessment.confidence,
    },
  });

  return {
    assessment,
    factors: scoring.factors,
    evidence,
    confidence: scoring.confidence,
    dataGaps: scoring.dataGaps,
  };
}

/**
 * The newest stored assessment, or null when none has been generated
 * yet. An empty history is reported as null, never as a default score.
 */
export async function getLatestTripRisk(
  tripId: string,
  userId: string,
): Promise<RiskAssessmentRecord | null> {
  await getTrip(tripId, userId);
  return findLatestRiskAssessmentByTripId(tripId);
}

export async function listTripRiskAssessments(
  tripId: string,
  userId: string,
): Promise<RiskAssessmentRecord[]> {
  await getTrip(tripId, userId);
  return findRiskAssessmentsByTripId(tripId);
}

export type { RiskAssessmentRecord, RiskSeverity, RiskScoreResult };

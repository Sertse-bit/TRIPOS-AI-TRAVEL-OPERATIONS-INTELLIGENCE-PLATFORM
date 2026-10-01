import { extractText } from "unpdf";

/**
 * Text + metadata extraction for trip documents (Phase 14 — Document
 * Intelligence).
 *
 * This module is deliberately pure: no database, no network, no logging.
 * It takes bytes and returns text/metadata, which makes the pipeline's
 * hardest-to-test part deterministic and fast to test with a real,
 * programmatically-built PDF fixture rather than a mock parser.
 *
 * Philosophy, per the project's non-negotiable rules: extraction results
 * must be explainable and never invented. Every extracted fact carries
 * the evidence it was found in, and an unsupported input type produces
 * an explicit "unsupported" result — never a fabricated one.
 */

export interface PdfExtractionResult {
  kind: "pdf";
  text: string;
  pageCount: number;
  /** True when the stored text was capped (see MAX_EXTRACTED_TEXT_LENGTH). */
  truncated: boolean;
}

export interface UnsupportedExtractionResult {
  kind: "unsupported";
  reason: string;
}

export type DocumentExtractionResult = PdfExtractionResult | UnsupportedExtractionResult;

export interface ExtractedFact {
  value: string;
  /** Surrounding text the value was found in, whitespace-collapsed. */
  evidence: string;
}

// A type alias (not an interface) so it is assignable to the repository's
// Record<string, unknown> jsonb parameter without a cast.
export type DocumentMetadata = {
  extraction: {
    method: "pdf-text";
    pageCount: number;
    characterCount: number;
    truncated: boolean;
  };
  flightNumbers: ExtractedFact[];
  dates: ExtractedFact[];
  bookingReferences: ExtractedFact[];
};

/**
 * A 10MB PDF can legitimately contain tens of megabytes of text. Capping
 * keeps a single document from bloating rows and downstream RAG work;
 * `truncated: true` in the metadata says exactly what happened rather
 * than silently dropping the tail.
 */
const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;

const SNIPPET_LENGTH = 160;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return collapseWhitespace(text.slice(start, end)).slice(0, SNIPPET_LENGTH);
}

// --- Extraction ------------------------------------------------------------

export async function extractDocumentContent(input: {
  buffer: Buffer;
  mimeType: string;
}): Promise<DocumentExtractionResult> {
  if (input.mimeType === "application/pdf") {
    // Pass the raw bytes, not a document proxy: unpdf's own lifecycle
    // handling tears the pdf.js document down once extraction settles,
    // which a proxy obtained via getDocumentProxy() would not do for us.
    const { text, totalPages } = await extractText(new Uint8Array(input.buffer), {
      mergePages: true,
    });

    // Postgres `text` columns reject NUL bytes outright; strip any the
    // parser surfaces rather than failing the whole document over one.
    const sanitized = text.replace(/\u0000/g, "");
    const truncated = sanitized.length > MAX_EXTRACTED_TEXT_LENGTH;

    return {
      kind: "pdf",
      text: truncated ? sanitized.slice(0, MAX_EXTRACTED_TEXT_LENGTH) : sanitized,
      pageCount: totalPages,
      truncated,
    };
  }

  if (input.mimeType === "image/jpeg" || input.mimeType === "image/png") {
    // Honest capability boundary, not an error: the file is stored, but
    // turning a photo of a boarding pass into text needs OCR, which is
    // not implemented in this build. Claiming otherwise would violate
    // the "never fake data" rule.
    return {
      kind: "unsupported",
      reason:
        "Image documents are stored but not text-extracted: OCR is not implemented in this build.",
    };
  }

  return {
    kind: "unsupported",
    reason: `No text extraction path is implemented for "${input.mimeType}".`,
  };
}

// --- Deterministic metadata extraction -------------------------------------

/**
 * Prefixes that look like airline designators under the flight-number
 * pattern but are really currency amounts ("USD 100") or common
 * non-airline tokens. A small, explicit deny-list keeps the heuristic
 * explainable; it is data, not a growing pile of special cases in code.
 */
const NON_AIRLINE_PREFIXES = new Set([
  "USD",
  "EUR",
  "GBP",
  "ETB",
  "AED",
  "SAR",
  "QAR",
  "KES",
  "ZAR",
  "INR",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
  "ISO",
  "PDF",
  "PNG",
  "JPG",
  "API",
  "URL",
  "HTTP",
  "VAT",
  "ZIP",
  "FAQ",
  "UTC",
  "GMT",
  "WWW",
  "PO",
  "ID",
  "NO",
]);

const FLIGHT_NUMBER_PATTERN = /\b([A-Z]{2})\s?(\d{1,4})\b/g;

const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const DAY_MONTH_NAME_DATE_PATTERN =
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/gi;
const MONTH_NAME_DAY_DATE_PATTERN =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi;

/**
 * Booking references are conventionally 6 alphanumeric characters
 * ("ABC123"). Requiring at least one letter AND one digit removes the
 * most common false positive — a 6-letter uppercase word like "LONDON".
 * They are only collected from sentences that also contain a
 * booking-ish keyword, which is what makes the result defensible as
 * "extracted with evidence" rather than "looks like a code".
 */
const BOOKING_REFERENCE_PATTERN = /\b[A-Z0-9]{6}\b/g;
const BOOKING_REFERENCE_CONTEXT =
  /\b(booking|confirmation|reference|record locator|PNR|reservation)\b/i;

function hasLetterAndDigit(value: string): boolean {
  return /[A-Z]/.test(value) && /\d/.test(value);
}

function collectFacts(text: string, pattern: RegExp): ExtractedFact[] {
  const facts = new Map<string, ExtractedFact>();

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;

    const value = match[0];
    if (facts.has(value)) continue;

    facts.set(value, { value, evidence: snippetAround(text, match.index, value.length) });
  }

  return [...facts.values()];
}

/**
 * Canonicalizes to the spaceless form ("ET 602" and "ET602" are the same
 * flight) BEFORE deduplicating, so both spellings collapse to one fact
 * rather than surviving as near-duplicates.
 */
function collectFlightNumbers(text: string): ExtractedFact[] {
  const byValue = new Map<string, ExtractedFact>();

  for (const match of text.matchAll(FLIGHT_NUMBER_PATTERN)) {
    if (match.index === undefined) continue;
    if (NON_AIRLINE_PREFIXES.has(match[1])) continue;

    const value = match[0].replace(/\s/g, "");
    if (byValue.has(value)) continue;

    byValue.set(value, { value, evidence: snippetAround(text, match.index, match[0].length) });
  }

  return [...byValue.values()];
}

function collectDates(text: string): ExtractedFact[] {
  const byValue = new Map<string, ExtractedFact>();

  for (const pattern of [
    ISO_DATE_PATTERN,
    DAY_MONTH_NAME_DATE_PATTERN,
    MONTH_NAME_DAY_DATE_PATTERN,
  ]) {
    for (const fact of collectFacts(text, pattern)) {
      if (!byValue.has(fact.value)) byValue.set(fact.value, fact);
    }
  }

  return [...byValue.values()];
}

function collectBookingReferences(text: string, knownFlightNumbers: string[]): ExtractedFact[] {
  const known = new Set(knownFlightNumbers);
  const byValue = new Map<string, ExtractedFact>();

  // Sentence-scoped so a keyword applies to codes actually near it, not
  // anywhere in a long document.
  const segments = text.split(/(?<=[.!?])\s+|\n+/);

  for (const segment of segments) {
    if (!BOOKING_REFERENCE_CONTEXT.test(segment)) continue;

    for (const match of segment.matchAll(BOOKING_REFERENCE_PATTERN)) {
      const value = match[0];
      if (!hasLetterAndDigit(value)) continue;
      if (known.has(value)) continue;
      if (byValue.has(value)) continue;

      byValue.set(value, {
        value,
        evidence: collapseWhitespace(segment).slice(0, SNIPPET_LENGTH),
      });
    }
  }

  return [...byValue.values()];
}

/**
 * Deterministic, evidence-backed structured metadata. No LLM is involved
 * here on purpose: this layer can be unit-tested against exact expected
 * values, and anything it reports is traceable to a literal in the
 * document text. Richer, fuzzier extraction (passenger names, seat
 * numbers) is deliberately not attempted rather than guessed at —
 * a wrong-but-confident extraction is worse than none.
 */
export function extractDocumentMetadata(extraction: PdfExtractionResult): DocumentMetadata {
  const text = extraction.text;

  const flightNumbers = collectFlightNumbers(text);

  return {
    extraction: {
      method: "pdf-text",
      pageCount: extraction.pageCount,
      characterCount: text.length,
      truncated: extraction.truncated,
    },
    flightNumbers,
    dates: collectDates(text),
    bookingReferences: collectBookingReferences(
      text,
      flightNumbers.map((fact) => fact.value),
    ),
  };
}

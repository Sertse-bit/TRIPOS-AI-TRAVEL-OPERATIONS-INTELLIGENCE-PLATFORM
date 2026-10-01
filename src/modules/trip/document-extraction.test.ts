import { describe, expect, it } from "vitest";
import {
  type PdfExtractionResult,
  extractDocumentContent,
  extractDocumentMetadata,
} from "@/modules/trip/document-extraction";
import { buildMinimalPdf, makeMinimalPng } from "@/modules/trip/document-fixtures";

const BOARDING_PASS_PAGE =
  "BOARDING PASS TripOS Air ET602 Addis Ababa to Dubai 2026-09-10 " +
  "Booking reference: ABC123 Passenger ALICE TRAVELER Seat 12A Amount USD 100.00 Return: 12 Mar 2026";

const INSURANCE_PAGE =
  "Travel insurance confirmation for LONDON - policy reference XYZ789 valid from 2026-10-01.";

async function extractPdf(pages: string[]): Promise<PdfExtractionResult> {
  const result = await extractDocumentContent({
    buffer: buildMinimalPdf(pages),
    mimeType: "application/pdf",
  });
  if (result.kind !== "pdf") {
    throw new Error(`Expected a PDF extraction result, got "${result.kind}"`);
  }
  return result;
}

describe("extractDocumentContent", () => {
  it("extracts real text and the page count from a valid PDF", async () => {
    const result = await extractPdf([BOARDING_PASS_PAGE, INSURANCE_PAGE]);

    expect(result.pageCount).toBe(2);
    expect(result.text).toContain("ET602");
    expect(result.text).toContain("ABC123");
    expect(result.text).toContain("XYZ789");
    expect(result.truncated).toBe(false);
  });

  it("reports images honestly as unsupported instead of faking text extraction", async () => {
    const result = await extractDocumentContent({
      buffer: makeMinimalPng(),
      mimeType: "image/png",
    });

    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reason).toContain("OCR");
    }
  });

  it("reports an unmapped mime type as unsupported", async () => {
    const result = await extractDocumentContent({
      buffer: Buffer.from("plain text"),
      mimeType: "text/plain",
    });

    expect(result.kind).toBe("unsupported");
  });
});

describe("extractDocumentMetadata", () => {
  it("extracts flight numbers, dates, and booking references, each with evidence", async () => {
    const metadata = extractDocumentMetadata(
      await extractPdf([BOARDING_PASS_PAGE, INSURANCE_PAGE]),
    );

    expect(metadata.extraction).toMatchObject({
      method: "pdf-text",
      pageCount: 2,
      truncated: false,
    });
    expect(metadata.extraction.characterCount).toBeGreaterThan(0);

    expect(metadata.flightNumbers.map((fact) => fact.value)).toEqual(["ET602"]);
    expect(metadata.flightNumbers[0]?.evidence).toContain("ET602");

    expect([...metadata.dates.map((fact) => fact.value)].sort()).toEqual(
      ["12 Mar 2026", "2026-09-10", "2026-10-01"].sort(),
    );

    expect([...metadata.bookingReferences.map((fact) => fact.value)].sort()).toEqual([
      "ABC123",
      "XYZ789",
    ]);
    expect(metadata.bookingReferences.find((fact) => fact.value === "ABC123")?.evidence).toContain(
      "ABC123",
    );
  });

  it("does not mistake currency amounts for flight numbers", async () => {
    const metadata = extractDocumentMetadata(
      await extractPdf(["Total paid: USD 100 for the hotel and EUR 250 for the tour."]),
    );

    expect(metadata.flightNumbers).toEqual([]);
  });

  it("rejects 6-letter uppercase words as booking references (no digit in them)", async () => {
    const metadata = extractDocumentMetadata(
      await extractPdf(["Hotel confirmation for LONDON follows this letter."]),
    );

    expect(metadata.bookingReferences).toEqual([]);
  });

  it("does not double-report a flight number as a booking reference", async () => {
    const metadata = extractDocumentMetadata(
      await extractPdf(["Booking reference ET602 was copied from the wrong section."]),
    );

    expect(metadata.flightNumbers.map((fact) => fact.value)).toEqual(["ET602"]);
    expect(metadata.bookingReferences).toEqual([]);
  });

  it("canonicalizes spaced and unspaced flight number spellings to one fact", async () => {
    const metadata = extractDocumentMetadata(
      await extractPdf(["Flight ET 602 and later ET602 both operate this route."]),
    );

    expect(metadata.flightNumbers.map((fact) => fact.value)).toEqual(["ET602"]);
  });
});

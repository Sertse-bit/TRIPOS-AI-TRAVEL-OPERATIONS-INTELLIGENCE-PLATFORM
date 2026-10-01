import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHUNKING,
  chunkDocumentText,
  estimateTokenCount,
} from "@/modules/trip/document-chunking";

function buildLongText(paragraphs: number, wordsPerParagraph = 80): string {
  return Array.from({ length: paragraphs }, (_, p) => {
    const words = Array.from({ length: wordsPerParagraph }, (_, w) =>
      `word${p}-${w}`.toLowerCase(),
    );
    return words.join(" ");
  }).join("\n\n");
}

describe("chunkDocumentText", () => {
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkDocumentText("")).toEqual([]);
    expect(chunkDocumentText("   \n\n  \t ")).toEqual([]);
  });

  it("keeps a short document as a single chunk with an estimated token count", () => {
    const chunks = chunkDocumentText("Boarding pass for flight ET602.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toBe("Boarding pass for flight ET602.");
    expect(chunks[0].tokenCount).toBe(estimateTokenCount(chunks[0].content));
  });

  it("splits a long document into several chunks that respect the size cap", () => {
    const chunks = chunkDocumentText(buildLongText(12), DEFAULT_CHUNKING);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_CHUNKING.maxChars);
    }
  });

  it("numbers chunks sequentially from zero", () => {
    const chunks = chunkDocumentText(buildLongText(12), DEFAULT_CHUNKING);

    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, i) => i));
  });

  it("carries an overlap tail into the next chunk so boundary sentences survive", () => {
    const chunks = chunkDocumentText(buildLongText(12), DEFAULT_CHUNKING);

    expect(chunks.length).toBeGreaterThan(1);
    // Some trailing text of chunk N reappears at the start of chunk N+1.
    const firstTail = chunks[0].content.slice(-DEFAULT_CHUNKING.overlapChars / 2);
    const firstTailWords = firstTail.split(/\s+/).filter(Boolean).slice(1, 4);
    expect(firstTailWords.length).toBeGreaterThan(0);
    expect(chunks[1].content).toContain(firstTailWords[0]);
  });

  it("is deterministic: the same text always produces identical chunks", () => {
    const text = buildLongText(8);

    expect(chunkDocumentText(text)).toEqual(chunkDocumentText(text));
  });

  it("preserves paragraph and sentence structure rather than cutting mid-word", () => {
    const text =
      "First paragraph mentions a hotel in Porto.\n\n" +
      "Second paragraph mentions flight ET602 from Addis Ababa.";

    const chunks = chunkDocumentText(text, { targetChars: 40, maxChars: 60, overlapChars: 10 });

    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/\b(paragr|men|Abab)\b(?![a-z])/);
    }
  });

  it("hard-splits a single unbroken run of characters that exceeds the cap", () => {
    const chunks = chunkDocumentText("A".repeat(300), {
      targetChars: 100,
      maxChars: 120,
      overlapChars: 10,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(120);
    }
    // Nothing but the original characters and chunk separators survives.
    const rebuilt = chunks.map((chunk) => chunk.content).join("");
    expect(rebuilt.replace(/[A\s]/g, "")).toBe("");
  });

  it("rejects nonsensical chunking options instead of silently misbehaving", () => {
    expect(() => chunkDocumentText("text", { targetChars: 0 })).toThrow();
    expect(() => chunkDocumentText("text", { maxChars: 0 })).toThrow();
    expect(() => chunkDocumentText("text", { overlapChars: -1 })).toThrow();
    expect(() => chunkDocumentText("text", { overlapChars: 50, maxChars: 50 })).toThrow();
  });

  it("normalizes line endings and repeated blank lines", () => {
    const chunks = chunkDocumentText("Line one\r\nLine two\r\n\r\n\r\n\r\nLine three");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Line one\nLine two\n\nLine three");
  });
});

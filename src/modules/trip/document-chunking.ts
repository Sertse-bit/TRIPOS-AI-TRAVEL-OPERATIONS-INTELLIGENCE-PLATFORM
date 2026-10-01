/**
 * Deterministic document chunking for the Phase 15 RAG pipeline.
 *
 * Pure and dependency-free by design: chunk boundaries are part of what
 * gets stored and later retrieved, so they need to be reproducible and
 * unit-testable against exact expected output, not whatever a tokenizer
 * library happens to do this month.
 *
 * Strategy, in priority order — prefer the largest boundary that keeps a
 * chunk under the cap:
 *   1. paragraphs (blank line), then single newlines
 *   2. sentences (terminal punctuation)
 *   3. words, as a last resort for a single unbroken run of characters
 *
 * Consecutive chunks share an overlap tail so a sentence that straddles a
 * boundary is still retrievable from at least one chunk.
 */

export interface DocumentChunkDraft {
  /** Zero-based position within the document. */
  index: number;
  content: string;
  /**
   * Estimated tokens, ~4 characters per token. This is an estimate, not a
   * tokenizer count, and is only used for reporting and size sanity
   * checks — it never decides a boundary or a ranking.
   */
  tokenCount: number;
}

export interface ChunkingOptions {
  /** Preferred chunk size. */
  targetChars: number;
  /** Hard cap; a single unit larger than this gets hard-split. */
  maxChars: number;
  /** Overlap carried from the previous chunk into the next one. */
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = {
  targetChars: 1000,
  maxChars: 1400,
  overlapChars: 150,
};

const AVERAGE_CHARS_PER_TOKEN = 4;

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / AVERAGE_CHARS_PER_TOKEN);
}

/** Normalizes line endings and stray blank runs without altering words. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Splits into units that each fit the cap, preferring structural
 * boundaries and only ever hard-splitting what has no usable boundary.
 */
function toUnits(text: string, maxChars: number): string[] {
  const units: string[] = [];

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length === 0) continue;

    if (trimmedParagraph.length <= maxChars) {
      units.push(trimmedParagraph);
      continue;
    }

    // Too big for one chunk: try sentences, then newlines within it.
    for (const line of trimmedParagraph.split(/\n/)) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) continue;

      if (trimmedLine.length <= maxChars) {
        units.push(trimmedLine);
        continue;
      }

      const sentences = trimmedLine
        .split(/(?<=[.!?])\s+/)
        .flatMap((sentence) => splitOnWords(sentence, maxChars));

      units.push(...sentences);
    }
  }

  return units;
}

/** Last-resort split for text with no sentence or word boundary to use. */
function splitOnWords(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    // Snap back to the last space so we don't cut a word in half — unless
    // there is no space at all, in which case a hard cut is the only option.
    const lastSpace = window.lastIndexOf(" ");
    const cut = lastSpace > maxChars / 2 ? lastSpace : maxChars;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/**
 * Takes the tail of the previous chunk, snapped to a word boundary, so
 * the next chunk opens with real preceding context rather than starting
 * mid-thought.
 */
function overlapTail(content: string, overlapChars: number): string {
  if (overlapChars <= 0 || content.length <= overlapChars) return content;

  const tail = content.slice(content.length - overlapChars);
  const firstSpace = tail.indexOf(" ");
  if (firstSpace === -1) return tail;
  return tail.slice(firstSpace + 1);
}

export function chunkDocumentText(
  text: string,
  options: Partial<ChunkingOptions> = {},
): DocumentChunkDraft[] {
  const { targetChars, maxChars, overlapChars } = { ...DEFAULT_CHUNKING, ...options };

  if (targetChars <= 0 || maxChars <= 0) {
    throw new Error("Chunking sizes must be positive.");
  }
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("Chunking overlap must be non-negative and smaller than the maximum size.");
  }

  const normalized = normalize(text);
  if (normalized.length === 0) return [];

  const units = toUnits(normalized, maxChars);
  if (units.length === 0) return [];

  const drafts: DocumentChunkDraft[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;

    const content = current.join("\n\n").trim();
    if (content.length === 0) return;

    drafts.push({
      index: drafts.length,
      content,
      tokenCount: estimateTokenCount(content),
    });

    // Carry the tail forward so boundary-straddling sentences survive.
    const tail = overlapTail(content, overlapChars);
    current = tail.length > 0 ? [tail] : [];
    currentLength = tail.length;
  };

  for (const unit of units) {
    // Start a new chunk once the target size is reached. `current` may be
    // nothing but carried-over overlap at this point.
    if (current.length > 0 && currentLength + 2 + unit.length > targetChars) {
      flush();
    }

    // Enforce the hard cap on whatever is about to be appended: shrink
    // the carried overlap, or drop it entirely, so a near-cap unit can
    // never push a chunk past maxChars.
    if (current.length > 0 && currentLength + 2 + unit.length > maxChars) {
      const allowedOverlap = maxChars - unit.length - 2;
      if (allowedOverlap > 0) {
        const trimmed = overlapTail(current.join("\n\n"), Math.min(overlapChars, allowedOverlap));
        current = [trimmed];
        currentLength = trimmed.length;
      } else {
        current = [];
        currentLength = 0;
      }
    }

    current.push(unit);
    currentLength += unit.length + (current.length > 1 ? 2 : 0);
  }

  flush();

  return drafts;
}

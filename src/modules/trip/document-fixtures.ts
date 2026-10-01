/**
 * Test-only fixtures for the document pipeline. Not imported by
 * application code.
 *
 * The PDF builder constructs a genuinely valid file (catalog, pages,
 * font, content stream, byte-accurate xref table) from first principles
 * instead of checking in a binary blob or mocking the parser — so the
 * extraction tests exercise the real unpdf/pdf.js pipeline end to end
 * against real bytes.
 */

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * The page is deliberately wide (2000pt) with a small font: pdf.js clips
 * a text run at the page's right edge during extraction, so a standard
 * 612pt page silently truncates a paragraph of fixture text. Page
 * geometry is irrelevant to what these fixtures test — the parser and
 * the extraction pipeline — so making it roomy removes that artifact
 * rather than forcing every fixture string to be wrapped by hand.
 */
export function buildMinimalPdf(pageTexts: string[]): Buffer {
  if (pageTexts.length === 0) {
    throw new Error("A PDF needs at least one page.");
  }

  // Object plan: 1 = catalog, 2 = pages, 3 = font, then two objects per
  // page (page + content stream).
  const pageObjectIds = pageTexts.map((_, index) => 4 + index * 2);

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageTexts.length} /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  pageTexts.forEach((text, index) => {
    const contentObjectId = pageObjectIds[index] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );

    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/**
 * A real 1x1 PNG. `file-type` detects image/png from its signature, and
 * the document pipeline treats images as stored-but-not-extracted.
 */
export const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function makeMinimalPng(): Buffer {
  return Buffer.from(MINIMAL_PNG_BASE64, "base64");
}

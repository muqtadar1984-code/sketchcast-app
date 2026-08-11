/** Is this file really the Office template it claims to be?
 *
 * `<input accept=".docx">` is a dialog HINT, not a gate: the OS file picker lets
 * you switch to "All files", and mobile pickers routinely ignore `accept`
 * outright. On 2026-08-10 a teacher uploaded two JPEGs as their .docx and .pptx
 * letterheads — a natural mistake, they had an image of their letterhead — and
 * every document in their kit failed with PackageNotFoundError from python-docx.
 *
 * So check the BYTES. The stored filename said `.docx` and the recorded mimetype
 * said `image/jpeg`; neither is trustworthy, and neither is `File.type`, which
 * the browser guesses from the extension.
 *
 * The worker validates this too (worker/branding.py::_is_ooxml) and falls back
 * to the default style. That is the safety net. This is the part that tells the
 * teacher what went wrong while they can still fix it.
 */

export type OfficeKind = "docx" | "pptx";

export type OfficeCheck =
  | { ok: true }
  /** An OLE2 file — the pre-2007 .doc/.ppt format. Actionable: "Save As" fixes it. */
  | { ok: false; reason: "legacy" }
  /** A .pptx in the .docx slot, or vice versa. */
  | { ok: false; reason: "wrongType" }
  /** Anything else: an image, a PDF, a renamed zip. */
  | { ok: false; reason: "notOffice" };

/** Local file headers in a zip: "PK\x03\x04". Every OOXML file is a zip. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Compound File Binary — legacy .doc / .ppt / .xls. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/** Files bigger than this are not read whole; the magic-number check still runs.
 * A branding template is a few hundred KB — anything near this is not one. */
const MAX_FULL_READ = 32 * 1024 * 1024;

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** Zip stores entry names uncompressed in the local headers, so the archive's
 * file list is readable as plain bytes without unzipping anything. */
function asLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000; // stay under the argument limit of String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** Mimetypes that can never be an Office template, however they were stored.
 *
 * Used on READ, where downloading every template to inspect its bytes would tax
 * each dashboard load. This is a REJECT-KNOWN-BAD list, deliberately not an
 * accept-known-good one: a real .docx can legitimately arrive as
 * application/octet-stream or application/zip depending on the browser and
 * whether the upload's contentType was honoured, and hiding a teacher's valid
 * template is worse than showing a bad one — the worker degrades gracefully on
 * a bad template now, so a false positive here costs nothing.
 *
 * The 2026-08-10 case stored `image/jpeg`, which this catches.
 */
const IMPOSSIBLE_PREFIXES = ["image/", "video/", "audio/", "text/"];
const IMPOSSIBLE_EXACT = ["application/pdf"];

export function isPossiblyOfficeMimetype(mimetype: string | null | undefined): boolean {
  if (!mimetype) return true; // unknown — do not hide a template over missing metadata
  const m = mimetype.toLowerCase();
  if (IMPOSSIBLE_EXACT.includes(m)) return false;
  return !IMPOSSIBLE_PREFIXES.some((p) => m.startsWith(p));
}

export async function inspectOfficeFile(file: File, want: OfficeKind): Promise<OfficeCheck> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());

  if (startsWith(head, OLE2_MAGIC)) return { ok: false, reason: "legacy" };
  if (!startsWith(head, ZIP_MAGIC)) return { ok: false, reason: "notOffice" };

  // A zip, but is it an OOXML package? An empty or renamed .zip is not.
  if (file.size > MAX_FULL_READ) return { ok: true };
  const names = asLatin1(new Uint8Array(await file.arrayBuffer()));
  if (!names.includes("[Content_Types].xml")) return { ok: false, reason: "notOffice" };

  // Word packages carry word/document.xml; PowerPoint carries ppt/presentation.xml.
  const isDocx = names.includes("word/document.xml");
  const isPptx = names.includes("ppt/presentation.xml");
  if (want === "docx" && isPptx && !isDocx) return { ok: false, reason: "wrongType" };
  if (want === "pptx" && isDocx && !isPptx) return { ok: false, reason: "wrongType" };
  if (want === "docx" && !isDocx) return { ok: false, reason: "notOffice" };
  if (want === "pptx" && !isPptx) return { ok: false, reason: "notOffice" };

  return { ok: true };
}

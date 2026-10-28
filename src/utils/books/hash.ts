import { createHash } from "node:crypto";

// The engine's approval hash, byte for byte (publishing/tools/books_import.py
// canonical_sha): sha256 of
//   json.dumps({"sections": ..., "exercises": ...}, sort_keys=True, ensure_ascii=False)
// i.e. keys sorted at every level, separators ", " and ": ", non-ASCII kept as
// is. A Gate D approval made in the app must hash exactly like one made in the
// terminal, or the runner's check would call it a mismatch.

function pyString(s: string): string {
  // json.dumps escapes the same characters JSON.stringify does (\" \\ \b \f \n \r \t and \u00XX for other control
  // characters, lower-case hex) and, with ensure_ascii=False, leaves everything else, including U+2028/2029, as is.
  return JSON.stringify(s);
}

function pyNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`cannot hash a non-finite number: ${n}`);
  return String(n);
}

export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNumber(v);
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${pyString(k)}: ${pyJson((v as Record<string, unknown>)[k])}`).join(", ")}}`;
  }
  throw new Error(`cannot hash a ${typeof v}`);
}

/** The approval hash of a chapter's text: its sections and exercises, nothing else. */
export function canonicalSha(body: { sections: unknown; exercises: unknown }): string {
  return createHash("sha256").update(pyJson({ sections: body.sections, exercises: body.exercises }), "utf8").digest("hex");
}

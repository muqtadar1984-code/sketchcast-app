import "server-only";
import { readFile } from "node:fs/promises";
import { s3GetBytes } from "./files";
import { fixtureFileFor } from "./store";
import type { Artifact, Run } from "./types";
import type { BookEdit } from "./edits";

// The book's front matter in the workbench (founder 2026-10-30, phase 3c): the preface, the imprint's notice (the
// book's declaration) and the opening of "How this book works". The engine writes them; an editor's text, saved as a
// front_matter edit (0176), replaces a piece from the next compile on. What the last compile printed is its
// front-matter.json (worker: publishing/runner/compile.py).

export const FRONT_PIECES = [
  { unit: "preface", label: "Preface" },
  { unit: "imprint", label: "Declaration" },
  { unit: "about", label: "How this book works" },
] as const;
export type FrontUnit = (typeof FRONT_PIECES)[number]["unit"];
export type FrontPiece = { unit: FrontUnit; label: string; printed: string | null; text: string | null; edit: { id: number; by: string; at: string } | null };

// The engine's own texts (publishing/manuscript/book.py IMPRINT_NOTE / ABOUT_INTRO), shown before a book's first
// compile with front matter. Keep in step with the engine; the compile's front-matter.json always wins.
const ENGINE: Record<FrontUnit, string | null> = {
  preface: null,
  imprint:
    "This is a working draft shared for review and discussion. It is not for sale or further distribution, and its text, pictures and page design will change before publication.",
  about: "Each chapter teaches one part of the curriculum, in short numbered sections, and ends with practice and answers.",
};

/** The book's written preface from its source set (rev2/preface.json), for books compiled before phase 3c. */
async function sourcePreface(slug: string): Promise<string | null> {
  try {
    const prefix = `books/${slug}/source/`;
    const manifest = JSON.parse(new TextDecoder().decode(await s3GetBytes(`${prefix}_manifest.json`))) as { files: { rel: string; key?: string }[] };
    const f = manifest.files.find((x) => x.rel.split("\\").join("/") === "rev2/preface.json");
    if (!f) return null;
    return (JSON.parse(new TextDecoder().decode(await s3GetBytes(f.key ?? prefix + f.rel))) as { preface?: string }).preface ?? null;
  } catch {
    return null;
  }
}

export function isFrontUnit(u: unknown): u is FrontUnit {
  return FRONT_PIECES.some((p) => p.unit === u);
}

/** The latest done compile's printed front matter, or null (no compile yet, or one from before phase 3c). */
async function printed(runs: Run[], artifacts: Artifact[]): Promise<Record<string, string> | null> {
  const compile = runs.filter((r) => r.stage_key === "compile_book" && r.status === "done").sort((a, b) => b.id - a.id)[0];
  const a = compile && artifacts.find((x) => x.rel_path === `runs/run-${compile.id}/front-matter.json`);
  if (!a?.storage_key) return null;
  try {
    const local = fixtureFileFor(a.storage_key);
    const raw = local ? await readFile(/*turbopackIgnore: true*/ local) : await s3GetBytes(a.storage_key);
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, string>;
  } catch {
    return null;
  }
}

/** Each piece: what the last compile printed, and the text the next compile will print (the latest accepted edit). */
export async function frontMatter(slug: string, runs: Run[], artifacts: Artifact[], edits: BookEdit[]): Promise<FrontPiece[]> {
  const was = (await printed(runs, artifacts)) ?? { ...ENGINE, preface: await sourcePreface(slug) };
  return FRONT_PIECES.map((p) => {
    const e = edits.filter((x) => x.kind === "front_matter" && x.unit === p.unit && x.status === "accepted").sort((a, b) => b.id - a.id)[0];
    return {
      unit: p.unit,
      label: p.label,
      printed: was[p.unit] ?? null,
      text: e?.after_text ?? was[p.unit] ?? null,
      edit: e ? { id: e.id, by: e.created_by, at: e.created_at } : null,
    };
  });
}

/** When the front matter last changed after a compile: the newest accepted front-matter edit, or null. */
export function frontChangedAt(edits: BookEdit[]): string | null {
  const at = edits.filter((e) => e.kind === "front_matter" && e.status === "accepted").map((e) => e.created_at).sort();
  return at.length ? at[at.length - 1] : null;
}

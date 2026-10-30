import type { ChapterRevision } from "./types";

// Applying reader edits to a chapter's text (phase 3a). Pure, so it is tested and shared by the server route. An
// edit names its unit ("s2.b3" = section s2, block 3; "x4" = exercise x4) and the exact passage it replaces; the
// passage is replaced once, inside that unit only. A passage that cannot be found there is reported, never guessed.

export type TextEdit = { id: number; unit: string | null; before_text: string | null; after_text: string | null };
type Body = ChapterRevision["body"];

function replaceOnce(node: unknown, before: string, after: string): [unknown, boolean] {
  if (typeof node === "string") {
    const i = node.indexOf(before);
    return i < 0 ? [node, false] : [node.slice(0, i) + after + node.slice(i + before.length), true];
  }
  if (Array.isArray(node)) {
    const out = [...node];
    for (let i = 0; i < out.length; i++) {
      const [v, hit] = replaceOnce(out[i], before, after);
      if (hit) {
        out[i] = v;
        return [out, true];
      }
    }
    return [node, false];
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      if (k === "ref" || k === "figure_ref" || k === "source_refs" || k === "type" || k === "xid") continue; // never rewrite ids
      const [v, hit] = replaceOnce(out[k], before, after);
      if (hit) {
        out[k] = v;
        return [out, true];
      }
    }
  }
  return [node, false];
}

/** The body with every edit applied, and the edits that could not be placed. */
export function applyEdits(body: Body, edits: TextEdit[]): { body: Body; failed: number[] } {
  let next: Body = { ...body, sections: body.sections.map((s) => ({ ...s, blocks: [...s.blocks] })), exercises: [...(body.exercises ?? [])] };
  const failed: number[] = [];
  for (const e of edits) {
    const before = e.before_text ?? "";
    const after = e.after_text ?? "";
    if (!e.unit || !before) {
      failed.push(e.id);
      continue;
    }
    const block = /^(.+)\.b(\d+)$/.exec(e.unit);
    let hit = false;
    if (block) {
      const s = next.sections.find((x) => x.sid === block[1]);
      const i = Number(block[2]);
      if (s && s.blocks[i]) {
        const [v, ok] = replaceOnce(s.blocks[i], before, after);
        if (ok) {
          s.blocks[i] = v as (typeof s.blocks)[number];
          hit = true;
        }
      }
    } else {
      const xi = next.exercises.findIndex((x) => x.xid === e.unit);
      if (xi >= 0) {
        const [v, ok] = replaceOnce(next.exercises[xi], before, after);
        if (ok) {
          next = { ...next, exercises: next.exercises.map((x, j) => (j === xi ? (v as (typeof next.exercises)[number]) : x)) };
          hit = true;
        }
      }
    }
    if (!hit) failed.push(e.id);
  }
  return { body: next, failed };
}

/** The next app revision key ("d3" after "d2"; "d1" after imported revisions). */
export function nextAppRevision(keys: string[]): string {
  const n = Math.max(0, ...keys.map((k) => Number(/^d(\d+)$/.exec(k)?.[1] ?? 0)));
  return `d${n + 1}`;
}

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

// Replacing a picture (phase 3b): the new picture gets its own ref, and EVERY place the chapter used the old ref
// (figure blocks, figure groups, exercise figures) points at it instead. The chapter's text therefore changes (so it
// needs Gate D again, like any edit), and the old picture's label anchors, which were measured on the old picture,
// no longer apply to it.
export type ImageEdit = { id: number; unit: string | null; meta: { key?: string; size?: [number, number] | null; caption?: string | null } | null };

export function imageRef(id: number): string {
  return `edit:img${id}`;
}

function swapRef(node: unknown, from: string, to: string): [unknown, number] {
  if (Array.isArray(node)) {
    let n = 0;
    const out = node.map((v) => {
      const [w, k] = swapRef(v, from, to);
      n += k;
      return w;
    });
    return [out, n];
  }
  if (node && typeof node === "object") {
    let n = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "ref" || k === "figure_ref") && v === from) {
        out[k] = to;
        n++;
      } else if (k === "figure_refs" && Array.isArray(v)) {
        out[k] = v.map((r) => (r === from ? (n++, to) : r));
      } else {
        const [w, c] = swapRef(v, from, to);
        out[k] = w;
        n += c;
      }
    }
    return [out, n];
  }
  return [node, 0];
}

/** The body with each picture replaced everywhere it is used, and the edits whose picture is no longer in the text. */
export function applyImageEdits(body: Body, edits: ImageEdit[]): { body: Body; failed: number[] } {
  let next = body;
  const failed: number[] = [];
  for (const e of edits) {
    const from = e.unit ?? "";
    const old = next.figures?.[from];
    if (!from || !e.meta?.key || !old) {
      failed.push(e.id);
      continue;
    }
    const to = imageRef(e.id);
    const [sections, a] = swapRef(next.sections, from, to);
    const [exercises, b] = swapRef(next.exercises ?? [], from, to);
    if (a + b === 0) {
      failed.push(e.id);
      continue;
    }
    const caption = e.meta.caption?.trim() || old.caption;
    next = {
      ...next,
      sections: sections as Body["sections"],
      exercises: exercises as Body["exercises"],
      figures: {
        ...next.figures,
        [to]: { store: "s3", path: e.meta.key, kind: old.kind, caption, labels: [], size: e.meta.size ?? null, credit: { note: "Picture replaced in the book app" } },
      },
    };
  }
  return { body: next, failed };
}

/** Every picture ref the chapter's text places (the row's figure_refs column). */
export function placedRefs(body: Body): string[] {
  const out = new Set<string>();
  for (const s of body.sections)
    for (const b of s.blocks as { type?: string; ref?: string; items?: unknown[] }[]) {
      if (b.type === "figure" && b.ref) out.add(b.ref);
      if (b.type === "figure_group") for (const it of b.items ?? []) if (it && typeof it === "object" && (it as { ref?: string }).ref) out.add((it as { ref: string }).ref);
    }
  for (const x of body.exercises ?? []) for (const r of [x.figure_ref, ...(x.figure_refs ?? [])]) if (r) out.add(r);
  return [...out];
}

/** Width and height of a PNG, JPEG or WebP from its first bytes; null when it is none of those. */
export function imageSize(b: Uint8Array): { type: "image/png" | "image/jpeg" | "image/webp"; size: [number, number] } | null {
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "image/png", size: [be32(16), be32(20)] };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", size: [be16(i + 7), be16(i + 5)] };
      i += 2 + be16(i + 2);
    }
    return null;
  }
  if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8X") return { type: "image/webp", size: [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))] };
    if (kind === "VP8 ") return { type: "image/webp", size: [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff] };
    if (kind === "VP8L") {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "image/webp", size: [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1] };
    }
  }
  return null;
}

import type { Block, ChapterBody, Exercise } from "./types";

// What changed in a chapter between two book revisions. Pure.
//
// Sections are matched by their sid; inside a section the blocks are aligned by
// a longest common subsequence over each block's CONTENT key (the same fields
// the engine's check_preserved locks), so an unchanged block is "same" wherever
// it moved to. A removed block followed by an added block of the same type is
// shown as one "changed" block with a word diff. Exercises are matched by xid.
// Picture references are compared on their own: a correction round once
// dropped 8 figures silently, so a lost picture is always called out.

const CONTENT_FIELDS = ["type", "text", "term", "wrong", "right", "answer", "problem", "steps", "items", "headers", "rows", "caption", "ref", "relations"] as const;

export function blockKey(b: Block): string {
  const o: Record<string, unknown> = {};
  for (const k of CONTENT_FIELDS) if (k in b) o[k] = (b as Record<string, unknown>)[k];
  return JSON.stringify(o);
}

export function blockText(b: Block): string {
  const parts: string[] = [];
  for (const k of ["term", "text", "wrong", "right", "problem", "answer", "caption"] as const) if (b[k]) parts.push(String(b[k]));
  for (const s of b.steps ?? []) parts.push(String(s));
  for (const i of b.items ?? []) parts.push(typeof i === "string" ? i : i.label ?? "");
  for (const r of b.rows ?? []) parts.push(r.join(" · "));
  return parts.join(" ").trim();
}

function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export type WordOp = { op: "same" | "add" | "del"; text: string };

/** Word-level diff; long passages fall back to a whole-block replace to keep the work bounded. */
export function wordDiff(a: string, b: string): WordOp[] {
  const x = a.split(/(\s+)/).filter(Boolean), y = b.split(/(\s+)/).filter(Boolean);
  if (x.length * y.length > 400_000) return [{ op: "del", text: a }, { op: "add", text: b }];
  const pairs = lcs(x, y, (p, q) => p === q);
  const out: WordOp[] = [];
  let i = 0, j = 0;
  const push = (op: WordOp["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  for (const [pi, pj] of [...pairs, [x.length, y.length] as [number, number]]) {
    while (i < pi) push("del", x[i++]);
    while (j < pj) push("add", y[j++]);
    if (pi < x.length) {
      push("same", x[pi]);
      i = pi + 1;
      j = pj + 1;
    }
  }
  return out;
}

export type BlockChange =
  | { op: "same"; block: Block }
  | { op: "added"; block: Block }
  | { op: "removed"; block: Block }
  | { op: "changed"; before: Block; after: Block; words: WordOp[] };

export type SectionChange = { sid: string; heading: string; headingBefore?: string; status: "same" | "changed" | "added" | "removed"; blocks: BlockChange[] };

export type ExerciseChange = { xid: string; status: "same" | "changed" | "added" | "removed"; before?: Exercise; after?: Exercise; words?: WordOp[] };

export type ChapterDiff = {
  sections: SectionChange[];
  exercises: ExerciseChange[];
  figuresAdded: string[];
  figuresRemoved: string[];
  counts: { blocksAdded: number; blocksRemoved: number; blocksChanged: number; exercisesChanged: number };
};

function diffBlocks(a: Block[], b: Block[]): BlockChange[] {
  const ka = a.map(blockKey), kb = b.map(blockKey);
  const pairs = lcs(ka, kb, (p, q) => p === q);
  const raw: BlockChange[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const dels: Block[] = [], adds: Block[] = [];
    while (i < pi) dels.push(a[i++]);
    while (j < pj) adds.push(b[j++]);
    // pair removed/added blocks of the same type, in order, as "changed"
    while (dels.length || adds.length) {
      const d = dels[0], ad = adds[0];
      if (d && ad && d.type === ad.type) {
        raw.push({ op: "changed", before: d, after: ad, words: wordDiff(blockText(d), blockText(ad)) });
        dels.shift();
        adds.shift();
      } else if (d) raw.push({ op: "removed", block: dels.shift()! });
      else raw.push({ op: "added", block: adds.shift()! });
    }
    if (pi < a.length) {
      raw.push({ op: "same", block: b[pj] });
      i = pi + 1;
      j = pj + 1;
    }
  }
  return raw;
}

function exerciseText(x: Exercise): string {
  return [x.stem, ...(x.options ?? []), ...(x.pairs ?? []).map((p) => `${p.left} → ${p.right}`), x.answer, ...(x.marking_scheme ?? []).map((m) => m.point)]
    .filter(Boolean)
    .join(" ");
}

export function figureRefs(body: ChapterBody): string[] {
  const refs = new Set<string>();
  for (const s of body.sections ?? [])
    for (const b of s.blocks ?? []) {
      if (b.ref) refs.add(b.ref);
      for (const i of b.items ?? []) if (typeof i === "object" && i?.ref) refs.add(i.ref);
    }
  for (const x of body.exercises ?? []) for (const r of [x.figure_ref, ...(x.figure_refs ?? [])]) if (r) refs.add(r);
  return [...refs].sort();
}

export function diffChapter(before: ChapterBody, after: ChapterBody): ChapterDiff {
  const sections: SectionChange[] = [];
  const beforeBySid = new Map((before.sections ?? []).map((s) => [s.sid, s]));
  const seen = new Set<string>();
  for (const s of after.sections ?? []) {
    seen.add(s.sid);
    const old = beforeBySid.get(s.sid);
    if (!old) {
      sections.push({ sid: s.sid, heading: s.heading, status: "added", blocks: s.blocks.map((block) => ({ op: "added", block })) });
      continue;
    }
    const blocks = diffBlocks(old.blocks ?? [], s.blocks ?? []);
    const changed = old.heading !== s.heading || blocks.some((c) => c.op !== "same");
    sections.push({ sid: s.sid, heading: s.heading, headingBefore: old.heading !== s.heading ? old.heading : undefined, status: changed ? "changed" : "same", blocks });
  }
  for (const s of before.sections ?? [])
    if (!seen.has(s.sid)) sections.push({ sid: s.sid, heading: s.heading, status: "removed", blocks: s.blocks.map((block) => ({ op: "removed", block })) });

  const exercises: ExerciseChange[] = [];
  const oldX = new Map((before.exercises ?? []).map((x) => [x.xid, x]));
  const seenX = new Set<string>();
  for (const x of after.exercises ?? []) {
    seenX.add(x.xid);
    const o = oldX.get(x.xid);
    if (!o) exercises.push({ xid: x.xid, status: "added", after: x });
    else if (JSON.stringify(o) === JSON.stringify(x)) exercises.push({ xid: x.xid, status: "same", after: x });
    else exercises.push({ xid: x.xid, status: "changed", before: o, after: x, words: wordDiff(exerciseText(o), exerciseText(x)) });
  }
  for (const x of before.exercises ?? []) if (!seenX.has(x.xid)) exercises.push({ xid: x.xid, status: "removed", before: x });

  const fa = new Set(figureRefs(before)), fb = new Set(figureRefs(after));
  const all = sections.flatMap((s) => s.blocks);
  return {
    sections,
    exercises,
    figuresAdded: [...fb].filter((r) => !fa.has(r)),
    figuresRemoved: [...fa].filter((r) => !fb.has(r)),
    counts: {
      blocksAdded: all.filter((c) => c.op === "added").length,
      blocksRemoved: all.filter((c) => c.op === "removed").length,
      blocksChanged: all.filter((c) => c.op === "changed").length,
      exercisesChanged: exercises.filter((x) => x.status !== "same").length,
    },
  };
}

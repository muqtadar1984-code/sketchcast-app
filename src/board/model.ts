// The roll: the board's data model, and the only thing in src/board/ that every
// other module depends on.
//
// PAPER ON A ROLL, NOT AN INFINITE CANVAS. The board runs vertically and is
// quantised into pages of a fixed logical size. That is a product decision with
// three engineering dividends: one page is one screen, one 16:9 video frame and
// one landscape PDF page — the same rectangle three times over — so export needs
// no layout pass, there is no zoom UI to teach, and redraw cost is bounded by a
// page rather than by however long the lesson ran.
//
// COORDINATES ARE PAGE UNITS, NEVER PIXELS. A stroke drawn on a 1080p panel has
// to render on a laptop, export to PDF, and reappear on a student's phone. Pixels
// would bake one device into the record. Everything here is in the 1600x900 space
// and renderers project it; the same discipline the ERE engine already applies to
// teaching objects (src/ere/scene/types.ts), for the same reason.
//
// UNDO IS A TOMBSTONE. Nothing is ever removed from `strokes`. A voided stroke
// stays in order and stops rendering, which is what makes undo/redo a flag flip,
// keeps the append-only server log the fold of the same sequence, and means a
// sync that replays events can never resurrect something the teacher removed.
// The credit ledger elsewhere in this app is built on the same rule.
//
// PURE. No DOM, no React, no app imports — this module must survive the move to
// the standalone board SPA, and it must unit-test in node.

// ── the page ─────────────────────────────────────────────────────────────────

/** One page of the roll, in logical units. 16:9 — a screen, a video frame, a
 *  landscape PDF page. */
export const PAGE_W = 1600;
export const PAGE_H = 900;
export const PAGE_ASPECT = PAGE_W / PAGE_H;

export type Tool = "pen" | "highlighter" | "eraser";

/** What sits UNDER the ink on a page. `src` is a blob/object URL or a storage
 *  path — the model does not care which, and deliberately holds no opinion about
 *  how a host fetches it. */
export type PageBackground =
  | { kind: "blank" }
  | { kind: "frame"; src: string; generationId?: string; t?: number }
  | { kind: "question"; generationId: string; questionId: string; prompt: string; marks?: number }
  | { kind: "svg"; svg: string };

export type Page = {
  /** Position in the roll, 0-based and dense. */
  index: number;
  background: PageBackground;
};

// ── the stroke ───────────────────────────────────────────────────────────────

/**
 * One continuous mark.
 *
 * `pts` is FLAT — [x, y, w, x, y, w, …] — not an array of objects. A 40-minute
 * lesson is on the order of a thousand strokes of a few hundred points; as
 * objects that is a per-point allocation on the pointer path and roughly three
 * times the JSON over the wire. The triple is the unit; a length that is not a
 * multiple of 3 is a corrupt stroke, and `deserialise` refuses it.
 *
 * THE THIRD VALUE IS A WIDTH MULTIPLIER, NOT RAW PRESSURE. It is resolved at
 * CAPTURE time — from real pressure on a device that has it, from velocity on
 * one that does not (most panels report a constant 0.5 forever; see
 * capabilities.ts). Storing the raw signal instead would mean a roll drawn on a
 * pressure-less panel carries 0.5 at every point and can never be re-rendered as
 * it looked, and it would leave every renderer — screen, PDF, a student's phone —
 * needing to know which device drew it. Baking the multiplier makes the roll a
 * record of what was DRAWN rather than of what was pressed, and rendering is then
 * the same everywhere: `width * w`.
 */
export type Stroke = {
  id: string;
  /** Page index this stroke belongs to. A stroke never spans pages. */
  page: number;
  tool: Tool;
  /** CSS colour. The renderer applies the tool's blending, not the colour. */
  color: string;
  /** Base width in PAGE units; the ink pipeline modulates it per point. */
  width: number;
  pts: number[];
  /** Tombstoned by undo. Never delete — see the header. */
  voided?: boolean;
};

export type Roll = {
  version: 1;
  id: string;
  pages: Page[];
  /** Append-only and FLAT across pages, mirroring the server's stroke log.
   *  Order is authoritative: it is what undo and redo walk. */
  strokes: Stroke[];
};

export const ROLL_VERSION = 1 as const;

// ── construction ─────────────────────────────────────────────────────────────

/** A new roll with a single blank page. A roll always has at least one page —
 *  "no pages" is not a state the renderer or the exporter should have to hold. */
export function newRoll(id: string): Roll {
  return { version: ROLL_VERSION, id, pages: [{ index: 0, background: { kind: "blank" } }], strokes: [] };
}

/** Append a page and return its index. This is what "push the board up" does. */
export function addPage(roll: Roll, background: PageBackground = { kind: "blank" }): number {
  const index = roll.pages.length;
  roll.pages.push({ index, background });
  return index;
}

/** Replace a page's background — freezing a video frame onto the current page. */
export function setBackground(roll: Roll, page: number, background: PageBackground): void {
  const p = roll.pages[page];
  if (p) p.background = background;
}

export function addStroke(roll: Roll, stroke: Stroke): void {
  roll.strokes.push(stroke);
}

// ── points ───────────────────────────────────────────────────────────────────

export const pointCount = (s: Stroke): number => Math.floor(s.pts.length / 3);

export function pointAt(s: Stroke, i: number): { x: number; y: number; w: number } {
  const o = i * 3;
  return { x: s.pts[o], y: s.pts[o + 1], w: s.pts[o + 2] };
}

/** Bounding box in PAGE units, already grown by the stroke's own width so a
 *  caller can use it as a dirty rect without remembering to inflate it — the
 *  kind of off-by-a-line-width that leaves a smear on screen. Null for a stroke
 *  with no points. */
export function strokeBounds(
  s: Stroke,
  pad = 0,
): { x: number; y: number; w: number; h: number } | null {
  const n = pointCount(s);
  if (!n) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const x = s.pts[o];
    const y = s.pts[o + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Half the width each side, plus whatever the caller asked for (antialiasing,
  // a highlighter's spread).
  const grow = s.width / 2 + pad;
  return { x: minX - grow, y: minY - grow, w: maxX - minX + grow * 2, h: maxY - minY + grow * 2 };
}

// ── what renders ─────────────────────────────────────────────────────────────

/** The live strokes of one page, in draw order. Voided strokes are skipped, not
 *  removed, so the caller never has to know undo exists. */
export function pageStrokes(roll: Roll, page: number): Stroke[] {
  return roll.strokes.filter((s) => s.page === page && !s.voided);
}

// ── undo / redo ──────────────────────────────────────────────────────────────

/**
 * Void the most recent live stroke, optionally scoped to one page. The
 * primitive; `History` below is what a UI should use.
 *
 * SCOPED TO A PAGE ON PURPOSE. She writes on page 4, scrolls back to page 2 to
 * add a note, and presses undo. Unscoped, that would silently remove the last
 * thing she wrote on page 4 — a change she cannot see, on a screen she is not
 * looking at. Returns the stroke it voided, or null.
 */
export function voidLast(roll: Roll, page?: number): Stroke | null {
  for (let i = roll.strokes.length - 1; i >= 0; i--) {
    const s = roll.strokes[i];
    if (s.voided) continue;
    if (page !== undefined && s.page !== page) continue;
    s.voided = true;
    return s;
  }
  return null;
}

/**
 * Undo and redo, with the stack that makes redo mean anything.
 *
 * REDO CANNOT BE DERIVED FROM THE STROKE LIST, which is what the first version
 * of this file tried. Scanning for "the last voided stroke" finds the one
 * latest in APPEND order, not the one most recently voided — so undoing c then
 * b and pressing redo brought back c, silently leaving b voided and putting the
 * board in a state no sequence of her actions could have produced. Void order
 * is a separate fact from append order and has to be kept separately.
 *
 * The stack is deliberately NOT part of `Roll` and never serialised. Redo does
 * not survive a reload in any editor worth copying, and keeping it out means the
 * roll stays plain data that compares equal after a round trip.
 */
export class History {
  private stack: Stroke[] = [];

  undo(roll: Roll, page?: number): Stroke | null {
    const s = voidLast(roll, page);
    if (s) this.stack.push(s);
    return s;
  }

  /** Un-void the most recently undone stroke, scoped the same way as undo(). */
  redo(roll: Roll, page?: number): Stroke | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (page !== undefined && s.page !== page) continue;
      this.stack.splice(i, 1);
      s.voided = false;
      return s;
    }
    return null;
  }

  /**
   * Drawing clears the redo stack — the standard rule, and it is load-bearing
   * here rather than a nicety. Without it: undo a stroke, write something else,
   * press redo, and a stroke from before the new one reappears UNDERNEATH it.
   * The tombstone stays tombstoned; it simply stops being reachable.
   */
  clear(): void {
    this.stack.length = 0;
  }

  /** How many strokes are waiting to be redone. For enabling the button. */
  get depth(): number {
    return this.stack.length;
  }
}

// ── serialisation ────────────────────────────────────────────────────────────

/**
 * A roll as JSON.
 *
 * Key order is fixed rather than left to object-literal order, because two
 * exports of the same board have to be byte-identical — that is a Phase 1 gate,
 * and it is also what lets a sync cheaply tell "changed" from "re-serialised".
 */
export function serialise(roll: Roll): string {
  return JSON.stringify({
    version: roll.version,
    id: roll.id,
    pages: roll.pages.map((p) => ({ index: p.index, background: p.background })),
    strokes: roll.strokes.map((s) => {
      const out: Record<string, unknown> = {
        id: s.id,
        page: s.page,
        tool: s.tool,
        color: s.color,
        width: s.width,
        pts: s.pts,
      };
      // Omitted when false so an untouched roll does not grow a field per stroke.
      if (s.voided) out.voided = true;
      return out;
    }),
  });
}

export type ParseResult = { ok: true; roll: Roll } | { ok: false; error: string };

const TOOLS: ReadonlySet<string> = new Set<Tool>(["pen", "highlighter", "eraser"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function parseBackground(v: unknown): PageBackground | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case "blank":
      return { kind: "blank" };
    case "frame":
      return typeof v.src === "string"
        ? {
            kind: "frame",
            src: v.src,
            ...(typeof v.generationId === "string" ? { generationId: v.generationId } : {}),
            ...(typeof v.t === "number" ? { t: v.t } : {}),
          }
        : null;
    case "question":
      return typeof v.generationId === "string" &&
        typeof v.questionId === "string" &&
        typeof v.prompt === "string"
        ? {
            kind: "question",
            generationId: v.generationId,
            questionId: v.questionId,
            prompt: v.prompt,
            ...(typeof v.marks === "number" ? { marks: v.marks } : {}),
          }
        : null;
    case "svg":
      return typeof v.svg === "string" ? { kind: "svg", svg: v.svg } : null;
    default:
      return null;
  }
}

/**
 * Parse a roll, refusing anything it cannot fully understand.
 *
 * THIS RETURNS A RESULT RATHER THAN THROWING, and it is strict rather than
 * lenient, because of where it runs: a teacher reopening a lesson mid-period.
 * A roll that half-loads is worse than one that refuses — she can start a fresh
 * board in three seconds, but she cannot tell that page 6 is quietly missing
 * half its annotations. An unknown `version` is refused outright instead of
 * being read as if it were version 1: a future writer is allowed to change what
 * the fields mean, and guessing is how that becomes silent corruption.
 */
export function deserialise(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isObj(raw)) return { ok: false, error: "not an object" };
  if (raw.version !== ROLL_VERSION) return { ok: false, error: `unsupported version ${String(raw.version)}` };
  if (typeof raw.id !== "string") return { ok: false, error: "missing id" };
  if (!Array.isArray(raw.pages) || !raw.pages.length) return { ok: false, error: "no pages" };
  if (!Array.isArray(raw.strokes)) return { ok: false, error: "no strokes array" };

  const pages: Page[] = [];
  for (let i = 0; i < raw.pages.length; i++) {
    const p = raw.pages[i];
    if (!isObj(p)) return { ok: false, error: `page ${i} is not an object` };
    // Dense and in order. A gap would silently shift every later page's ink.
    if (p.index !== i) return { ok: false, error: `page ${i} has index ${String(p.index)}` };
    const background = parseBackground(p.background);
    if (!background) return { ok: false, error: `page ${i} has an unreadable background` };
    pages.push({ index: i, background });
  }

  const strokes: Stroke[] = [];
  for (let i = 0; i < raw.strokes.length; i++) {
    const s = raw.strokes[i];
    if (!isObj(s)) return { ok: false, error: `stroke ${i} is not an object` };
    if (typeof s.id !== "string") return { ok: false, error: `stroke ${i} has no id` };
    if (typeof s.page !== "number" || s.page < 0 || s.page >= pages.length)
      return { ok: false, error: `stroke ${i} points at page ${String(s.page)}` };
    if (typeof s.tool !== "string" || !TOOLS.has(s.tool))
      return { ok: false, error: `stroke ${i} has tool ${String(s.tool)}` };
    if (typeof s.color !== "string") return { ok: false, error: `stroke ${i} has no colour` };
    if (typeof s.width !== "number" || !(s.width > 0))
      return { ok: false, error: `stroke ${i} has width ${String(s.width)}` };
    if (!Array.isArray(s.pts) || s.pts.length % 3 !== 0)
      return { ok: false, error: `stroke ${i} has a truncated point list` };
    if (s.pts.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)))
      return { ok: false, error: `stroke ${i} has a non-finite coordinate` };
    strokes.push({
      id: s.id,
      page: s.page,
      tool: s.tool as Tool,
      color: s.color,
      width: s.width,
      pts: s.pts as number[],
      ...(s.voided === true ? { voided: true } : {}),
    });
  }

  return { ok: true, roll: { version: ROLL_VERSION, id: raw.id, pages, strokes } };
}

// ── projection ───────────────────────────────────────────────────────────────

/** How a page maps onto a rectangle of screen. Uniform scale + centring, so ink
 *  never stretches when the panel is not exactly 16:9 — a distorted diagram is
 *  worse than a letterboxed one. */
export type Projection = { scale: number; offsetX: number; offsetY: number };

export function fitPage(boxW: number, boxH: number): Projection {
  const scale = Math.min(boxW / PAGE_W, boxH / PAGE_H);
  return {
    scale,
    offsetX: (boxW - PAGE_W * scale) / 2,
    offsetY: (boxH - PAGE_H * scale) / 2,
  };
}

/** Screen point -> page units. The inverse of what the renderer applies. */
export function toPage(px: number, py: number, proj: Projection): { x: number; y: number } {
  return { x: (px - proj.offsetX) / proj.scale, y: (py - proj.offsetY) / proj.scale };
}

/** Page units -> screen point. */
export function toScreen(x: number, y: number, proj: Projection): { x: number; y: number } {
  return { x: x * proj.scale + proj.offsetX, y: y * proj.scale + proj.offsetY };
}

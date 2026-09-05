import { defaultParams } from "./options-spec";
import { AUTO_VOICE, DEFAULT_STYLE } from "@/utils/narration";

// One lesson credit = the lesson plus its FREE document kit (0059). This
// builds the rows a single "Generate kit" click queues. The presentation row
// MUST stay first: the DB's docs-ride-with-their-lesson guard checks for an
// existing lesson row, and rows inserted earlier in the same statement are
// visible to the later rows' triggers — order is load-bearing.
//
// The slide deck (0103) is its own kind and rides free exactly like the
// documents: it is listed right after the lesson so the kit is still ONE
// insert with the lesson first. defaultParams("deck") is null, which spreads
// to nothing — the deck takes no options.
export const DOC_KINDS = ["deck", "lesson_plan", "activity", "worksheet", "exam_paper", "case_study"] as const;

// The kinds a STUDENT is handed — what every Assign control collects out of a
// kit: the lesson, the worksheet and the test paper (founder 2026-07-19), and
// since 2026-09-04 the slide deck too ("students get decks similar to
// worksheets"). The teacher plan, the class activities and the case study are
// teaching aids and never travel. Three Assign sites (the part card, the
// chapter row, the chapter row's per-part roll-up) used to each carry their
// own copy of this list; the deck was the kind that showed why one list is
// better than three.
export const STUDENT_KINDS = ["presentation", "deck", "worksheet", "exam_paper"] as const;

/** The generation ids an Assign control sends: the student kinds that have
 * FINISHED building. A queued or failed row has nothing to hand over yet; a
 * null slot is a kind the kit never had. The caller passes the slots in
 * STUDENT_KINDS order so the shares land in that order too. */
export function assignableIds(
  lessons: ReadonlyArray<{ id: string; status: string } | null | undefined>,
): string[] {
  return lessons
    .filter((l): l is { id: string; status: string } => !!l && l.status === "done")
    .map((l) => l.id);
}

/** One generations insert row — wide types so mixed batches unify cleanly. */
export type GenerationRow = {
  kind: string;
  book_id: string;
  owner_id: string;
  school_id: string | null;
  chapter_ref: string;
  params: Record<string, unknown>;
  status: string;
};

export function kitRows(opts: {
  bookId: string;
  schoolId: string | null;
  userId: string;
  chapterNum: number;
  part?: number | null;
  language?: string | null;
  narrationStyle?: string;
  ttsVoice?: string;
  batch?: boolean;
}): GenerationRow[] {
  const { bookId, schoolId, userId, chapterNum, part = null, language = null } = opts;
  const extra = {
    ...(part ? { part } : {}),
    ...(language ? { language } : {}),
    ...(opts.batch ? { batch: true } : {}),
  };
  const base = {
    book_id: bookId,
    owner_id: userId,
    school_id: schoolId,
    chapter_ref: String(chapterNum),
    status: "queued",
  };
  return [
    {
      ...base,
      kind: "presentation",
      params: {
        narration_style: opts.narrationStyle ?? DEFAULT_STYLE,
        // "auto": the worker resolves the voice per generation (language,
        // plan, active premium provider). A concrete default here would
        // freeze it at click time — see AUTO_VOICE.
        tts_voice: opts.ttsVoice ?? AUTO_VOICE,
        ...extra,
      },
    },
    ...DOC_KINDS.map((kind) => ({
      ...base,
      kind,
      params: { ...defaultParams(kind), ...extra },
    })),
  ];
}

/** The language a lesson was generated in — its row's params.language when
 *  the teacher picked one, else null (the worker then used books.language). */
export function lessonLanguageOf(
  lesson: { params: Record<string, unknown> | null } | null | undefined,
): string | null {
  const v = lesson?.params?.language;
  return typeof v === "string" && v ? v : null;
}

/**
 * Params for a deck (0103) queued from its own chip — the "+ Deck" add-back
 * or a failed deck's retry. The deck asks no options, but it must land in
 * the LESSON's language, not the book's: the worker resolves
 * `params.language or books.language`, and a lesson generated in another
 * language (the kit picker allows it) would otherwise get its add-back deck
 * in the book's language. So the row carries the unit's part and, when
 * known, a language — a retry keeps the failed row's own language (it was
 * right when queued), an add-back inherits the lesson's. Nothing else from
 * the failed row is copied: a stale junk-gate stamp or batch marker is not
 * the deck's to carry.
 */
export function deckParams(opts: {
  part?: number | null;
  lessonLanguage?: string | null;
  /** The failed row's params on a retry. */
  prior?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const { part = null, lessonLanguage = null, prior = null } = opts;
  const priorLang = typeof prior?.language === "string" && prior.language ? prior.language : null;
  const language = priorLang ?? lessonLanguage;
  const params = {
    ...(part ? { part } : {}),
    ...(language ? { language } : {}),
  };
  return Object.keys(params).length ? params : null;
}

/** The unit a generation belongs to — one book, one chapter, one part (a
 * chapter with no part map is its own single part, 1). The same key for a
 * lesson and for the deck that rides with it. */
export type UnitRow = { book_id: string | null; chapter_ref: string | null; params: { part?: unknown } | null };

export function unitKey(g: UnitRow): string {
  const part = g.params?.part;
  return `${g.book_id ?? ""}|${g.chapter_ref ?? ""}|${typeof part === "number" && part >= 1 ? part : 1}`;
}

/**
 * The units whose deck a STUDENT gets as its own row: every assigned
 * deck-kind generation (0103). A pre-0103 kit kept its deck embedded on the
 * presentation (deck_pptx artifacts on the lesson row); a chapter that has
 * BOTH — its lesson from before the deck kind, its deck re-queued since — must
 * offer the deck once, on the deck row, because only that row's link records
 * the download (the lesson row's embedded link records nothing). This mirrors
 * the adult Library's rule (lesson-card: `deckGen ? [] : legacyDecks`).
 */
export function assignedDeckUnits(
  gens: ReadonlyArray<UnitRow & { id: string; kind: string }>,
  assigned: (genId: string) => boolean,
): Set<string> {
  const units = new Set<string>();
  for (const g of gens) if (g.kind === "deck" && assigned(g.id)) units.add(unitKey(g));
  return units;
}

/** The deck links a student row shows: a presentation whose unit has an
 * assigned deck row shows NONE (that row carries the deck); every other row
 * keeps what it had. Pure — the caller signs only what survives. */
export function studentDeckLinks<T>(g: UnitRow & { kind: string }, deckUnits: ReadonlySet<string>, own: T[]): T[] {
  return g.kind === "presentation" && deckUnits.has(unitKey(g)) ? [] : own;
}

/** One queued kit: a chapter, or one PART of it. */
export type KitUnit = { chapterNum: number; part: number | null };

/**
 * The kits a "Generate all" run should queue, in the order it should queue them.
 *
 * Founder decision 2026-08-27: a chapter with a part map gets ONE KIT PER PART,
 * not one chapter-level kit. Before this, "Generate all" queued a single
 * chapter-level kit — one presentation that rendered as N video parts plus one
 * set of documents for the whole chapter — while the Library went on showing N
 * empty "Generate kit" rows underneath it. The same chapter was offered twice:
 * once as a block of Pt chips, once as a list of rows still asking for credits.
 * Sara hit exactly that on a 4-part Magnetism chapter.
 *
 * Order is chapter, then part within it, because the caller inserts one unit per
 * statement and claim_next_job takes jobs by created_at. Part 1 therefore builds
 * while the rest sit visibly queued, then part 2 starts — which is what a
 * teacher watching the Library expects to see.
 *
 * A chapter with no part map (or a single part) still queues one chapter-level
 * kit, with part null: there is no part row for it to fill.
 */
export function kitUnitsFor(chapters: { num: number; partCount: number }[]): KitUnit[] {
  return chapters.flatMap<KitUnit>((c) =>
    c.partCount > 1
      ? Array.from({ length: c.partCount }, (_, i): KitUnit => ({ chapterNum: c.num, part: i + 1 }))
      : [{ chapterNum: c.num, part: null }],
  );
}

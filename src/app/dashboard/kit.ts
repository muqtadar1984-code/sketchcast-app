import { defaultParams } from "./options-spec";
import { AUTO_VOICE, DEFAULT_STYLE } from "@/utils/narration";

// One lesson credit = the lesson plus its FREE document kit (0059). This
// builds the rows a single "Generate kit" click queues. The presentation row
// MUST stay first: the DB's docs-ride-with-their-lesson guard checks for an
// existing lesson row, and rows inserted earlier in the same statement are
// visible to the later rows' triggers — order is load-bearing.
export const DOC_KINDS = ["lesson_plan", "activity", "worksheet", "exam_paper", "case_study"] as const;

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

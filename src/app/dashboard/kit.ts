import { defaultParams } from "./options-modal";
import { DEFAULT_STYLE, defaultVoiceFor } from "@/utils/narration";

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
        tts_voice: opts.ttsVoice ?? defaultVoiceFor(language),
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

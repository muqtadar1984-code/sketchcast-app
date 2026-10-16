// Ready-made kits (catalogue Phase C) — the pure shaping behind /dashboard/kits.
//
// The page reads from two places and this module joins them:
//   * `public_catalogue()` (0128, anon-callable) — everything a visitor may
//     see: title, summary, subject, question count, YouTube ids, slug. The
//     same rows the marketing site builds sketchcast.app/topics from, so the
//     two surfaces can never disagree about WHICH kits exist.
//   * `catalogue_current_kits()` + `topic_kits` + `topics` (service role) —
//     the ids the public function deliberately withholds: the topic, the kit,
//     and each piece's generation id, which is what Unlock, Download and
//     Add-to-Library act on.
// Joined on (slug, language): slug is the public identity of a topic and the
// current-kit rule is per (topic, language).
//
// Nothing here touches a database; the page passes rows in and the tests pass
// rows in. Keep it that way.

/** A row of public_catalogue() — the subset this page uses. */
export type PublicRow = {
  slug: string;
  title: string;
  subject: string | null;
  summary: string | null;
  language: string;
  approved_at: string;
  videos: Array<{ part?: number; youtube_video_id?: string | null }> | null;
  question_count: number | null;
  has_online_assessment: boolean | null;
};

/** A row of catalogue_current_kits(). */
export type CurrentKitRow = { topic_id: string; language: string; topic_kit_id: string };

/** topics(id, slug). */
export type TopicRow = { id: string; slug: string | null };

/** topic_kits(id, presentation_generation_id, doc_generation_ids). */
export type TopicKitRow = {
  id: string;
  presentation_generation_id: string | null;
  doc_generation_ids: Record<string, string | null> | null;
};

/** catalogue_unlocks(topic_id, unlocked_at) for the viewer. */
export type UnlockRow = { topic_id: string; unlocked_at: string | null };

/** One downloadable or assignable piece of a kit, by GENERATION kind (the
 * library's own vocabulary — the same keys as library.kinds in the
 * dictionary, so labels need no map). */
export type KitPiece = { kind: string; generationId: string };

export type Kit = {
  topicId: string;
  kitId: string;
  slug: string;
  title: string;
  subject: string | null;
  summary: string | null;
  language: string;
  approvedAt: string;
  youtubeId: string | null;
  /** the presentation's generation — the video a kit without a YouTube id
   * (a translation, D5) plays from storage through /api/catalogue/file */
  videoGenerationId: string | null;
  questionCount: number;
  pieces: KitPiece[];
  unlocked: boolean;
};

/** Piece order on the card: how a teacher reads a kit — the lesson first,
 * then what they project, then what they hand out. A kind this list does not
 * know (a future document type) goes last rather than vanishing. */
export const PIECE_ORDER: readonly string[] = ["presentation", "deck", "lesson_plan", "activity", "worksheet", "quiz", "case_study", "question_bank"];

const pieceRank = (kind: string): number => {
  const i = PIECE_ORDER.indexOf(kind);
  return i === -1 ? PIECE_ORDER.length : i;
};

/** The kit's pieces from its topic_kits row: the presentation under its own
 * kind, then each document the kit actually holds (empty ids are "not built"
 * and are dropped — the worker writes "" for a piece that failed its gate). */
export function piecesOf(kit: TopicKitRow): KitPiece[] {
  const out: KitPiece[] = [];
  if (kit.presentation_generation_id) out.push({ kind: "presentation", generationId: kit.presentation_generation_id });
  for (const [kind, id] of Object.entries(kit.doc_generation_ids ?? {})) {
    if (typeof id === "string" && id) out.push({ kind, generationId: id });
  }
  return out.sort((a, b) => pieceRank(a.kind) - pieceRank(b.kind));
}

/** The pieces a teacher can ASSIGN once copied: everything a student may
 * receive. The plan is the teacher's own document and never goes to a
 * student (the Library makes the same exclusion); the printable question
 * bank is a teacher's reference too (Phase D). The online quiz (`quiz`, a
 * composed set with questions_json) IS assignable — that is what it is for. */
export const assignablePieces = (pieces: readonly KitPiece[]): KitPiece[] =>
  pieces.filter((p) => p.kind !== "lesson_plan" && p.kind !== "question_bank");

/** The first public video of a kit — Part 1 when the lesson has parts. */
const firstVideo = (videos: PublicRow["videos"]): string | null => {
  const sorted = [...(videos ?? [])].sort((a, b) => (a.part ?? 1) - (b.part ?? 1));
  return sorted.find((v) => !!v.youtube_video_id)?.youtube_video_id ?? null;
};

/**
 * Join the public rows with the private ids. A public row with no matching
 * current kit (or a current kit whose topic has no slug) is dropped: both are
 * the same inconsistency — a kit the visibility rule shows but we cannot act
 * on — and a card with no buttons is worse than no card. Newest first.
 */
export function buildKits(
  pub: readonly PublicRow[],
  current: readonly CurrentKitRow[],
  topics: readonly TopicRow[],
  kits: readonly TopicKitRow[],
  unlocks: readonly UnlockRow[],
): Kit[] {
  const slugOf = new Map(topics.filter((t) => !!t.slug).map((t) => [t.id, t.slug as string]));
  const kitById = new Map(kits.map((k) => [k.id, k]));
  const unlocked = new Set(unlocks.map((u) => u.topic_id));
  const byKey = new Map<string, { topicId: string; kit: TopicKitRow }>();
  for (const c of current) {
    const slug = slugOf.get(c.topic_id);
    const kit = kitById.get(c.topic_kit_id);
    if (slug && kit) byKey.set(`${slug}\u0000${c.language}`, { topicId: c.topic_id, kit });
  }
  const out: Kit[] = [];
  for (const p of pub) {
    const hit = byKey.get(`${p.slug}\u0000${p.language}`);
    if (!hit) continue;
    out.push({
      topicId: hit.topicId,
      kitId: hit.kit.id,
      slug: p.slug,
      title: p.title,
      subject: p.subject,
      summary: p.summary,
      language: p.language,
      approvedAt: p.approved_at,
      youtubeId: firstVideo(p.videos),
      videoGenerationId: hit.kit.presentation_generation_id ?? null,
      questionCount: p.question_count ?? 0,
      pieces: piecesOf(hit.kit),
      unlocked: unlocked.has(hit.topicId),
    });
  }
  return out.sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : a.approvedAt > b.approvedAt ? -1 : a.title.localeCompare(b.title)));
}

/** The languages the gallery holds, English first, then by code — the
 * language chips (Kit Translator T1). One language means no chips. */
export const languagesOf = (kits: readonly { language: string }[]): string[] =>
  [...new Set(kits.map((k) => k.language))].sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)));

/** my_catalogue_allowance() as the page reads it. `cap` null = unlimited. */
export type Allowance = {
  eligible: boolean;
  reason: string | null;
  tier: string;
  cap: number | null;
  used: number;
  resets_at: string;
};

/** Can this viewer unlock ANOTHER kit right now? Unlimited tiers always; a
 * capped tier while it has allowance left. The database re-decides on the
 * click (unlock_catalogue_kit) — this only chooses what the button says. */
export const canUnlockMore = (a: Allowance): boolean => a.eligible && (a.cap === null || a.used < a.cap);

/** Tiers whose next step is "talk to your school", not "see pricing". */
const SCHOOL_TIERS: ReadonlySet<string> = new Set(["school", "school_trial", "school_suspended", "school_expired", "staff"]);
export const showsUpgrade = (a: Allowance): boolean => a.cap !== null && !SCHOOL_TIERS.has(a.tier);

/** The public lesson page for a kit — where the video, article and question
 * count live for everyone. Locale-neutral: the marketing site redirects by
 * the visitor's language itself. */
export const PUBLIC_TOPICS_URL = "https://sketchcast.app/topics";
export const lessonPageUrl = (slug: string): string => `${PUBLIC_TOPICS_URL}/${encodeURIComponent(slug)}`;
export const youtubeUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** A `?topic=` slug from the signup carry-through, or null when absent or not
 * a slug (slugs are lower-case ASCII, digits and hyphens — anything else is
 * someone probing). */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const topicParam = (raw: string | string[] | undefined): string | null => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && SLUG.test(v) ? v : null;
};

// Pure logic for a topic's KIT (Phase 3 of the topic-catalogue plan): the kit
// status machine, the teacher-avatar alternation and voice pairing, the
// generations params a kit is inserted with, the curriculum header lines every
// catalogue document carries, the clip validator, artifact ordering and the
// per-kit progress summary. No I/O anywhere, so the kit route and the kit
// panel share one answer and the rules are unit-tested without a database —
// the same stance as status.ts and article.ts.
//
// Nothing here can produce an 'approved' or 'rejected' kit status: those are
// written by approve_topic_kit() / reject_topic_kit() (0115) and nowhere else
// (asserted by migration-0115-catalogue-kits.test.ts and
// catalogue-routes.test.ts).

import type { ChapterMark, ClipRow, KitRejectReason, KitStatus, PartPlanRow, TeacherAvatar, TopicKit, VoicePair } from "./types";

// ── Status ───────────────────────────────────────────────────────────────────

export const KIT_STATUSES = ["generating", "in_review", "approved", "rejected", "failed"] as const;

export function isKitStatus(s: unknown): s is KitStatus {
  return typeof s === "string" && (KIT_STATUSES as readonly string[]).includes(s);
}

export function kitStatusLabel(s: KitStatus | string): string {
  return String(s).replace(/_/g, " ");
}

export const KIT_REJECT_REASONS = ["factual", "grade_fit", "pacing", "visuals", "pronunciation", "translation", "other"] as const;

export function isKitRejectReason(s: unknown): s is KitRejectReason {
  return typeof s === "string" && (KIT_REJECT_REASONS as readonly string[]).includes(s);
}

export const KIT_REJECT_REASON_LABEL: Record<KitRejectReason, string> = {
  factual: "Factual error",
  grade_fit: "Wrong depth for the grade",
  pacing: "Pacing",
  visuals: "Visuals",
  pronunciation: "Pronunciation",
  translation: "Translation",
  other: "Other",
};

/** approve_topic_kit() accepts exactly this KIT state. Mirrored so the panel
 *  can hide the button instead of showing the RPC's 409. The topic and the
 *  article have their own rules (kitAcceptsApprove). */
export function canApproveKit(s: KitStatus | string): boolean {
  return s === "in_review";
}

/** reject_topic_kit(): a kit under review, or an approved one whose approval
 *  is being pulled (the RPC then reopens the topic to in_review). */
export function canRejectKit(s: KitStatus | string): boolean {
  return s === "in_review" || s === "approved";
}

/** The topic statuses approve_topic_kit() / reject_topic_kit() accept — the
 *  RPCs raise check_violation outside them (0115). */
export const KIT_APPROVE_TOPIC_STATUSES = ["in_review"] as const;
export const KIT_REJECT_TOPIC_STATUSES = ["in_review", "video_approved"] as const;

/** Retry re-inserts ONE failed kind. A kit that is still generating may have
 *  one failed piece while the others run, so both states accept it; a kit
 *  under review or beyond has nothing failed left to retry. */
export function canRetryKit(s: KitStatus | string): boolean {
  return s === "failed" || s === "generating";
}

/** Regenerate makes a NEW kit row (the old one stays as history) from a kit
 *  the reviewers have seen: under review, or rejected. A generating kit is
 *  retried, not regenerated; an approved one is un-approved (Reject) first,
 *  so the pulled approval is recorded with its reason. */
export function canRegenerateKit(s: KitStatus | string): boolean {
  return s === "in_review" || s === "rejected";
}

/** Clips are editable once the worker has finished writing them (they are
 *  merged by part while the presentation builds) — including on an approved
 *  kit, because the clips feed the YouTube description, not the video. */
export function canEditClips(s: KitStatus | string): boolean {
  return s === "in_review" || s === "approved" || s === "rejected" || s === "failed";
}

export const KIT_STATUS_TONE: Record<KitStatus, string> = {
  generating: "bg-[#EDE7FB] text-[#5B3FBF]",
  in_review: "bg-[#EDE7FB] text-[#5B3FBF]",
  approved: "bg-[#E6F6F2] text-[#0F7A68]",
  rejected: "bg-[#FFE9E3] text-[#B3401F]",
  failed: "bg-[#FFE9E3] text-[#B3401F]",
};

/** generations.status (job_status): queued | processing | done | error. */
export const GEN_STATUS_TONE: Record<string, string> = {
  queued: "bg-[#FFF1D6] text-[#9A6400]",
  processing: "bg-[#EDE7FB] text-[#5B3FBF]",
  done: "bg-[#E6F6F2] text-[#0F7A68]",
  error: "bg-[#FFE9E3] text-[#B3401F]",
};

// ── Kinds ────────────────────────────────────────────────────────────────────

/** The kinds the kit route inserts when a kit is made, presentation FIRST (the
 *  panel lists them in this order too). `lesson_plan` is deliberately absent:
 *  the WORKER inserts it after the presentation finishes, because the plan
 *  cites the clips the video produced (plan §1.7, decision 1). */
export const KIT_CREATION_KINDS = ["presentation", "activity", "case_study", "worksheet", "deck"] as const;

/** Every kind a kit references, in display order. */
export const KIT_KINDS = ["presentation", "deck", "lesson_plan", "activity", "case_study", "worksheet"] as const;
export type KitKind = (typeof KIT_KINDS)[number];

export function isKitKind(s: unknown): s is KitKind {
  return typeof s === "string" && (KIT_KINDS as readonly string[]).includes(s);
}

export const KIT_KIND_LABEL: Record<KitKind, string> = {
  presentation: "Video lesson",
  deck: "Slide deck",
  lesson_plan: "Lesson plan",
  activity: "Activities",
  case_study: "Case study",
  worksheet: "Worksheet",
};

/** Document kinds (everything but the video) — the keys of doc_generation_ids. */
export const KIT_DOC_KINDS = KIT_KINDS.filter((k) => k !== "presentation") as readonly Exclude<KitKind, "presentation">[];

/** Which generation a kit holds for a kind: the presentation column, or the
 *  doc_generation_ids entry. */
export function kitGenerationIdFor(kit: Pick<TopicKit, "presentation_generation_id" | "doc_generation_ids">, kind: string): string | null {
  if (kind === "presentation") return kit.presentation_generation_id ?? null;
  const v = kit.doc_generation_ids?.[kind];
  return typeof v === "string" && v ? v : null;
}

/** Every generation id a kit references, presentation first. */
export function kitGenerationIds(kit: Pick<TopicKit, "presentation_generation_id" | "doc_generation_ids">): string[] {
  const out: string[] = [];
  if (kit.presentation_generation_id) out.push(kit.presentation_generation_id);
  for (const kind of KIT_DOC_KINDS) {
    const id = kitGenerationIdFor(kit, kind);
    if (id && !out.includes(id)) out.push(id);
  }
  // kinds the worker may add that the display list does not know yet
  for (const v of Object.values(kit.doc_generation_ids ?? {})) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  return out;
}

/** The doc_generation_ids after (re)pointing one kind at a generation. */
export function docGenerationIdsWith(ids: Record<string, string> | null | undefined, kind: string, generationId: string): Record<string, string> {
  return { ...(ids ?? {}), [kind]: generationId };
}

// ── Accepting a Generate ─────────────────────────────────────────────────────

export type KitAcceptance = { ok: true } | { ok: false; why: string };

/** May a NEW kit be generated for this topic right now? The topic must be
 *  `article_approved` (a kit is the step after the article; anything later
 *  already has a kit and is regenerated from it), its English article must
 *  be `approved` (decision 13: the worker refuses anything else, this is the
 *  friendly form), and no kit may be generating. The wording is shared by
 *  the route's 409 and the panel's disabled button. */
export function kitAcceptsGenerate(topicStatus: string, articleStatus: string | null | undefined, liveKit: boolean): KitAcceptance {
  if (liveKit) return { ok: false, why: "A kit is already generating for this topic — wait for it, or retry its failed pieces." };
  if (topicStatus === "retired") return { ok: false, why: "This topic is retired; reopen it before generating a kit." };
  if (topicStatus === "candidate" || topicStatus === "approved") {
    return { ok: false, why: "Approve the article first — a kit is generated from an approved article." };
  }
  if (topicStatus === "generating") {
    // No live kit but the topic says generating: a piece failed (the worker
    // marks the kit failed and leaves the topic) — the fix is Retry, not a
    // second kit.
    return { ok: false, why: "The topic is generating — wait for the kit, or retry its failed piece from the kit panel." };
  }
  if (topicStatus !== "article_approved") {
    return { ok: false, why: "This topic already has a kit — regenerate it from the kit panel instead." };
  }
  if (articleStatus !== "approved") return { ok: false, why: "Approve the article first — a kit is generated from an approved article." };
  return { ok: true };
}

/** May THIS kit be approved right now? Three things must agree, and the RPC
 *  (0115 approve_topic_kit) checks the same three so the panel's disabled
 *  button and the 409 say one sentence:
 *    • the kit is in_review (canApproveKit);
 *    • the TOPIC is in_review — a kit Regenerate left behind at in_review
 *      while the topic went back to generating is history, not a candidate:
 *      approving it would leave two approved kits on one topic (the reviewer
 *      approves the newest kit, which is the one under review);
 *    • the kit's ARTICLE is still the approved version — the article is the
 *      kit's source of truth (plan §1.7); once a newer version is approved
 *      the video teaches superseded text and is regenerated, not approved. */
export function kitAcceptsApprove(topicStatus: string, kitStatus: string, articleStatus: string | null | undefined): KitAcceptance {
  if (!canApproveKit(kitStatus)) return { ok: false, why: `This kit is ${kitStatusLabel(kitStatus)}, not reviewable.` };
  if (!(KIT_APPROVE_TOPIC_STATUSES as readonly string[]).includes(topicStatus)) {
    return {
      ok: false,
      why:
        topicStatus === "generating"
          ? "The topic is generating a newer kit — this one is history; review the new kit when it arrives."
          : `The topic is ${topicStatus.replace(/_/g, " ")}, not in review — this kit is not the one under review.`,
    };
  }
  if (articleStatus !== "approved") {
    return {
      ok: false,
      why: articleStatus
        ? `The article this kit was built from is ${articleStatus.replace(/_/g, " ")}, not the approved version — regenerate the kit from the approved article instead.`
        : "The article this kit was built from no longer exists — regenerate the kit from the approved article.",
    };
  }
  return { ok: true };
}

/** May THIS kit be rejected (or its approval pulled)? The kit is in_review
 *  or approved (canRejectKit) and the topic is in_review or video_approved
 *  — the two states a reviewable kit puts it in. A kit left in_review by
 *  Regenerate while the topic generates is history: nothing to reject (the
 *  RPC refuses it too). */
export function kitAcceptsReject(topicStatus: string, kitStatus: string): KitAcceptance {
  if (!canRejectKit(kitStatus)) return { ok: false, why: `This kit is ${kitStatusLabel(kitStatus)}, not reviewable.` };
  if (!(KIT_REJECT_TOPIC_STATUSES as readonly string[]).includes(topicStatus)) {
    return {
      ok: false,
      why:
        topicStatus === "generating"
          ? "The topic is generating a newer kit — this one is history and is not reviewed."
          : `The topic is ${topicStatus.replace(/_/g, " ")} — a kit is rejected only while its topic is in review or video approved.`,
    };
  }
  return { ok: true };
}

/** May an existing kit be regenerated? The kit must be reviewable history
 *  (canRegenerateKit) and the topic back in review — Regenerate is the
 *  in_review → generating reopening of the topic status machine. */
export function kitAcceptsRegenerate(topicStatus: string, kitStatus: string, liveKit: boolean): KitAcceptance {
  if (!canRegenerateKit(kitStatus)) {
    return { ok: false, why: `A ${kitStatusLabel(kitStatus)} kit is not regenerated — ${kitStatus === "approved" ? "reject it first to pull the approval" : "retry its failed pieces instead"}.` };
  }
  if (liveKit) return { ok: false, why: "A kit is already generating for this topic." };
  if (topicStatus !== "in_review") {
    return { ok: false, why: `The topic is ${topicStatus.replace(/_/g, " ")} — reopen it to in review before regenerating the kit.` };
  }
  return { ok: true };
}

// ── Teacher avatar + voices ──────────────────────────────────────────────────

export const TEACHER_AVATAR_GENDERS = ["female", "male"] as const;

export function isTeacherAvatar(v: unknown): v is TeacherAvatar {
  return v === "female" || v === "male";
}

/** The default for the next kit: the gender used LESS across the topic's
 *  existing kits (so a regenerated topic alternates faces and voices), a tie
 *  — including no kits at all — going to female. Unknown / null avatars are
 *  not counted. */
export function nextTeacherAvatar(existingKits: readonly { teacher_avatar: string | null }[]): TeacherAvatar {
  let female = 0;
  let male = 0;
  for (const k of existingKits) {
    if (k.teacher_avatar === "female") female++;
    else if (k.teacher_avatar === "male") male++;
  }
  return male < female ? "male" : "female";
}

/** Registry ids (shared/tts/registry.py): the teacher speaks `g-<lang>-<f|m>`,
 *  the student the OTHER gender's `g-<lang>-student-<m|f>` — two clearly
 *  different voices make the dialogue followable with eyes closed (plan §1.6).
 *  Both premium Google; where a language has no student voice the WORKER
 *  falls back to the Edge student voice and records `student_voice_fallback`. */
export function voicePairFor(gender: TeacherAvatar, language: string): VoicePair {
  const lang = (language || "en").toLowerCase();
  const t = gender === "male" ? "m" : "f";
  const s = gender === "male" ? "f" : "m";
  return { teacher: `g-${lang}-${t}`, student: `g-${lang}-student-${s}` };
}

// ── Generations params ───────────────────────────────────────────────────────

export type KitGenerationParams = {
  catalogue: true;
  topic_id: string;
  kit_id: string;
  article_id: string;
  language: string;
  narration_style: "dialogue";
  teacher_avatar: TeacherAvatar;
  tts_voice: string;
  student_voice: string;
  curriculum_header: string[];
};

/** The params every generation of a kit carries (decision 1). `catalogue:
 *  true` is what 0112's guards and 0115's job trigger read; the worker's
 *  catalogue branch reads the rest. The same object goes on every kind so a
 *  retried piece is byte-identical to the one it replaces. */
export function kitGenerationParams(opts: {
  topicId: string;
  kitId: string;
  articleId: string;
  language: string;
  teacherAvatar: TeacherAvatar;
  curriculumHeader: readonly string[];
}): KitGenerationParams {
  const voices = voicePairFor(opts.teacherAvatar, opts.language);
  return {
    catalogue: true,
    topic_id: opts.topicId,
    kit_id: opts.kitId,
    article_id: opts.articleId,
    language: opts.language,
    narration_style: "dialogue",
    teacher_avatar: opts.teacherAvatar,
    tts_voice: voices.teacher,
    student_voice: voices.student,
    curriculum_header: [...opts.curriculumHeader],
  };
}

/** The keys of KitGenerationParams — what a kit piece is built FROM. Spelled
 *  as a list (not derived from a value) so retryParamsOf can whitelist. */
export const KIT_PARAM_KEYS = ["catalogue", "topic_id", "kit_id", "article_id", "language", "narration_style", "teacher_avatar", "tts_voice", "student_voice", "curriculum_header"] as const;

/** What the worker adds to the lesson_plan it inserts after the video
 *  (catalogue/kit.py insert_lesson_plan): the clips it cites and the
 *  three-mode flag. A retried lesson plan needs both. */
export const LESSON_PLAN_PARAM_KEYS = ["clips", "lesson_modes"] as const;

/** Marks a failed generation the portal has ALREADY retried (params.retried
 *  = true): the retry route takes the failed row exclusively by flipping
 *  this flag in a compare-and-swap before it inserts, so two operators
 *  clicking Retry on the same piece cannot both queue a build (a presentation
 *  is a whole video's worth of Vertex image calls — the never-starve
 *  capacity). Also the tell, in the history, that a row was replaced. */
export const RETRIED_KEY = "retried";

/** The params a RETRY re-inserts: the failed row's inputs and NOTHING else.
 *  The worker merges telemetry into a generation's params while it runs
 *  (tts_voice_used, student_voice_fallback, coverage… — process.py) and a
 *  presentation that fails after that point carries it; copying the row's
 *  params verbatim would start the new build with another run's telemetry
 *  and the retried flag. The worker's own lesson_plan insert whitelists the
 *  same way (_INHERITED_PARAMS); a lesson_plan keeps its clips and modes. */
export function retryParamsOf(params: Record<string, unknown>, kind: string): Record<string, unknown> {
  const keys: readonly string[] = kind === "lesson_plan" ? [...KIT_PARAM_KEYS, ...LESSON_PLAN_PARAM_KEYS] : KIT_PARAM_KEYS;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in params && params[k] !== undefined) out[k] = params[k];
  return out;
}

export type KitGenerationInsert = {
  kind: string;
  owner_id: string;
  book_id: null;
  chapter_ref: null;
  school_id: null;
  status: "queued";
  params: Record<string, unknown>;
};

/** The rows ONE Generate inserts, presentation first. book_id and chapter_ref
 *  are NULL on purpose: that is what makes the row a catalogue row to every
 *  0112-classified trigger (the exempted guards, and beta_generation_cap's
 *  one-tuple pass). `params` is typed loosely because a RETRY re-inserts a
 *  failed row's whitelisted params (retryParamsOf) — a lesson_plan's carry
 *  the clips and lesson_modes the worker added. */
export function kitGenerationRows(ownerId: string, params: KitGenerationParams | Record<string, unknown>, kinds: readonly string[] = KIT_CREATION_KINDS): KitGenerationInsert[] {
  return kinds.map((kind) => ({
    kind,
    owner_id: ownerId,
    book_id: null,
    chapter_ref: null,
    school_id: null,
    status: "queued",
    params,
  }));
}

// ── Curriculum header ────────────────────────────────────────────────────────

export type HeaderMapping = {
  curriculum: { id: string; code: string; name: string } | null;
  node: { code: string; title: string; grade: string | null } | null;
};

/** An objective-style code ("7Bs.01", "9.5.2") names the node on its own; a
 *  long or spaced code is an internal id and the title reads better. */
const shortCode = (code: string) => code.length <= 10 && !/\s/.test(code);

const numeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** One line per curriculum the topic is mapped to, for the header block every
 *  catalogue document carries (decision 10):
 *    "Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02"
 *    "CBSE Science 086 · Class 9 · Cell — the basic unit of life"
 *  Curricula in name order, nodes in code order (numeric), duplicates dropped;
 *  objective codes are listed as codes, chapter / unit nodes by title with the
 *  grade prefixed once when every listed node shares it. A mapping whose node
 *  or curriculum is gone contributes nothing. */
export function curriculumHeaderLines(mappings: readonly HeaderMapping[]): string[] {
  const byCurriculum = new Map<string, { curriculum: NonNullable<HeaderMapping["curriculum"]>; nodes: NonNullable<HeaderMapping["node"]>[] }>();
  for (const m of mappings) {
    if (!m.curriculum || !m.node) continue;
    const entry = byCurriculum.get(m.curriculum.id) ?? { curriculum: m.curriculum, nodes: [] };
    if (!entry.nodes.some((n) => n.code === m.node!.code)) entry.nodes.push(m.node);
    byCurriculum.set(m.curriculum.id, entry);
  }
  return [...byCurriculum.values()]
    .sort((a, b) => a.curriculum.name.localeCompare(b.curriculum.name) || a.curriculum.code.localeCompare(b.curriculum.code))
    .map(({ curriculum, nodes }) => {
      const sorted = [...nodes].sort((a, b) => numeric(a.code, b.code));
      const useCodes = sorted.every((n) => shortCode(n.code));
      const grades = new Set(sorted.map((n) => (n.grade ?? "").trim()).filter(Boolean));
      const items = [...new Set(sorted.map((n) => (useCodes ? n.code : n.title.trim() || n.code)))];
      const head = `${curriculum.name.trim()}${curriculum.code.trim() ? ` ${curriculum.code.trim()}` : ""}`;
      const grade = !useCodes && grades.size === 1 && sorted.every((n) => (n.grade ?? "").trim()) ? ` · ${[...grades][0]}` : "";
      return `${head}${grade} · ${items.join(", ")}`;
    });
}

// ── Clips ────────────────────────────────────────────────────────────────────

export const CLIP_LIMITS = {
  /** a human's clip may be shorter / longer than the worker's 120–240 s cut */
  minSeconds: 30,
  maxSeconds: 600,
  label: 80,
  purpose: 200,
  maxClips: 12,
} as const;

/** "mm:ss", "h:mm:ss" or a number of seconds → whole seconds, or null. */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec >= 60) return null;
  return h * 3600 + min * 60 + sec;
}

/** Seconds → "m:ss" (or "h:mm:ss" past an hour) for the chapter list and clip fields. */
export function fmtTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export type ClipValidation = { ok: true; clips: ClipRow[] } | { ok: false; errors: string[] };

/** The Save gate for a human-edited clip list. `partDurations` names every
 *  part the kit has (from part_plan) with its length in seconds, or null when
 *  the length is not known — a clip must sit inside a known part and, when
 *  the length is known, end within it. Start/end come as "mm:ss" or seconds;
 *  the stored row holds seconds. Sorted by (part, start) on the way out. */
export function validateClips(raw: unknown, partDurations: ReadonlyMap<number, number | null>): ClipValidation {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, errors: ["clips must be a list."] };
  if (raw.length > CLIP_LIMITS.maxClips) errors.push(`At most ${CLIP_LIMITS.maxClips} clips.`);
  const clips: ClipRow[] = [];
  raw.slice(0, CLIP_LIMITS.maxClips).forEach((item, i) => {
    const n = i + 1;
    if (!item || typeof item !== "object") {
      errors.push(`Clip ${n}: not an object.`);
      return;
    }
    const c = item as Record<string, unknown>;
    const part = typeof c.part === "number" ? c.part : typeof c.part === "string" && /^\d+$/.test(c.part) ? Number(c.part) : NaN;
    if (!Number.isInteger(part) || part < 1) errors.push(`Clip ${n}: part must be a positive whole number.`);
    else if (partDurations.size && !partDurations.has(part)) errors.push(`Clip ${n}: this kit has no part ${part}.`);
    const start = parseTimestamp(c.start);
    const end = parseTimestamp(c.end);
    if (start === null) errors.push(`Clip ${n}: start must be mm:ss.`);
    if (end === null) errors.push(`Clip ${n}: end must be mm:ss.`);
    if (start !== null && end !== null) {
      if (end <= start) errors.push(`Clip ${n}: end must be after start.`);
      else {
        const len = end - start;
        if (len < CLIP_LIMITS.minSeconds) errors.push(`Clip ${n}: at least ${CLIP_LIMITS.minSeconds} seconds long.`);
        if (len > CLIP_LIMITS.maxSeconds) errors.push(`Clip ${n}: at most ${CLIP_LIMITS.maxSeconds / 60} minutes long.`);
        const duration = Number.isInteger(part) ? partDurations.get(part) : undefined;
        if (typeof duration === "number" && end > duration) {
          errors.push(`Clip ${n}: ends at ${fmtTimestamp(end)} but part ${part} runs ${fmtTimestamp(duration)}.`);
        }
      }
    }
    const label = typeof c.label === "string" ? c.label.trim() : "";
    if (!label) errors.push(`Clip ${n}: a label is required.`);
    else if (label.length > CLIP_LIMITS.label) errors.push(`Clip ${n}: label longer than ${CLIP_LIMITS.label} characters.`);
    const purposeRaw = c.purpose;
    const purpose = typeof purposeRaw === "string" ? purposeRaw.trim() : "";
    if (purposeRaw !== undefined && purposeRaw !== null && typeof purposeRaw !== "string") errors.push(`Clip ${n}: purpose must be text.`);
    else if (purpose.length > CLIP_LIMITS.purpose) errors.push(`Clip ${n}: purpose longer than ${CLIP_LIMITS.purpose} characters.`);
    if (Number.isInteger(part) && start !== null && end !== null) {
      clips.push({ part, start, end, label, purpose: purpose || null });
    }
  });
  if (errors.length) return { ok: false, errors };
  clips.sort((a, b) => a.part - b.part || a.start - b.start);
  return { ok: true, clips };
}

/** part → seconds (whole minutes rounded UP, so a clip ending in the last
 *  partial minute of a 17.3-minute part is not refused) from the worker's
 *  part_plan; a part with no usable minutes is known with an unknown length. */
export function partDurationsOf(plan: readonly PartPlanRow[] | null | undefined): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const p of plan ?? []) {
    if (!p || !Number.isInteger(p.part) || p.part < 1) continue;
    const minutes = typeof p.minutes === "number" && Number.isFinite(p.minutes) && p.minutes > 0 ? p.minutes : null;
    out.set(p.part, minutes === null ? null : Math.ceil(minutes) * 60);
  }
  return out;
}

/** Chapter marks grouped by part, each part's marks in time order. Tolerant
 *  of a mark with no part (read as part 1) — the worker merges by part, the
 *  portal only displays. */
export function chaptersByPart(marks: readonly Partial<ChapterMark>[] | null | undefined): Map<number, ChapterMark[]> {
  const out = new Map<number, ChapterMark[]>();
  for (const m of marks ?? []) {
    if (!m || typeof m.t !== "number" || !Number.isFinite(m.t)) continue;
    const part = Number.isInteger(m.part) && (m.part as number) >= 1 ? (m.part as number) : 1;
    const list = out.get(part) ?? [];
    list.push({ part, t: m.t, label: typeof m.label === "string" ? m.label : "", section_id: typeof m.section_id === "string" ? m.section_id : null });
    out.set(part, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.t - b.t);
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

// ── Artifacts ────────────────────────────────────────────────────────────────

/** lesson.mp4 is part 1; lesson_part2.mp4, lesson_part3.mp4 follow. */
export function videoPartOf(path: string): number {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
}

/** BY EXTRACTED PART NUMBER, never by path string: ICU collation sorts "."
 *  after "_", so a plain sort puts lesson.mp4 (Part 1) behind lesson_part2.mp4
 *  (the dashboard and the Present route both learned this). Stable for ties. */
export function sortVideoArtifacts<T extends string | { storage_path: string }>(items: readonly T[]): T[] {
  const pathOf = (x: T) => (typeof x === "string" ? x : x.storage_path);
  return items
    .map((x, i) => ({ x, i, part: videoPartOf(pathOf(x)) }))
    .sort((a, b) => a.part - b.part || a.i - b.i)
    .map((e) => e.x);
}

// ── Progress ─────────────────────────────────────────────────────────────────

export type KitProgress = { total: number; done: number; failed: number; live: number; pct: number; label: string };

/** One line for the kit header: "3/6 done · 1 failed · 2 running". `pct` is
 *  done over total (a failed piece is not progress). An empty kit is 0/0. */
export function kitProgress(generations: readonly { status: string }[]): KitProgress {
  const total = generations.length;
  let done = 0;
  let failed = 0;
  let live = 0;
  for (const g of generations) {
    if (g.status === "done") done++;
    else if (g.status === "error") failed++;
    else if (g.status === "queued" || g.status === "processing") live++;
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  const parts = [`${done}/${total} done`];
  if (failed) parts.push(`${failed} failed`);
  if (live) parts.push(`${live} running`);
  return { total, done, failed, live, pct, label: parts.join(" · ") };
}

/** Newest kit first (the panel's "current kit" is [0]). */
export function sortKits<T extends { created_at: string }>(kits: readonly T[]): T[] {
  return [...kits].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** True when some kit of the topic (in this language) is still generating —
 *  the pre-check the route runs before inserting another. */
export function hasLiveKit(kits: readonly { status: string; language?: string }[], language = "en"): boolean {
  return kits.some((k) => k.status === "generating" && (k.language ?? "en") === language);
}

/** 0115: topic_kits.part_plan. */
export const CATALOGUE_KITS_MIGRATION = "supabase/migrations/0115_catalogue_kits.sql";

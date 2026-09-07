/**
 * The kit's pure logic (Phase 3): the status guards, the Generate /
 * Regenerate acceptance rules, teacher-avatar alternation and voice pairing,
 * the generations params and rows, the curriculum header lines, the clip
 * validator, artifact ordering by part and the progress summary. Nothing
 * here can produce an 'approved' or 'rejected' kit — those are the 0115 RPCs
 * (migration-0115-catalogue-kits.test.ts, catalogue-routes.test.ts).
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-kit.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_KITS_MIGRATION,
  CLIP_LIMITS,
  GEN_STATUS_TONE,
  KIT_APPROVE_TOPIC_STATUSES,
  KIT_CREATION_KINDS,
  KIT_KINDS,
  KIT_KIND_LABEL,
  KIT_PARAM_KEYS,
  KIT_REJECT_REASONS,
  KIT_REJECT_REASON_LABEL,
  KIT_REJECT_TOPIC_STATUSES,
  KIT_STATUSES,
  KIT_STATUS_TONE,
  LESSON_PLAN_PARAM_KEYS,
  RETRIED_KEY,
  canApproveKit,
  canEditClips,
  canRegenerateKit,
  canRejectKit,
  canRetryKit,
  chaptersByPart,
  curriculumHeaderLines,
  docGenerationIdsWith,
  fmtTimestamp,
  hasLiveKit,
  isKitRejectReason,
  isKitStatus,
  isTeacherAvatar,
  kitAcceptsApprove,
  kitAcceptsGenerate,
  kitAcceptsRegenerate,
  kitAcceptsReject,
  kitGenerationIdFor,
  kitGenerationIds,
  kitGenerationParams,
  kitGenerationRows,
  kitProgress,
  kitStatusLabel,
  nextTeacherAvatar,
  parseTimestamp,
  partDurationsOf,
  retryParamsOf,
  sortKits,
  sortVideoArtifacts,
  validateClips,
  videoPartOf,
  voicePairFor,
} from "../catalogue/kit";

describe("kit status guards", () => {
  it("knows the 0112 status and reason lists", () => {
    expect([...KIT_STATUSES]).toEqual(["generating", "in_review", "approved", "rejected", "failed"]);
    expect([...KIT_REJECT_REASONS]).toEqual(["factual", "grade_fit", "pacing", "visuals", "pronunciation", "translation", "other"]);
    for (const s of KIT_STATUSES) {
      expect(isKitStatus(s)).toBe(true);
      expect(KIT_STATUS_TONE[s]).toMatch(/^bg-/);
    }
    for (const r of KIT_REJECT_REASONS) {
      expect(isKitRejectReason(r)).toBe(true);
      expect(KIT_REJECT_REASON_LABEL[r].length).toBeGreaterThan(0);
    }
    expect(isKitStatus("done")).toBe(false);
    expect(isKitRejectReason("")).toBe(false);
    expect(kitStatusLabel("in_review")).toBe("in review");
    for (const s of ["queued", "processing", "done", "error"]) expect(GEN_STATUS_TONE[s]).toMatch(/^bg-/);
  });

  it("approve accepts in_review only; reject accepts in_review and approved (pulling an approval)", () => {
    expect(KIT_STATUSES.filter(canApproveKit)).toEqual(["in_review"]);
    expect(KIT_STATUSES.filter(canRejectKit)).toEqual(["in_review", "approved"]);
  });

  it("kitAcceptsApprove: the kit in review, the TOPIC in review and the kit's ARTICLE still the approved version — the RPC's three checks, one sentence each", () => {
    expect([...KIT_APPROVE_TOPIC_STATUSES]).toEqual(["in_review"]);
    expect(kitAcceptsApprove("in_review", "in_review", "approved")).toEqual({ ok: true });
    const why = (r: ReturnType<typeof kitAcceptsApprove>) => (r.ok ? null : r.why);
    expect(why(kitAcceptsApprove("in_review", "approved", "approved"))).toMatch(/approved, not reviewable/);
    expect(why(kitAcceptsApprove("in_review", "generating", "approved"))).toMatch(/not reviewable/);
    // the kit Regenerate left behind: topic generating, kit still in_review
    expect(why(kitAcceptsApprove("generating", "in_review", "approved"))).toMatch(/generating a newer kit — this one is history/);
    expect(why(kitAcceptsApprove("video_approved", "in_review", "approved"))).toMatch(/video approved, not in review/);
    expect(why(kitAcceptsApprove("article_approved", "in_review", "approved"))).toMatch(/not in review/);
    // the article moved on: a kit built from v1 after v2 was approved
    expect(why(kitAcceptsApprove("in_review", "in_review", "superseded"))).toMatch(/superseded, not the approved version — regenerate/);
    expect(why(kitAcceptsApprove("in_review", "in_review", "rejected"))).toMatch(/rejected, not the approved version/);
    expect(why(kitAcceptsApprove("in_review", "in_review", null))).toMatch(/no longer exists/);
    expect(why(kitAcceptsApprove("in_review", "in_review", undefined))).toMatch(/no longer exists/);
    // the kit status is checked first, then the topic, then the article
    expect(why(kitAcceptsApprove("generating", "rejected", "superseded"))).toMatch(/not reviewable/);
    expect(why(kitAcceptsApprove("generating", "in_review", "superseded"))).toMatch(/history/);
  });

  it("kitAcceptsReject: a reviewable kit while the topic is in review or video approved", () => {
    expect([...KIT_REJECT_TOPIC_STATUSES]).toEqual(["in_review", "video_approved"]);
    expect(kitAcceptsReject("in_review", "in_review")).toEqual({ ok: true });
    expect(kitAcceptsReject("video_approved", "approved")).toEqual({ ok: true });
    expect(kitAcceptsReject("in_review", "approved")).toEqual({ ok: true });
    const why = (r: ReturnType<typeof kitAcceptsReject>) => (r.ok ? null : r.why);
    expect(why(kitAcceptsReject("in_review", "rejected"))).toMatch(/rejected, not reviewable/);
    expect(why(kitAcceptsReject("in_review", "failed"))).toMatch(/not reviewable/);
    expect(why(kitAcceptsReject("generating", "in_review"))).toMatch(/generating a newer kit — this one is history/);
    expect(why(kitAcceptsReject("published", "approved"))).toMatch(/published — a kit is rejected only while its topic is in review or video approved/);
  });

  it("retry is for a failed or still-generating kit; regenerate for a reviewed one; clips edit once the worker is done", () => {
    expect(KIT_STATUSES.filter(canRetryKit)).toEqual(["generating", "failed"]);
    expect(KIT_STATUSES.filter(canRegenerateKit)).toEqual(["in_review", "rejected"]);
    expect(KIT_STATUSES.filter(canEditClips)).toEqual(["in_review", "approved", "rejected", "failed"]);
  });
});

describe("kitAcceptsGenerate / kitAcceptsRegenerate", () => {
  it("accepts exactly: topic article_approved, article approved, no live kit", () => {
    expect(kitAcceptsGenerate("article_approved", "approved", false)).toEqual({ ok: true });
  });

  it("refuses with a reason the route and the panel share", () => {
    const why = (r: ReturnType<typeof kitAcceptsGenerate>) => (r.ok ? null : r.why);
    expect(why(kitAcceptsGenerate("article_approved", "approved", true))).toMatch(/already generating/);
    expect(why(kitAcceptsGenerate("candidate", "approved", false))).toMatch(/Approve the article first/);
    expect(why(kitAcceptsGenerate("approved", null, false))).toMatch(/Approve the article first/);
    expect(why(kitAcceptsGenerate("article_approved", "in_review", false))).toMatch(/Approve the article first/);
    expect(why(kitAcceptsGenerate("article_approved", undefined, false))).toMatch(/Approve the article first/);
    expect(why(kitAcceptsGenerate("generating", "approved", false))).toMatch(/generating.*retry/);
    expect(why(kitAcceptsGenerate("in_review", "approved", false))).toMatch(/regenerate/);
    expect(why(kitAcceptsGenerate("video_approved", "approved", false))).toMatch(/regenerate/);
    expect(why(kitAcceptsGenerate("published", "approved", false))).toMatch(/regenerate/);
    expect(why(kitAcceptsGenerate("retired", "approved", false))).toMatch(/retired/);
  });

  it("regenerate needs a reviewed kit and the topic back in review", () => {
    expect(kitAcceptsRegenerate("in_review", "in_review", false)).toEqual({ ok: true });
    expect(kitAcceptsRegenerate("in_review", "rejected", false)).toEqual({ ok: true });
    const why = (r: ReturnType<typeof kitAcceptsRegenerate>) => (r.ok ? null : r.why);
    expect(why(kitAcceptsRegenerate("in_review", "approved", false))).toMatch(/reject it first/);
    expect(why(kitAcceptsRegenerate("in_review", "generating", false))).toMatch(/retry/);
    expect(why(kitAcceptsRegenerate("in_review", "failed", false))).toMatch(/retry/);
    expect(why(kitAcceptsRegenerate("in_review", "rejected", true))).toMatch(/already generating/);
    expect(why(kitAcceptsRegenerate("video_approved", "rejected", false))).toMatch(/video approved.*reopen/);
    expect(why(kitAcceptsRegenerate("generating", "rejected", false))).toMatch(/reopen/);
  });
});

describe("teacher avatar + voices", () => {
  it("alternates to the less-used gender, tie → female", () => {
    expect(nextTeacherAvatar([])).toBe("female");
    expect(nextTeacherAvatar([{ teacher_avatar: "female" }])).toBe("male");
    expect(nextTeacherAvatar([{ teacher_avatar: "male" }])).toBe("female");
    expect(nextTeacherAvatar([{ teacher_avatar: "female" }, { teacher_avatar: "male" }])).toBe("female");
    expect(nextTeacherAvatar([{ teacher_avatar: "female" }, { teacher_avatar: "female" }, { teacher_avatar: "male" }])).toBe("male");
    // unknown / null avatars are not counted
    expect(nextTeacherAvatar([{ teacher_avatar: null }, { teacher_avatar: "avatar_teacher" }, { teacher_avatar: "female" }])).toBe("male");
    expect(isTeacherAvatar("female")).toBe(true);
    expect(isTeacherAvatar("Female")).toBe(false);
    expect(isTeacherAvatar(null)).toBe(false);
  });

  it("pairs the teacher voice with the OTHER gender's student voice, per language", () => {
    expect(voicePairFor("female", "en")).toEqual({ teacher: "g-en-f", student: "g-en-student-m" });
    expect(voicePairFor("male", "en")).toEqual({ teacher: "g-en-m", student: "g-en-student-f" });
    expect(voicePairFor("female", "ar")).toEqual({ teacher: "g-ar-f", student: "g-ar-student-m" });
    expect(voicePairFor("male", "FR")).toEqual({ teacher: "g-fr-m", student: "g-fr-student-f" });
    expect(voicePairFor("female", "")).toEqual({ teacher: "g-en-f", student: "g-en-student-m" });
  });
});

describe("kitGenerationParams / kitGenerationRows", () => {
  const params = kitGenerationParams({
    topicId: "t1",
    kitId: "k1",
    articleId: "a1",
    language: "en",
    teacherAvatar: "male",
    curriculumHeader: ["Cambridge Lower Secondary Science 0893 · 7Bs.01"],
  });

  it("builds decision 1's params object exactly", () => {
    expect(params).toEqual({
      catalogue: true,
      topic_id: "t1",
      kit_id: "k1",
      article_id: "a1",
      language: "en",
      narration_style: "dialogue",
      teacher_avatar: "male",
      tts_voice: "g-en-m",
      student_voice: "g-en-student-f",
      curriculum_header: ["Cambridge Lower Secondary Science 0893 · 7Bs.01"],
    });
    expect(Object.keys(params).sort()).toEqual(
      ["article_id", "catalogue", "curriculum_header", "kit_id", "language", "narration_style", "student_voice", "teacher_avatar", "topic_id", "tts_voice"].sort(),
    );
  });

  it("inserts the five creation kinds, presentation first, lesson_plan left to the worker, book and chapter NULL", () => {
    expect([...KIT_CREATION_KINDS]).toEqual(["presentation", "activity", "case_study", "worksheet", "deck"]);
    expect(KIT_CREATION_KINDS).not.toContain("lesson_plan");
    expect(KIT_KINDS).toContain("lesson_plan");
    for (const k of KIT_KINDS) expect(KIT_KIND_LABEL[k].length).toBeGreaterThan(0);
    const rows = kitGenerationRows("owner", params);
    expect(rows.map((r) => r.kind)).toEqual(["presentation", "activity", "case_study", "worksheet", "deck"]);
    for (const r of rows) {
      expect(r.owner_id).toBe("owner");
      expect(r.book_id).toBeNull();
      expect(r.chapter_ref).toBeNull();
      expect(r.school_id).toBeNull();
      expect(r.status).toBe("queued");
      expect(r.params).toBe(params);
    }
    // a retry re-inserts one kind with the same params
    expect(kitGenerationRows("owner", params, ["worksheet"])).toHaveLength(1);
    expect(kitGenerationRows("owner", params, ["worksheet"])[0].kind).toBe("worksheet");
  });

  it("retryParamsOf re-inserts the failed row's INPUTS only: no worker telemetry, no retried flag; a lesson plan keeps its clips and modes", () => {
    // the whitelist IS decision 1's key set
    expect([...KIT_PARAM_KEYS].sort()).toEqual(Object.keys(params).sort());
    expect([...LESSON_PLAN_PARAM_KEYS]).toEqual(["clips", "lesson_modes"]);
    expect(RETRIED_KEY).toBe("retried");
    // a presentation that failed after its video block ran carries the run's telemetry (process.py merges it)
    const failed = {
      ...params,
      tts_voice_used: "g-en-m",
      tts_voices_used: ["g-en-m", "edge-en-student"],
      tts_voice_downgraded: true,
      student_voice_used: "edge-en-student",
      student_voice_fallback: "no premium student voice for en",
      coverage: { pct: 0.4 },
      [RETRIED_KEY]: true,
      clips: [{ part: 1, start: 0, end: 120, label: "x", purpose: null }],
      lesson_modes: true,
    };
    expect(retryParamsOf(failed, "presentation")).toEqual(params);
    expect(retryParamsOf(failed, "worksheet")).toEqual(params);
    expect(retryParamsOf(failed, "lesson_plan")).toEqual({ ...params, clips: failed.clips, lesson_modes: true });
    // a key the row does not carry is simply absent (the worker's lesson_plan
    // insert does the same with _INHERITED_PARAMS)
    const { curriculum_header: _dropped, ...noHeader } = params;
    void _dropped;
    expect(retryParamsOf(noHeader as unknown as Record<string, unknown>, "deck")).toEqual(noHeader);
    // the input is not mutated
    expect(failed[RETRIED_KEY]).toBe(true);
  });

  it("reads and repoints a kit's generation ids", () => {
    const kit = { presentation_generation_id: "p", doc_generation_ids: { worksheet: "w", deck: "d", lesson_plan: "l" } };
    expect(kitGenerationIdFor(kit, "presentation")).toBe("p");
    expect(kitGenerationIdFor(kit, "worksheet")).toBe("w");
    expect(kitGenerationIdFor(kit, "activity")).toBeNull();
    expect(kitGenerationIds(kit)).toEqual(["p", "d", "l", "w"]);
    expect(kitGenerationIds({ presentation_generation_id: null, doc_generation_ids: {} })).toEqual([]);
    expect(docGenerationIdsWith(kit.doc_generation_ids, "activity", "a")).toEqual({ worksheet: "w", deck: "d", lesson_plan: "l", activity: "a" });
    expect(docGenerationIdsWith(null, "deck", "d2")).toEqual({ deck: "d2" });
    // the original is not mutated
    expect(kit.doc_generation_ids).toEqual({ worksheet: "w", deck: "d", lesson_plan: "l" });
  });
});

describe("curriculumHeaderLines", () => {
  const cambridge = { id: "c1", code: "0893", name: "Cambridge Lower Secondary Science" };
  const cbse = { id: "c2", code: "086", name: "CBSE Science" };

  it("writes one line per curriculum: objective codes as codes, chapters by title with the shared grade, stable order", () => {
    const lines = curriculumHeaderLines([
      { curriculum: cbse, node: { code: "CBSE-086-9-05", title: "Cell — the basic unit of life", grade: "Class 9" } },
      { curriculum: cambridge, node: { code: "7Bs.02", title: "Cells and organisms", grade: "7" } },
      { curriculum: cambridge, node: { code: "7Bs.01", title: "Cell structure", grade: "7" } },
      { curriculum: cambridge, node: { code: "7Bs.10", title: "Microscopes", grade: "7" } },
    ]);
    // name order: "Cambridge…" sorts before "CBSE…" (locale compare, case-insensitive)
    expect(lines).toEqual(["Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02, 7Bs.10", "CBSE Science 086 · Class 9 · Cell — the basic unit of life"]);
  });

  it("drops duplicates and mappings whose node or curriculum is gone; mixed grades get no grade prefix", () => {
    expect(
      curriculumHeaderLines([
        { curriculum: cbse, node: { code: "CBSE-086-9-05", title: "Cell — the basic unit of life", grade: "Class 9" } },
        { curriculum: cbse, node: { code: "CBSE-086-9-05", title: "Cell — the basic unit of life", grade: "Class 9" } },
        { curriculum: cbse, node: { code: "CBSE-086-8-08", title: "Cell — structure and functions", grade: "Class 8" } },
        { curriculum: null, node: { code: "x", title: "orphan", grade: null } },
        { curriculum: cambridge, node: null },
      ]),
    ).toEqual(["CBSE Science 086 · Cell — structure and functions, Cell — the basic unit of life"]);
    expect(curriculumHeaderLines([])).toEqual([]);
  });

  it("numeric collation orders 7Bs.2 before 7Bs.10", () => {
    const [line] = curriculumHeaderLines([
      { curriculum: cambridge, node: { code: "7Bs.10", title: "a", grade: null } },
      { curriculum: cambridge, node: { code: "7Bs.2", title: "b", grade: null } },
    ]);
    expect(line).toBe("Cambridge Lower Secondary Science 0893 · 7Bs.2, 7Bs.10");
  });
});

describe("timestamps + clips", () => {
  it("parses mm:ss, h:mm:ss and seconds; formats back", () => {
    expect(parseTimestamp("2:05")).toBe(125);
    expect(parseTimestamp("02:05")).toBe(125);
    expect(parseTimestamp("1:02:05")).toBe(3725);
    expect(parseTimestamp("125")).toBe(125);
    expect(parseTimestamp(125.4)).toBe(125);
    expect(parseTimestamp("2:65")).toBeNull();
    expect(parseTimestamp("abc")).toBeNull();
    expect(parseTimestamp(-1)).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(fmtTimestamp(0)).toBe("0:00");
    expect(fmtTimestamp(125)).toBe("2:05");
    expect(fmtTimestamp(3725)).toBe("1:02:05");
    expect(fmtTimestamp(-4)).toBe("0:00");
  });

  const durations = new Map<number, number | null>([
    [1, 17 * 60],
    [2, null],
  ]);

  it("accepts a well-formed list, stores seconds, sorts by (part, start)", () => {
    const r = validateClips(
      [
        { part: 2, start: "1:00", end: "3:30", label: "Osmosis demo", purpose: "discussion" },
        { part: 1, start: "4:10", end: "6:00", label: " Cell wall ", purpose: "" },
        { part: 1, start: 30, end: 90, label: "Intro" },
      ],
      durations,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips).toEqual([
      { part: 1, start: 30, end: 90, label: "Intro", purpose: null },
      { part: 1, start: 250, end: 360, label: "Cell wall", purpose: null },
      { part: 2, start: 60, end: 210, label: "Osmosis demo", purpose: "discussion" },
    ]);
  });

  it("refuses: not a list, bad times, start ≥ end, too short / long, outside the part, unknown part, label rules, too many", () => {
    const errs = (raw: unknown, d = durations) => {
      const r = validateClips(raw, d);
      return r.ok ? [] : r.errors;
    };
    expect(errs("nope")).toEqual(["clips must be a list."]);
    expect(errs([{ part: 1, start: "x", end: "1:00", label: "a" }])[0]).toMatch(/start must be mm:ss/);
    expect(errs([{ part: 1, start: "1:00", end: "0:30", label: "a" }])[0]).toMatch(/end must be after start/);
    expect(errs([{ part: 1, start: "1:00", end: "1:20", label: "a" }])[0]).toMatch(new RegExp(`at least ${CLIP_LIMITS.minSeconds} seconds`));
    expect(errs([{ part: 1, start: "1:00", end: "12:00", label: "a" }])[0]).toMatch(/at most 10 minutes/);
    expect(errs([{ part: 1, start: "16:00", end: "17:30", label: "a" }])[0]).toMatch(/part 1 runs 17:00/);
    // part 2's length is unknown: no ceiling
    expect(errs([{ part: 2, start: "16:00", end: "17:30", label: "a" }])).toEqual([]);
    expect(errs([{ part: 3, start: "0:00", end: "1:00", label: "a" }])[0]).toMatch(/no part 3/);
    expect(errs([{ part: 0, start: "0:00", end: "1:00", label: "a" }])[0]).toMatch(/positive whole number/);
    // no plan yet: any part is accepted
    expect(errs([{ part: 3, start: "0:00", end: "1:00", label: "a" }], new Map())).toEqual([]);
    expect(errs([{ part: 1, start: "0:00", end: "1:00", label: "" }])[0]).toMatch(/label is required/);
    expect(errs([{ part: 1, start: "0:00", end: "1:00", label: "x".repeat(81) }])[0]).toMatch(/longer than 80/);
    expect(errs([{ part: 1, start: "0:00", end: "1:00", label: "a", purpose: "p".repeat(201) }])[0]).toMatch(/purpose longer than 200/);
    expect(errs([{ part: 1, start: "0:00", end: "1:00", label: "a", purpose: 3 }])[0]).toMatch(/purpose must be text/);
    expect(errs([null])[0]).toMatch(/not an object/);
    expect(errs(Array.from({ length: 13 }, () => ({ part: 1, start: "0:00", end: "1:00", label: "a" })))[0]).toMatch(/At most 12/);
    // every problem is reported, not just the first
    expect(errs([{ part: 1, start: "x", end: "y", label: "" }])).toHaveLength(3);
  });

  it("partDurationsOf rounds minutes UP to whole minutes and keeps a part with unknown length", () => {
    const d = partDurationsOf([
      { part: 1, sections: ["s1"], minutes: 17.3 },
      { part: 2, sections: ["s2"], minutes: 0 },
      { part: 0, sections: [], minutes: 5 },
    ]);
    expect([...d.entries()]).toEqual([
      [1, 18 * 60],
      [2, null],
    ]);
    expect(partDurationsOf(null).size).toBe(0);
  });

  it("chaptersByPart groups and orders marks, reading a mark with no part as part 1", () => {
    const by = chaptersByPart([
      { part: 2, t: 0, label: "Recap" },
      { part: 1, t: 300, label: "Membrane", section_id: "s2" },
      { t: 0, label: "Intro" },
      { part: 1, t: 120, label: "Nucleus" },
      { part: 1, t: Number.NaN, label: "junk" },
    ]);
    expect([...by.keys()]).toEqual([1, 2]);
    expect(by.get(1)!.map((m) => [m.t, m.label, m.section_id])).toEqual([
      [0, "Intro", null],
      [120, "Nucleus", null],
      [300, "Membrane", "s2"],
    ]);
    expect(by.get(2)).toEqual([{ part: 2, t: 0, label: "Recap", section_id: null }]);
  });
});

describe("artifacts + progress", () => {
  it("orders videos by extracted part number, never by path string", () => {
    const paths = ["u/g/lesson_part3.mp4", "u/g/lesson_part2.mp4", "u/g/lesson.mp4", "u/g/lesson_part10.mp4"];
    expect(sortVideoArtifacts(paths)).toEqual(["u/g/lesson.mp4", "u/g/lesson_part2.mp4", "u/g/lesson_part3.mp4", "u/g/lesson_part10.mp4"]);
    // a locale sort gets it wrong (ICU: "." after "_") — the reason this exists
    expect([...paths].sort((a, b) => a.localeCompare(b))[0]).not.toBe("u/g/lesson.mp4");
    expect(sortVideoArtifacts([{ storage_path: "a/lesson_part2.mp4" }, { storage_path: "a/lesson.mp4" }]).map((a) => a.storage_path)).toEqual(["a/lesson.mp4", "a/lesson_part2.mp4"]);
    expect(videoPartOf("x/lesson.mp4")).toBe(1);
    expect(videoPartOf("x/lesson_part7.mp4")).toBe(7);
    expect(videoPartOf("x/deck_part2.pptx")).toBe(2);
  });

  it("summarises a kit's generations", () => {
    expect(kitProgress([])).toEqual({ total: 0, done: 0, failed: 0, live: 0, pct: 0, label: "0/0 done" });
    const p = kitProgress([{ status: "done" }, { status: "done" }, { status: "error" }, { status: "processing" }, { status: "queued" }, { status: "done" }]);
    expect(p).toEqual({ total: 6, done: 3, failed: 1, live: 2, pct: 50, label: "3/6 done · 1 failed · 2 running" });
    expect(kitProgress([{ status: "done" }]).label).toBe("1/1 done");
  });

  it("sorts kits newest first and spots a live one per language", () => {
    const kits = [
      { id: "a", created_at: "2026-09-01T00:00:00Z", status: "rejected", language: "en" },
      { id: "b", created_at: "2026-09-06T00:00:00Z", status: "generating", language: "en" },
      { id: "c", created_at: "2026-09-03T00:00:00Z", status: "in_review", language: "ar" },
    ];
    expect(sortKits(kits).map((k) => k.id)).toEqual(["b", "c", "a"]);
    expect(hasLiveKit(kits)).toBe(true);
    expect(hasLiveKit(kits, "ar")).toBe(false);
    expect(hasLiveKit([])).toBe(false);
    expect(CATALOGUE_KITS_MIGRATION).toMatch(/0115_catalogue_kits\.sql$/);
  });
});

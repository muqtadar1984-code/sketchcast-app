import { describe, it, expect } from "vitest";
import {
  mayReadRecap,
  checkPublish,
  MAX_BODY,
  PUBLISH_MESSAGE,
  type RecapSession,
  type RecapReader,
} from "@/utils/present/audience";
import { rollPdfPath, framePath, sessionFolder, ownsPath } from "@/utils/present/paths";

const TEACHER = "t1";
const CLASS = "c1";
const SCHOOL = "s1";

const session = (over: Partial<RecapSession> = {}): RecapSession => ({
  teacher_id: TEACHER,
  class_id: CLASS,
  school_id: SCHOOL,
  recap_body: "Explored how magnets attract iron.",
  recap_published_at: "2026-08-29T04:00:00Z",
  ...over,
});

const reader = (over: Partial<RecapReader> = {}): RecapReader => ({
  userId: "stu1",
  enrolledClassIds: [],
  childClassIds: [],
  leadsSchool: false,
  ...over,
});

describe("who may read a published note", () => {
  it("lets an ENROLLED STUDENT in — the whole point of Phase 3", () => {
    expect(mayReadRecap(session(), reader({ enrolledClassIds: [CLASS] }), true)).toEqual({
      ok: true,
      as: "student",
    });
  });

  it("lets a verified parent of an enrolled child in", () => {
    expect(mayReadRecap(session(), reader({ childClassIds: [CLASS] }), true)).toEqual({
      ok: true,
      as: "parent",
    });
  });

  it("lets the teacher read her own", () => {
    expect(mayReadRecap(session(), reader({ userId: TEACHER }), true)).toEqual({
      ok: true,
      as: "teacher",
    });
  });

  it("lets leadership of the session's school in", () => {
    expect(mayReadRecap(session(), reader({ leadsSchool: true }), true)).toEqual({
      ok: true,
      as: "leader",
    });
  });

  it("REFUSES a signed-in stranger", () => {
    expect(mayReadRecap(session(), reader(), true)).toEqual({ ok: false, reason: "unrelated" });
  });

  it("refuses a student of a DIFFERENT class", () => {
    expect(mayReadRecap(session(), reader({ enrolledClassIds: ["other"] }), true)).toEqual({
      ok: false,
      reason: "unrelated",
    });
  });

  it("gives leadership NOTHING on a session with no school — a private board has no oversight", () => {
    expect(
      mayReadRecap(session({ school_id: null }), reader({ leadsSchool: true }), true),
    ).toEqual({ ok: false, reason: "unrelated" });
  });
});

describe("what must be true before anyone reads it", () => {
  it("REFUSES AN UNPUBLISHED SESSION even to a student of the right class", () => {
    // The board is live during a lesson. Nothing about a session in progress is
    // anybody else's to read.
    expect(
      mayReadRecap(session({ recap_published_at: null }), reader({ enrolledClassIds: [CLASS] }), true),
    ).toEqual({ ok: false, reason: "unpublished" });
  });

  it("refuses a published_at with no body — belt against the schema's braces", () => {
    // 0099 has a CHECK constraint for exactly this. The code refuses too,
    // because a row written before that constraint existed would still be here.
    expect(
      mayReadRecap(session({ recap_body: null }), reader({ enrolledClassIds: [CLASS] }), true),
    ).toEqual({ ok: false, reason: "unpublished" });
  });

  it("refuses the TEACHER her own unpublished note through this path", () => {
    // A draft belongs to the composer, not to a shared link. She reads it on
    // /present, where she is writing it.
    expect(
      mayReadRecap(session({ recap_published_at: null }), reader({ userId: TEACHER }), true),
    ).toEqual({ ok: false, reason: "unpublished" });
  });

  it("REFUSES EVERYONE WHEN THE AUTHOR IS NOT ALLOWLISTED, including the author", () => {
    // Feature visibility is decided by who MADE the thing. If Present mode is
    // switched off for a teacher, her published notes go quiet with it — they
    // do not survive as an orphaned surface nobody can turn off.
    for (const r of [
      reader({ userId: TEACHER }),
      reader({ enrolledClassIds: [CLASS] }),
      reader({ leadsSchool: true }),
    ]) {
      expect(mayReadRecap(session(), r, false)).toEqual({ ok: false, reason: "author-not-allowed" });
    }
  });
});

describe("what may be published", () => {
  const closed = { class_id: CLASS, ended_at: "2026-08-29T04:00:00Z" };

  it("accepts a normal note and normalises its whitespace", () => {
    expect(checkPublish(closed, "  Explored   magnets. \n")).toEqual({
      ok: true,
      body: "Explored magnets.",
    });
  });

  it("refuses an empty one", () => {
    expect(checkPublish(closed, "   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a document", () => {
    expect(checkPublish(closed, "x".repeat(MAX_BODY + 1))).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("REFUSES TO PUBLISH A LESSON STILL BEING TAUGHT", () => {
    // The note points at the roll she finishes with, and an open board has not
    // finished.
    expect(checkPublish({ ...closed, ended_at: null }, "Fine.")).toEqual({
      ok: false,
      reason: "not-closed",
    });
  });

  it("REFUSES A SESSION WITH NO CLASS, and says so rather than publishing to nobody", () => {
    // The honest refusal. An independent teacher with no class would otherwise
    // get a published note exactly one person can open, and conclude the
    // feature was broken.
    expect(checkPublish({ ...closed, class_id: null }, "Fine.")).toEqual({
      ok: false,
      reason: "no-audience",
    });
  });

  it("has a sentence for every refusal it can produce", () => {
    for (const reason of ["empty", "too-long", "not-closed", "no-audience"] as const) {
      expect(PUBLISH_MESSAGE[reason]).toBeTruthy();
    }
  });
});

describe("where a lesson's files live", () => {
  it("puts them under the TEACHER's uid folder, which is what the storage policy checks", () => {
    // artifacts carries one policy: (storage.foldername(name))[1] = auth.uid().
    // Her own browser may write here; nothing else may.
    expect(rollPdfPath("t1", "s9")).toBe("t1/present/s9/board.pdf");
    expect(rollPdfPath("t1", "s9").split("/")[0]).toBe("t1");
    expect(framePath("t1", "s9", 4)).toBe("t1/present/s9/frame-4.jpg");
    expect(sessionFolder("t1", "s9")).toBe("t1/present/s9");
  });

  it("KEYS A FRAME ON THE PAGE, so freezing twice onto a page replaces rather than orphans", () => {
    expect(framePath("t1", "s9", 4)).toBe(framePath("t1", "s9", 4));
    expect(framePath("t1", "s9", 5)).not.toBe(framePath("t1", "s9", 4));
  });

  it("recognises a path this session owns, and refuses a climb out of it", () => {
    expect(ownsPath("t1", "s9", "t1/present/s9/board.pdf")).toBe(true);
    expect(ownsPath("t1", "s9", "t2/present/s9/board.pdf")).toBe(false);
    expect(ownsPath("t1", "s9", "t1/present/other/board.pdf")).toBe(false);
    expect(ownsPath("t1", "s9", "t1/present/s9/nested/board.pdf")).toBe(false);
    expect(ownsPath("t1", "s9", "t1/present/s9/")).toBe(false);
  });
});

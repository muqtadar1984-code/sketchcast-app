import { describe, expect, it } from "vitest";
import { isRelevant, splitShelf, type TeachingProfile } from "../school-books";

// The shelf is shared school-wide, so relevance is the only thing standing
// between a Form 1 Science teacher and every book a 40-teacher secondary school
// owns. It is derived from data nobody maintains — classes.grade and
// timetable_slots.subject against the grade/subject indexing recorded — which
// makes it exactly the kind of logic that rots silently.

const science1: TeachingProfile = { grades: ["Form 1"], subjects: ["Science"] };

describe("isRelevant", () => {
  it("matches the teacher's own grade and subject", () => {
    expect(isRelevant({ grade: "Form 1", subject: "Science" }, science1)).toBe(true);
  });

  it("reconciles Malay and English grade names — the same shelf in one school", () => {
    // A school records "Tingkatan 1"; the book is printed "Form 1".
    expect(isRelevant({ grade: "Form 1", subject: "Science" }, { grades: ["Tingkatan 1"], subjects: ["Sains"] })).toBe(
      true,
    );
    // And Form 1 is NOT Standard 1 — gradeLevel puts secondary above primary,
    // so a Form 1 teacher must not be handed the Year 1 book.
    expect(isRelevant({ grade: "Standard 1", subject: "Science" }, science1)).toBe(false);
  });

  it("accepts a longer printed subject that contains what the teacher teaches", () => {
    expect(isRelevant({ grade: "Form 1", subject: "Cambridge Primary Science" }, science1)).toBe(true);
  });

  it("rejects a book contradicted on either axis", () => {
    expect(isRelevant({ grade: "Form 5", subject: "Science" }, science1)).toBe(false); // wrong grade
    expect(isRelevant({ grade: "Form 1", subject: "Accounting" }, science1)).toBe(false); // wrong subject
  });

  it("does not bury a book indexing could only half-identify", () => {
    // One positive signal, the other simply absent — not contradicted.
    expect(isRelevant({ grade: "Form 1", subject: null }, science1)).toBe(true);
    expect(isRelevant({ grade: null, subject: "Science" }, science1)).toBe(true);
  });

  it("leaves a book we know nothing about in the remainder", () => {
    expect(isRelevant({ grade: null, subject: null }, science1)).toBe(false);
  });

  it("will not match on a fragment too short to be meaningful", () => {
    // "Art" must not pull in "Earth Science" by containment.
    expect(isRelevant({ grade: "Form 1", subject: "Earth Science" }, { grades: ["Form 1"], subjects: ["Art"] })).toBe(
      false,
    );
  });

  it("ignores case, padding and punctuation in subjects", () => {
    expect(isRelevant({ grade: "Form 1", subject: "  SCIENCE: " }, science1)).toBe(true);
  });

  // The synonym table is the difference between working and silently failing in
  // Malaysia, where the school's subject names and the book's rarely match.
  it.each([
    ["Pendidikan Islam", "Islamic Education"],
    ["Bahasa Melayu", "Malay"],
    ["Sejarah", "History"],
    ["Fizik", "Physics"],
    ["Perakaunan", "Accounting"],
  ])("treats %s and %s as the same subject", (taught, printed) => {
    expect(isRelevant({ grade: "Form 4", subject: printed }, { grades: ["Form 4"], subjects: [taught] })).toBe(true);
  });

  it("keeps Additional Mathematics distinct from Mathematics", () => {
    // Add Maths is its own subject in Malaysia, and its name CONTAINS the other
    // — the exact case a naive containment rule collapses.
    const addMaths = { grades: ["Form 4"], subjects: ["Matematik Tambahan"] };
    const maths = { grades: ["Form 4"], subjects: ["Matematik"] };
    expect(isRelevant({ grade: "Form 4", subject: "Mathematics" }, addMaths)).toBe(false);
    expect(isRelevant({ grade: "Form 4", subject: "Additional Mathematics" }, addMaths)).toBe(true);
    expect(isRelevant({ grade: "Form 4", subject: "Additional Mathematics" }, maths)).toBe(false);
    expect(isRelevant({ grade: "Form 4", subject: "Mathematics" }, maths)).toBe(true);
  });
});

describe("splitShelf", () => {
  const shelf = [
    { id: "a", grade: "Form 1", subject: "Science" },
    { id: "b", grade: "Form 5", subject: "Accounting" },
    { id: "c", grade: "Form 1", subject: "History" },
    { id: "d", grade: null, subject: null },
  ];

  it("puts the teacher's books first and the rest behind the disclosure", () => {
    const { relevant, rest } = splitShelf(shelf, science1);
    expect(relevant.map((b) => b.id)).toEqual(["a"]);
    expect(rest.map((b) => b.id)).toEqual(["b", "c", "d"]);
  });

  it("hides nothing — every book lands in exactly one side", () => {
    const { relevant, rest } = splitShelf(shelf, science1);
    expect([...relevant, ...rest].map((b) => b.id).sort()).toEqual(shelf.map((b) => b.id).sort());
  });

  it("shows the WHOLE shelf to a teacher we know nothing about yet", () => {
    // The new joiner is the case this feature exists for. Matching nothing must
    // not mean an empty Library with everything hidden behind a disclosure.
    const { relevant, rest } = splitShelf(shelf, { grades: [], subjects: [] });
    expect(relevant).toHaveLength(shelf.length);
    expect(rest).toHaveLength(0);
  });

  it("still filters once a teacher has only a timetable and no classes", () => {
    const { relevant } = splitShelf(shelf, { grades: [], subjects: ["Science"] });
    expect(relevant.map((b) => b.id)).toEqual(["a"]);
  });

  it("fails OPEN when nothing matches rather than showing an empty shelf", () => {
    // A real case from prod: an Art teacher in a school whose books are all
    // Science and Maths. A total miss is more likely thin metadata than a
    // school that owns nothing for them, and an empty Library with everything
    // folded behind a disclosure is worse than a slightly noisy one.
    const { relevant, rest } = splitShelf(shelf, { grades: [], subjects: ["Art"] });
    expect(relevant).toHaveLength(shelf.length);
    expect(rest).toHaveLength(0);
  });

  it("does not fail open when the school has no books at all", () => {
    const { relevant, rest } = splitShelf([], { grades: ["Form 1"], subjects: ["Science"] });
    expect(relevant).toEqual([]);
    expect(rest).toEqual([]);
  });
});

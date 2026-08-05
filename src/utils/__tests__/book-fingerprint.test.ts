import { describe, expect, it } from "vitest";
import { titleCore, titlesLookSame } from "../book-fingerprint";

// This decides whether a teacher is told "your school already has this book".
// Being WRONG in the false-positive direction is the expensive mistake: it
// tells someone their book is on the shelf when it is not, so they stop
// looking. A missed duplicate only costs one extra indexing run.

describe("titleCore", () => {
  it("strips the noise real filenames carry", () => {
    expect(titleCore("Form 1 Science (2nd Edition) FINAL_v2.pdf")).toBe("form 1 science");
  });

  it("drops ISBNs and scanner ids", () => {
    // A real title from the founder's library.
    expect(titleCore("1015966800 As English General Paper Textbook")).toBe(
      "as english general paper textbook",
    );
  });

  it("is stable across case, padding and punctuation", () => {
    expect(titleCore("  CAMBRIDGE: Primary  Science!  ")).toBe(titleCore("cambridge primary science"));
  });

  it("survives non-Latin scripts", () => {
    expect(titleCore("سائنس تيڠكتن ١")).not.toBe("");
    expect(titleCore("विज्ञान")).toBe("विज्ञान");
  });
});

describe("titlesLookSame", () => {
  it("matches the same book named two ways", () => {
    expect(titlesLookSame("Form 1 Science", "Form 1 Science Learner's Book")).toBe(true);
    expect(titlesLookSame("Cambridge Primary Science Year 7", "Cambridge Primary Science Year 7 Lb 2nd Edition")).toBe(
      true,
    );
  });

  it("matches across the filename noise a scan picks up", () => {
    expect(titlesLookSame("Form 4 Physics FINAL.pdf", "Form 4 Physics (3rd Edition)")).toBe(true);
  });

  it("does NOT match different books that share a subject", () => {
    expect(titlesLookSame("Form 1 Science", "Form 1 History")).toBe(false);
    expect(titlesLookSame("Form 1 Science", "Form 5 Science")).toBe(false);
  });

  it("does NOT match on a single shared word", () => {
    // The expensive false positive: two unrelated books both saying "science".
    expect(titlesLookSame("Science", "Science Practical Workbook")).toBe(false);
  });

  it("refuses to judge titles too thin to be meaningful", () => {
    expect(titlesLookSame("Book", "Book")).toBe(true); // identical is still identical
    expect(titlesLookSame("Maths", "Maths Workbook")).toBe(false); // one word each side
    expect(titlesLookSame("", "Form 1 Science")).toBe(false);
    expect(titlesLookSame(null, undefined)).toBe(false);
  });

  it("treats an edition bump as the same book", () => {
    // Deliberate: the teacher decides. We only raise the question.
    expect(titlesLookSame("Biology Textbook 2nd Edition", "Biology Textbook 3rd Edition")).toBe(true);
  });
});

describe("subject vocabulary inside titles", () => {
  it("connects Maths to Mathematics — a real duplicate in the live library", () => {
    expect(titlesLookSame("Cambridge Maths 5 Learner Book", "Cambridge Primary Mathematics Learner's Book 5")).toBe(
      true,
    );
  });

  it("connects the Malay and English subject names", () => {
    expect(titlesLookSame("Sains Tingkatan 1 Buku Teks", "Science Tingkatan 1 Buku Teks")).toBe(true);
  });

  it("still refuses two different subjects", () => {
    expect(titlesLookSame("Cambridge Maths 5 Learner Book", "Cambridge Science 5 Learner Book")).toBe(false);
  });
});

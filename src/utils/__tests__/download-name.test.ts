import { describe, expect, it } from "vitest";
import { docDownloadName } from "../download-name";

// The bug this file defends against: a "Test paper" downloading as
// exam_paper.docx — the browser used the Supabase storage basename because no
// surface set a download filename. The mapping renames at SIGNING time, so it
// covers artifacts that are already in the bucket. Names are English-only by
// design (stored basenames never were localized; ASCII keeps
// Content-Disposition simple), so these expectations are literal strings.

describe("docDownloadName", () => {
  it("names the exam paper what the UI calls it — Test Paper, not exam_paper", () => {
    expect(docDownloadName("exam_paper", "docx")).toBe("Test Paper.docx");
  });

  it("names the other document kinds", () => {
    expect(docDownloadName("worksheet", "docx")).toBe("Worksheet.docx");
    expect(docDownloadName("lesson_plan", "docx")).toBe("Lesson Plan.docx");
    expect(docDownloadName("activity", "docx")).toBe("Activities.docx");
    expect(docDownloadName("case_study", "docx")).toBe("Case Study.docx");
    expect(docDownloadName("exam", "docx")).toBe("Exam.docx");
  });

  it("keeps the cumulative exam's key at its original plain name (0062)", () => {
    expect(docDownloadName("exam", "answer_key_docx")).toBe("Answer Key.docx");
  });

  it("prefixes split answer keys with their paper's name so two keys from one chapter don't collide", () => {
    // Student/teacher document split (2026-08-18): exam_paper / worksheet /
    // activity / case_study each ship a student-clean docx PLUS a separate
    // answer_key_docx sibling.
    expect(docDownloadName("exam_paper", "answer_key_docx")).toBe("Test Paper Answer Key.docx");
    expect(docDownloadName("worksheet", "answer_key_docx")).toBe("Worksheet Answer Key.docx");
    expect(docDownloadName("activity", "answer_key_docx")).toBe("Activities Answer Key.docx");
    expect(docDownloadName("case_study", "answer_key_docx")).toBe("Case Study Answer Key.docx");
  });

  it("falls back to the plain key name on an unknown or absent kind — never the storage basename", () => {
    expect(docDownloadName(null, "answer_key_docx")).toBe("Answer Key.docx");
    expect(docDownloadName(undefined, "answer_key_docx")).toBe("Answer Key.docx");
    expect(docDownloadName("something_new", "answer_key_docx")).toBe("Answer Key.docx");
  });

  it("leaves non-document artifacts untouched — a disposition would break in-tab playback", () => {
    expect(docDownloadName("presentation", "video_mp4")).toBeUndefined();
    expect(docDownloadName("presentation", "deck_pptx")).toBeUndefined();
    expect(docDownloadName("exam_paper", "questions_json")).toBeUndefined();
  });

  it("leaves an unknown or absent generation kind untouched rather than guessing", () => {
    expect(docDownloadName(null, "docx")).toBeUndefined();
    expect(docDownloadName(undefined, "docx")).toBeUndefined();
    expect(docDownloadName("presentation", "docx")).toBeUndefined();
    expect(docDownloadName("something_new", "docx")).toBeUndefined();
  });
});

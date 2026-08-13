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

  it("names the answer key regardless of generation kind", () => {
    expect(docDownloadName("exam", "answer_key_docx")).toBe("Answer Key.docx");
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

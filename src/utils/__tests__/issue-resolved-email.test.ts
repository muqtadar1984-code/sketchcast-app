import { describe, it, expect } from "vitest";
import { issueResolvedEmail, issueThing } from "../notify";

describe("the resolution email", () => {
  it("names the thing the owner asked for, in their words", () => {
    expect(issueThing("presentation", null)).toBe("lesson video");
    expect(issueThing("exam_paper", "generation_failed")).toBe("test paper");
    expect(issueThing(null, "wrong_chapter")).toBe("wrong chapter");
    expect(issueThing("something_new", null)).toBe("something new");
  });

  it("says what was done and invites a reply", () => {
    const { subject, text } = issueResolvedEmail({
      kind: "worksheet",
      bookTitle: "Class 6.1 To 6.4",
      note: "The maths checker did not handle large numbers written with commas; fixed, and the worksheet has been regenerated.",
    });
    expect(subject).toBe('Your worksheet for "Class 6.1 To 6.4" on SketchCast is sorted');
    expect(text).toContain('The problem with your worksheet for "Class 6.1 To 6.4" on SketchCast has been addressed.');
    expect(text).toContain("did not handle large numbers");
    expect(text).toContain("just reply to this email and we will take it up again");
    expect(text.endsWith("SketchCast AI")).toBe(true);
  });

  it("copes without a note or a book", () => {
    const { subject, text } = issueResolvedEmail({ kind: "presentation" });
    expect(subject).toBe("Your lesson video on SketchCast is sorted");
    expect(text).not.toContain("\n\n\n");
  });
});

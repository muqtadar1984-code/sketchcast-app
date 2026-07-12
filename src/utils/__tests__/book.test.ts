import { describe, expect, it } from "vitest";
import { cleanBookTitle } from "@/utils/book";

describe("cleanBookTitle", () => {
  it("cleans a download-site filename slug", () => {
    expect(cleanBookTitle("pdfcoffee.com_cambridge-maths-5-learner-book-pdf-free")).toBe(
      "Cambridge Maths 5 Learner Book",
    );
  });

  it("strips a plain .pdf and slug dashes", () => {
    expect(cleanBookTitle("grade-7-science.pdf")).toBe("Grade 7 Science");
    expect(cleanBookTitle("ncert_class_6_history")).toBe("Ncert Class 6 History");
  });

  it("strips trailing free/pdf junk tokens", () => {
    expect(cleanBookTitle("dokumen.pub_biology-textbook-free")).toBe("Biology Textbook");
  });

  it("leaves a real human/indexer title untouched", () => {
    expect(cleanBookTitle("Cambridge Primary Mathematics Learner's Book 5")).toBe(
      "Cambridge Primary Mathematics Learner's Book 5",
    );
    expect(cleanBookTitle("The Cat in the Hat")).toBe("The Cat in the Hat");
  });

  it("falls back for empty/nullish", () => {
    expect(cleanBookTitle("")).toBe("Untitled book");
    expect(cleanBookTitle(null)).toBe("Untitled book");
    expect(cleanBookTitle(undefined)).toBe("Untitled book");
  });
});

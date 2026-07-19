import { describe, it, expect } from "vitest";
import { gradeLevel, defaultNarrationForGrade } from "../narration";

describe("gradeLevel — parse a free-text grade label to a level", () => {
  it("reads plain grade/year/primary numbers", () => {
    expect(gradeLevel("Grade 1")).toBe(1);
    expect(gradeLevel("Grade 4")).toBe(4);
    expect(gradeLevel("Year 7")).toBe(7);
    expect(gradeLevel("Primary 3")).toBe(3);
    expect(gradeLevel("Tahun 2")).toBe(2); // Malay primary
  });
  it("maps secondary systems ABOVE primary", () => {
    expect(gradeLevel("Form 1")).toBe(7); // Form 1 ≈ grade 7
    expect(gradeLevel("Tingkatan 1")).toBe(7); // Malay secondary
    expect(gradeLevel("Secondary 2")).toBe(8);
  });
  it("kindergarten / pre-school is below grade 1", () => {
    expect(gradeLevel("Kindergarten")).toBe(0);
    expect(gradeLevel("Tadika")).toBe(0);
    expect(gradeLevel("Pre-school")).toBe(0);
  });
  it("takes the first number of a range", () => {
    expect(gradeLevel("6th-8th Grade")).toBe(6);
  });
  it("returns null when there's nothing to parse", () => {
    expect(gradeLevel(null)).toBeNull();
    expect(gradeLevel("")).toBeNull();
    expect(gradeLevel("General")).toBeNull();
  });
});

describe("defaultNarrationForGrade — age-appropriate narration", () => {
  it("grades 1–4 (and kindergarten) default to Storytelling", () => {
    for (const g of ["Kindergarten", "Grade 1", "Year 2", "Tahun 3", "Primary 4"]) {
      expect(defaultNarrationForGrade(g)).toBe("storytelling");
    }
  });
  it("grade 5+ and secondary keep Socratic", () => {
    for (const g of ["Grade 5", "Year 7", "Form 1", "Tingkatan 3", "10th Grade"]) {
      expect(defaultNarrationForGrade(g)).toBe("socratic");
    }
  });
  it("an unknown/blank grade keeps the global default (Socratic)", () => {
    expect(defaultNarrationForGrade(null)).toBe("socratic");
    expect(defaultNarrationForGrade("General")).toBe("socratic");
  });
});

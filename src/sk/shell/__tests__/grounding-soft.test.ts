/**
 * The SOFTER grounding check (model routing — prompt.ts groundingCheck with
 * mode "soft"): SK's own phrasing, product words, days and languages, and
 * ordinary capitalised words pass; invented contacts, invented PEOPLE and
 * unsupported numbers in a sentence that cites tool data are still dropped.
 * The strict mode (rules routing) is unchanged.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/grounding-soft.test.ts
 */
import { describe, expect, it } from "vitest";
import { groundingCheck, personNameWords } from "../prompt";

const soft = (text: string, support: unknown[] = [], question = "") => groundingCheck(text, support, question, { mode: "soft" });
const strict = (text: string, support: unknown[] = [], question = "") => groundingCheck(text, support, question);

describe("kept: SK's own phrasing and product words", () => {
  for (const t of [
    "Hi, I'm SK. I can open your Library, run a lesson on the Board, or show you around.",
    "Ask me in English, Bahasa Melayu or Arabic — any day, Monday to Friday.",
    "Try the Classroom Board or the SK Tutor.",
    "I can help in 3 ways: open a page, start a lesson, or answer from your books.",
    "Photosynthesis happens in the Chloroplast, using Light from the Sun.",
  ]) {
    it(t, () => {
      const v = soft(t);
      expect(v.ok, v.unsupported.join(",")).toBe(true);
      expect(v.text).toBe(t);
    });
  }
  it("the same capitalised words strict mode would have dropped", () => {
    expect(strict("Photosynthesis happens in the Chloroplast, using Light from the Sun.").ok).toBe(false);
  });
});

describe("dropped: invented contacts and people", () => {
  it("an invented email (and phone, URL) — whatever the question says", () => {
    const v = soft("You can reach the office at office@school.example. Call 012-345 6789. See www.example.org.", [], "what is the office email?");
    expect(v.ok).toBe(false);
    expect(v.text).toBe("");
    expect(v.unsupported).toEqual(expect.arrayContaining(["office@school.example", "012-345 6789", "www.example.org"]));
  });
  it("an email the tools returned is kept", () => {
    expect(soft("Write to office@school.example.", [{ email: "office@school.example" }]).ok).toBe(true);
  });
  it("an invented 'Mrs Tan' is dropped; a Mrs Tan the tools returned is kept", () => {
    const v = soft("Mrs Tan teaches 7B. I can open the Diary for you.");
    expect(v.unsupported).toEqual(["Tan"]);
    expect(v.text).toBe("I can open the Diary for you.");
    expect(soft("Mrs Tan teaches 7B.", [{ teacher: "Mrs Tan", class: "7B" }]).ok).toBe(true);
  });
  it("honorifics in Malay, possessive kin, role nouns and at-risk lists are people", () => {
    expect(personNameWords("Cikgu Aminah is away.")).toEqual(["Aminah"]);
    expect(personNameWords("Amir's mother called.")).toEqual(["Amir"]);
    expect(personNameWords("Your learners: Chandra, Cahya and Citra.")).toEqual(["Chandra", "Cahya", "Citra"]);
    expect(personNameWords("Di sekolah lain, Zara dan Zul berisiko.")).toEqual(["Zara", "Zul"]);
    expect(personNameWords("Specialised Cells is chapter 5 of Biology.")).toEqual([]);
  });
  it("a name the user said, or her own context, is not invented", () => {
    expect(soft("Cikgu Aminah teaches on Mondays.", [], "how is Cikgu Aminah's class?").ok).toBe(true);
    expect(soft("Cikgu Aminah teaches on Mondays.").ok).toBe(false);
  });
});

describe("numbers: only where a sentence cites tool data", () => {
  const facts = [{ class: "7B", at_risk: 3, name: "Amir" }, "7B: 3 learners at risk (Amir, Siti, Ravi)."];
  it("an invented count next to tool data is dropped; the supported one kept", () => {
    const v = soft("7B has 3 learners at risk. 7B has 31 students in all.", facts);
    expect(v.text).toBe("7B has 3 learners at risk.");
    expect(v.unsupported).toEqual(["31"]);
  });
  it("an invented score or percentage with no tool at all is still data", () => {
    expect(soft("Attendance today was 94%.").ok).toBe(false);
    expect(soft("12 parents read the last notice.").ok).toBe(false);
    expect(soft("Your seat limit is 500 seats.").ok).toBe(false);
  });
  it("a number in a sentence about a tool's own words (not a data word) is checked too", () => {
    expect(soft("Amir lives at 12 Jalan Mawar.", facts).ok).toBe(false);
  });
  it("a number in SK's own phrasing passes", () => {
    expect(soft("Give me 2 seconds and I'll open it.").ok).toBe(true);
  });
});

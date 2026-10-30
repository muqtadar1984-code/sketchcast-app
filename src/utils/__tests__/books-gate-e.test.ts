import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({}) }));
import { gateERefusal, type CompiledBook } from "@/utils/books/decide";
import type { Approval } from "@/utils/books/types";

const book: CompiledBook = {
  pdf: "b.pdf", pdf_sha256: "PDF", pages: 30, missing: [],
  chapters: [
    { number: 1, title: "A", start: 7, pages: 12, content_sha256: "S1" },
    { number: 2, title: "B", start: 21, pages: 10, content_sha256: "S2" },
  ],
};
const gd = (chapter: number, sha: string) => ({ kind: "gate_d", chapter, content_sha256: sha }) as unknown as Approval;

describe("Gate E", () => {
  it("needs every chapter Gate D approved for the printed text", () => {
    expect(gateERefusal(book, [gd(1, "S1")])).toMatch(/Chapters 2 are not approved/);
    expect(gateERefusal(book, [gd(1, "S1"), gd(2, "OLD")])).toMatch(/Chapters 2/);
    expect(gateERefusal(book, [gd(1, "S1"), gd(2, "S2")])).toBeNull();
  });

  it("accepts a book approval of the revision whose text was printed (Biology r4.1)", () => {
    const book4 = { kind: "book", revision_key: "r4.1", content_sha256: null } as unknown as Approval;
    const texts = [{ revision_key: "r4.1", chapter: 2, content_sha256: "S2" }, { revision_key: "r4", chapter: 2, content_sha256: "OLD" }];
    expect(gateERefusal(book, [gd(1, "S1"), book4], texts)).toBeNull();
    // a book approval of ANOTHER revision does not cover this text
    const other = { kind: "book", revision_key: "r4", content_sha256: null } as unknown as Approval;
    expect(gateERefusal(book, [gd(1, "S1"), other], texts)).toMatch(/Chapters 2/);
  });

  it("refuses a partial book and a second approval of the same PDF", () => {
    expect(gateERefusal({ ...book, missing: [3] }, [])).toMatch(/not drafted yet/);
    const e = { kind: "gate_e", content_sha256: "PDF" } as unknown as Approval;
    expect(gateERefusal(book, [gd(1, "S1"), gd(2, "S2"), e])).toMatch(/already approved/);
  });
});

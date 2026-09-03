/**
 * The words a teacher reads before a book is deleted (src/utils/book-delete.ts).
 *
 * What must hold:
 *  • an empty book gets the short confirm — never "0 kits and their files";
 *  • a book with kits names the count and says credits are not returned;
 *  • a book whose kits carry student submissions ALSO says how many — this is
 *    the sentence a teacher may not have expected, so it must be present with
 *    its number whenever submissions > 0 and absent otherwise;
 *  • the placeholders are filled — a stray "{kits}" on screen means the
 *    dictionary and the code disagree about a key;
 *  • the three refusals are recognised, from the impact row (before asking)
 *    and from the RPC's error token (the race backstop) — and "shared" wins,
 *    because other teachers' kits settle the question before anything else.
 * Run: npx vitest run src/utils/__tests__/book-delete.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  blockedReasonFromError,
  bookDeleteBlockedReason,
  bookDeleteConfirmText,
  type BookImpact,
  type DeleteBookMessages,
} from "@/utils/book-delete";

const T: DeleteBookMessages = {
  delete: "Delete book",
  confirmEmpty: "Delete “{title}”? This can't be undone.",
  confirm: "Delete “{title}”? {kits} kits go with it. Credits are not returned.",
  studentWork: "{submissions} pieces of student work will be deleted too.",
  shared: "other teachers' kits",
  building: "still building",
  indexing: "still indexing",
};

const impact = (o: Partial<BookImpact> = {}): BookImpact => ({
  kits: 0, others: 0, processing: 0, indexing: false, submissions: 0, students: 0, classes: 0, ...o,
});

describe("bookDeleteConfirmText", () => {
  it("uses the short form for a book with no kits", () => {
    const s = bookDeleteConfirmText(T, "Science 8", impact());
    expect(s).toBe("Delete “Science 8”? This can't be undone.");
    expect(s).not.toMatch(/kits/);
  });

  it("names the kit count and the credit rule when there are kits", () => {
    const s = bookDeleteConfirmText(T, "Science 8", impact({ kits: 3 }));
    expect(s).toBe("Delete “Science 8”? 3 kits go with it. Credits are not returned.");
  });

  it("adds the student-work sentence, with its number, only when submissions exist", () => {
    const withWork = bookDeleteConfirmText(T, "Science 8", impact({ kits: 3, submissions: 12 }));
    expect(withWork).toMatch(/3 kits go with it/);
    expect(withWork).toMatch(/12 pieces of student work will be deleted too\.$/);
    const without = bookDeleteConfirmText(T, "Science 8", impact({ kits: 3 }));
    expect(without).not.toMatch(/student work/);
  });

  it("leaves no placeholder unfilled", () => {
    const s = bookDeleteConfirmText(T, "Science 8", impact({ kits: 2, submissions: 1 }));
    expect(s).not.toMatch(/\{\w+\}/);
  });
});

describe("the refusals", () => {
  it("reads them off the impact row — shared first, then indexing, then building", () => {
    expect(bookDeleteBlockedReason(impact())).toBeNull();
    expect(bookDeleteBlockedReason(impact({ processing: 1 }))).toBe("building");
    expect(bookDeleteBlockedReason(impact({ indexing: true }))).toBe("indexing");
    expect(bookDeleteBlockedReason(impact({ indexing: true, processing: 2 }))).toBe("indexing");
    expect(bookDeleteBlockedReason(impact({ others: 1, indexing: true, processing: 2 }))).toBe("shared");
  });

  it("recognises the RPC's fixed tokens and nothing else", () => {
    expect(blockedReasonFromError("shared_kits")).toBe("shared");
    expect(blockedReasonFromError("kit_building")).toBe("building");
    expect(blockedReasonFromError("P0001: book_indexing")).toBe("indexing");
    expect(blockedReasonFromError("not your book")).toBeNull();
    expect(blockedReasonFromError(null)).toBeNull();
  });
});

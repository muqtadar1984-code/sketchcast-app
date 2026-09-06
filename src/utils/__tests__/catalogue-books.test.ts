import { describe, it, expect } from "vitest";
import { bookIdentity, groupBooks } from "../catalogue/books";

const mk = (id: string, over: Partial<Parameters<typeof bookIdentity>[0]> = {}) => ({
  id,
  title: "Cambridge Lower Secondary Science 7",
  pages: 240,
  status: "ready",
  created_at: `2026-09-0${id.length % 9 + 1}T00:00:00Z`,
  content_hash: null as string | null,
  ...over,
});

describe("bookIdentity", () => {
  it("prefers the content hash when present", () => {
    expect(bookIdentity(mk("a", { content_hash: "abc" }))).toBe("hash:abc");
    expect(bookIdentity(mk("a", { content_hash: "abc", title: "anything" }))).toBe("hash:abc");
  });
  it("falls back to a normalised title plus page count", () => {
    expect(bookIdentity(mk("a"))).toBe("title:cambridge lower secondary science 7|240");
    expect(bookIdentity(mk("b", { title: "  CAMBRIDGE  Lower-Secondary Science 7 " }))).toBe("title:cambridge lower secondary science 7|240");
    expect(bookIdentity(mk("c", { title: "Énergie", pages: null }))).toBe("title:energie|?");
  });
  it("does not merge different page counts or titles", () => {
    expect(bookIdentity(mk("a", { pages: 241 }))).not.toBe(bookIdentity(mk("b")));
    expect(bookIdentity(mk("a", { title: "Science 8" }))).not.toBe(bookIdentity(mk("b")));
  });
});

describe("groupBooks", () => {
  const a = mk("a", { created_at: "2026-09-01T00:00:00Z" });
  const b = mk("b", { created_at: "2026-09-03T00:00:00Z" });
  const c = mk("c", { created_at: "2026-09-02T00:00:00Z", status: "indexing" });
  const other = mk("d", { title: "Physics 9", created_at: "2026-09-04T00:00:00Z" });

  it("collapses copies into one group with every copy listed oldest first", () => {
    const groups = groupBooks([b, c, a, other]);
    expect(groups).toHaveLength(2);
    const sci = groups.find((g) => g.copies.length === 3)!;
    expect(sci.copies.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("represents a group by a ready copy, then the most harvested, then the oldest", () => {
    // ready beats indexing even when indexing is older
    expect(groupBooks([c, b]).find((g) => g.copies.length === 2)!.representative.id).toBe("b");
    // among ready copies the one with candidates wins
    expect(groupBooks([a, b], (id) => (id === "b" ? 12 : 0)).find((g) => g.copies.length === 2)!.representative.id).toBe("b");
    // otherwise the oldest upload
    expect(groupBooks([a, b]).find((g) => g.copies.length === 2)!.representative.id).toBe("a");
  });

  it("orders groups newest representative first, like the shelf", () => {
    const groups = groupBooks([a, b, other]);
    expect(groups[0].representative.id).toBe("d");
  });

  it("uses the hash when both copies have one even if titles differ", () => {
    const x = mk("x", { content_hash: "h1", title: "Science 7 (scan)" });
    const y = mk("y", { content_hash: "h1", title: "science seven", pages: 12 });
    expect(groupBooks([x, y])).toHaveLength(1);
  });
});

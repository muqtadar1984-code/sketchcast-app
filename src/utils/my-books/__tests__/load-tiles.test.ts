// SK S7 K3 — the My books loader (rows from the service-role client, narrowed
// to the reader) and the strip's tiles: only finals the reader may access;
// verified children only; covers signed ONLY after the decision; a missing
// cover falls back; "Open in SK" only behind the SK gate.
// Run: node node_modules/vitest/vitest.mjs run src/utils/my-books/__tests__/load-tiles.test.ts
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { loadMyBooks } from "../load";
import { childLabel, COVER_LINK_SECONDS, myBookTiles } from "../tiles";
import { grant, KID, ME, NOW, P_ALG, P_BIO, P_OLD, PRODUCTS, RELEASES, STRANGER_KID } from "./fixtures";

const SCHOOL = "55555555-5555-5555-5555-555555555555";

function db(over: { grants?: ReturnType<typeof grant>[]; links?: Record<string, unknown>[]; entitlements?: Record<string, unknown>[]; profiles?: Record<string, unknown>[]; missing?: string[] } = {}) {
  return fakeDb(
    {
      sk_book_products: PRODUCTS,
      pub_releases: RELEASES,
      profiles: over.profiles ?? [
        { id: ME, school_id: null, full_name: "Parent", username: "p" },
        { id: KID, school_id: null, full_name: "Aisyah", username: "aisyah" },
        { id: STRANGER_KID, school_id: null, full_name: "Stranger", username: "s" },
      ],
      entitlements: over.entitlements ?? [],
      parent_links: over.links ?? [],
      book_access_grants: over.grants ?? [],
    },
    { missing: over.missing },
  );
}

describe("loadMyBooks", () => {
  it("lists only the finals the reader may access (own grant)", async () => {
    const out = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO })] }), ME, NOW);
    expect(out.map((b) => [b.productId, b.releaseId])).toEqual([[P_BIO, 12]]);
  });

  it("someone else's grant is not mine", async () => {
    expect(await loadMyBooks(db({ grants: [grant({ user_id: STRANGER_KID, product_id: P_BIO })] }), ME, NOW)).toEqual([]);
  });

  it("a school licence (through profiles.school_id) lists every live final, never a draft", async () => {
    const d = db({
      profiles: [{ id: ME, school_id: SCHOOL }],
      entitlements: [{ school_id: SCHOOL, user_id: null, plan_key: "school_annual", active: true, current_period_end: null }],
    });
    const out = await loadMyBooks(d, ME, NOW);
    expect(out.map((b) => b.productId).sort()).toEqual([P_ALG, P_BIO].sort());
    expect(out.every((b) => b.releaseId !== 13 && b.releaseId !== 40)).toBe(true);
  });

  it("a lapsed school licence does not", async () => {
    const d = db({
      profiles: [{ id: ME, school_id: SCHOOL }],
      entitlements: [{ school_id: SCHOOL, plan_key: "school_annual", active: true, current_period_end: "2026-10-01T00:00:00Z" }],
    });
    expect(await loadMyBooks(d, ME, NOW)).toEqual([]);
  });

  it("a VERIFIED child's grant shows for the parent, labelled with the child's name", async () => {
    const d = db({
      links: [{ parent_id: ME, child_id: KID, verified_at: "2026-09-01T00:00:00Z" }],
      grants: [grant({ user_id: KID, product_id: P_ALG, source: "edition_code" })],
    });
    const out = await loadMyBooks(d, ME, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ productId: P_ALG, forChildren: ["Aisyah"] });
  });

  it("an UNVERIFIED link gives the parent nothing", async () => {
    const d = db({
      links: [{ parent_id: ME, child_id: KID, verified_at: null }],
      grants: [grant({ user_id: KID, product_id: P_ALG })],
    });
    expect(await loadMyBooks(d, ME, NOW)).toEqual([]);
  });

  it("the PDF route's single-product read narrows to that product", async () => {
    const d = db({ grants: [grant({ user_id: ME, product_id: P_BIO }), grant({ user_id: ME, product_id: P_ALG })] });
    expect((await loadMyBooks(d, ME, NOW, { productId: P_ALG })).map((b) => b.productId)).toEqual([P_ALG]);
  });

  it("before 0172 (no pub_releases) or 0174 (no link columns): no books, never an error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO })], missing: ["pub_releases"] }), ME, NOW)).toEqual([]);
    expect(await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO })], missing: ["sk_book_products"] }), ME, NOW)).toEqual([]);
    err.mockRestore();
  });

  it("withdrawn: an existing purchaser keeps it; a later grant does not", async () => {
    const kept = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-01T00:00:00Z" })] }), ME, NOW);
    expect(kept.map((b) => [b.productId, b.withdrawn])).toEqual([[P_OLD, true]]);
    const late = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-20T00:00:00Z" })] }), ME, NOW);
    expect(late).toEqual([]);
  });
});

describe("myBookTiles", () => {
  it("signs covers ONLY for decided books, for 1 hour — never a PDF, never a book the reader may not have", async () => {
    const d = db({ grants: [grant({ user_id: ME, product_id: P_BIO })] });
    const sign = vi.fn(async (key: string, s: number) => `https://s3.example/${key}?X-Amz-Expires=${s}`);
    const tiles = await myBookTiles(await loadMyBooks(d, ME, NOW), { sign, skOpen: false });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith("books/x/editions/e12/cover.png", COVER_LINK_SECONDS);
    expect(COVER_LINK_SECONDS).toBe(3600);
    expect(tiles[0]).toMatchObject({
      productId: P_BIO,
      title: "Biology: Cells",
      language: "English",
      chapterCount: 10,
      coverUrl: "https://s3.example/books/x/editions/e12/cover.png?X-Amz-Expires=3600",
      pdfHref: `/api/library/book-pdf?product=${P_BIO}`,
      skHref: null,
    });
    // the tile carries no S3 key: the PDF is only ever signed by the route
    expect(JSON.stringify(tiles)).not.toContain("digital.pdf");
  });

  it("with no access, nothing is decided and nothing is signed", async () => {
    const sign = vi.fn(async () => "x");
    const tiles = await myBookTiles(await loadMyBooks(db(), ME, NOW), { sign, skOpen: true });
    expect(tiles).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("cover missing: no key → no signing and a null cover (the strip draws the fallback)", async () => {
    const books = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO })] }), ME, NOW);
    const sign = vi.fn(async () => "x");
    const tiles = await myBookTiles([{ ...books[0], coverKey: null }], { sign, skOpen: false });
    expect(tiles[0].coverUrl).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it("cover signing failing (bucket unset, S3 error) → a null cover, the tile still shows", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const books = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO })] }), ME, NOW);
    const tiles = await myBookTiles(books, { sign: async () => Promise.reject(new Error("AccessDenied")), skOpen: false });
    expect(tiles).toHaveLength(1);
    expect(tiles[0].coverUrl).toBeNull();
    err.mockRestore();
  });

  it("Open in SK only behind the SK gate, never for a withdrawn book or a child's book", async () => {
    const own = await loadMyBooks(db({ grants: [grant({ user_id: ME, product_id: P_BIO }), grant({ user_id: ME, product_id: P_OLD })] }), ME, NOW);
    const sign = async () => null;
    const closed = await myBookTiles(own, { sign, skOpen: false });
    expect(closed.map((t) => t.skHref)).toEqual([null, null]);
    const open = await myBookTiles(own, { sign, skOpen: true });
    expect(Object.fromEntries(open.map((t) => [t.productId, t.skHref]))).toEqual({ [P_BIO]: "/sk/biology", [P_OLD]: null });

    const kid = await loadMyBooks(
      db({ links: [{ parent_id: ME, child_id: KID, verified_at: "2026-09-01T00:00:00Z" }], grants: [grant({ user_id: KID, product_id: P_ALG })] }),
      ME,
      NOW,
    );
    expect((await myBookTiles(kid, { sign, skOpen: true }))[0].skHref).toBeNull();
  });

  it("the child label", () => {
    const t = { forChild: "for {name}", forYourChild: "for your child" };
    expect(childLabel(["Aisyah"], t)).toBe("for Aisyah");
    expect(childLabel(["Aisyah", "Omar"], t)).toBe("for Aisyah, Omar");
    expect(childLabel([""], t)).toBe("for your child");
  });
});

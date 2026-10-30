// SK S7 K3 — the My books access decision: finals only, skAccess for the
// reader (a live grant ONLY — a licence or plan opens no book, 2026-10-30),
// verified children's grants labelled, withdrawn books only for readers who
// held them before the withdrawal, superseded → the newest final.
// Run: node node_modules/vitest/vitest.mjs run src/utils/my-books/__tests__/decide.test.ts
import { describe, expect, it } from "vitest";
import { decideMyBooks, type MyBooksInput } from "../decide";
import { grant, KID, ME, NOW, P_ALG, P_BIO, P_DRAFT, P_LEGACY, P_OLD, PRODUCTS, release, RELEASES } from "./fixtures";

const input = (over: Partial<MyBooksInput> = {}): MyBooksInput => ({
  now: NOW,
  userId: ME,
  products: PRODUCTS,
  releases: RELEASES,
  schoolLicence: false,
  subscriptions: [],
  grants: [],
  children: [],
  ...over,
});
const ids = (i: MyBooksInput) => decideMyBooks(i).map((b) => b.productId);
/** A grant on EVERY product, made after Old Chemistry's withdrawal (2026-10-15): a new reader of each. */
const allGrants = (source = "staff") =>
  [P_BIO, P_ALG, P_OLD, P_DRAFT, P_LEGACY].map((product_id) => grant({ user_id: ME, product_id, source, activated_at: "2026-10-20T00:00:00Z" }));

describe("decideMyBooks — who sees what", () => {
  it("no access → nothing (the strip is hidden)", () => {
    expect(decideMyBooks(input())).toEqual([]);
  });

  it("a purchase grant lists that book only, on its LIVE final", () => {
    const out = decideMyBooks(input({ grants: [grant({ user_id: ME, product_id: P_BIO })] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      productId: P_BIO,
      slug: "biology",
      title: "Biology: Cells",
      language: "en",
      chapterCount: 10,
      releaseId: 12,
      pdfKey: "books/x/editions/e12/digital.pdf",
      coverKey: "books/x/editions/e12/cover.png",
      forChildren: [],
      withdrawn: false,
    });
  });

  it("every grant source counts (code, edition code, staff, promo)", () => {
    for (const source of ["code", "edition_code", "staff", "promo"]) {
      expect(ids(input({ grants: [grant({ user_id: ME, product_id: P_ALG, source })] }))).toEqual([P_ALG]);
    }
  });

  it("a revoked or expired grant does not", () => {
    expect(ids(input({ grants: [grant({ user_id: ME, product_id: P_BIO, revoked_at: "2026-10-20T00:00:00Z" })] }))).toEqual([]);
    expect(ids(input({ grants: [grant({ user_id: ME, product_id: P_BIO, expires_at: "2026-10-20T00:00:00Z" })] }))).toEqual([]);
  });

  it("a school licence or an SK subscription ALONE lists nothing — books are bought (founder 2026-10-30)", () => {
    const family = [{ plan_key: "family_monthly", active: true, current_period_end: null }];
    expect(ids(input({ schoolLicence: true }))).toEqual([]);
    expect(ids(input({ subscriptions: family }))).toEqual([]);
    // with a grant, the licence / plan reader sees exactly the granted book
    expect(ids(input({ schoolLicence: true, grants: [grant({ user_id: ME, product_id: P_BIO })] }))).toEqual([P_BIO]);
    expect(ids(input({ subscriptions: family, grants: [grant({ user_id: ME, product_id: P_ALG })] }))).toEqual([P_ALG]);
  });

  it("grants on every product list every LIVE final — never the withdrawn, draft or legacy one — whatever the plan", () => {
    const want = [P_BIO, P_ALG].sort();
    expect(ids(input({ grants: allGrants() })).sort()).toEqual(want);
    expect(ids(input({ schoolLicence: true, grants: allGrants("purchase") })).sort()).toEqual(want);
    expect(ids(input({ subscriptions: [{ plan_key: "family_monthly", active: true, current_period_end: null }], grants: allGrants() })).sort()).toEqual(want);
    // a plan without SK changes nothing either way
    expect(ids(input({ subscriptions: [{ plan_key: "teacher_pro_monthly", active: true, current_period_end: null }], grants: allGrants() })).sort()).toEqual(want);
  });

  it("tiles are sorted by title", () => {
    expect(decideMyBooks(input({ grants: allGrants() })).map((b) => b.title)).toEqual(["Biology: Cells", "Mastering Linear Equations"]);
  });
});

describe("decideMyBooks — drafts are never listed", () => {
  it("a product pointing at a draft is never a tile, even with a grant or a licence", () => {
    const out = decideMyBooks(input({ schoolLicence: true, grants: [grant({ user_id: ME, product_id: P_DRAFT })] }));
    expect(out.map((b) => b.productId)).not.toContain(P_DRAFT);
  });

  it("a newer live DRAFT of a book never replaces its final", () => {
    const [bio] = decideMyBooks(input({ grants: [grant({ user_id: ME, product_id: P_BIO })] }));
    expect(bio.releaseId).toBe(12); // not draft #13
  });

  it("a book whose only live release is a draft is not listed", () => {
    const rels = [release({ id: 50, work_uid: "w-2", release_kind: "draft" })];
    expect(ids(input({ releases: rels, grants: [grant({ user_id: ME, product_id: P_ALG })] }))).toEqual([]);
  });

  it("a product with no work_uid (the old W2 import) is not a release-backed book", () => {
    expect(ids(input({ grants: allGrants() }))).not.toContain(P_LEGACY);
  });
});

describe("decideMyBooks — parents and their verified children", () => {
  const kidGrant = grant({ user_id: KID, product_id: P_ALG, source: "code" });

  it("a book granted to a verified child shows for the parent, labelled with the child", () => {
    const out = decideMyBooks(input({ grants: [kidGrant], children: [{ id: KID, name: "Aisyah" }] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ productId: P_ALG, forChildren: ["Aisyah"] });
  });

  it("two children with the same book are both named", () => {
    const k2 = "44444444-4444-4444-4444-444444444444";
    const out = decideMyBooks(
      input({ grants: [kidGrant, grant({ user_id: k2, product_id: P_ALG })], children: [{ id: KID, name: "Aisyah" }, { id: k2, name: "Omar" }] }),
    );
    expect(out[0].forChildren).toEqual(["Aisyah", "Omar"]);
  });

  it("when the parent has access of their own, the tile is theirs (no child label)", () => {
    const out = decideMyBooks(input({ grants: [kidGrant, grant({ user_id: ME, product_id: P_ALG })], children: [{ id: KID, name: "Aisyah" }] }));
    expect(out[0].forChildren).toEqual([]);
  });

  it("a grant row of someone who is not a listed (verified) child gives nothing", () => {
    const out = decideMyBooks(input({ grants: [kidGrant], children: [] }));
    expect(out).toEqual([]);
  });
});

describe("decideMyBooks — withdrawn and superseded releases", () => {
  it("a superseded final is never served: the newest live final is", () => {
    // the product still points at #11 (the importer has not run yet); #12 superseded it
    const products = PRODUCTS.map((p) => (p.id === P_BIO ? { ...p, release_id: 11 } : p));
    const [bio] = decideMyBooks(input({ products, grants: [grant({ user_id: ME, product_id: P_BIO })] }));
    expect(bio.releaseId).toBe(12);
    expect(bio.pdfKey).toBe("books/x/editions/e12/digital.pdf");
  });

  it("a withdrawn book disappears for NEW readers — licence, subscription, or a grant made after the withdrawal", () => {
    expect(ids(input({ schoolLicence: true, grants: allGrants() }))).not.toContain(P_OLD);
    expect(ids(input({ subscriptions: [{ plan_key: "homeschool_annual", active: true, current_period_end: null }], grants: allGrants() }))).not.toContain(P_OLD);
    expect(ids(input({ grants: [grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-20T00:00:00Z" })] }))).toEqual([]);
  });

  it("an EXISTING purchaser keeps the withdrawn book and its PDF, marked withdrawn, with no SK link material", () => {
    const out = decideMyBooks(input({ grants: [grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-01T00:00:00Z" })] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ productId: P_OLD, withdrawn: true, releaseId: 30, pdfKey: "books/x/editions/e30/digital.pdf" });
  });

  it("…the same for a parent whose verified child held it", () => {
    const out = decideMyBooks(
      input({ grants: [grant({ user_id: KID, product_id: P_OLD, activated_at: "2026-10-01T00:00:00Z" })], children: [{ id: KID, name: "Aisyah" }] }),
    );
    expect(out[0]).toMatchObject({ productId: P_OLD, withdrawn: true, forChildren: ["Aisyah"] });
  });

  it("withdrawn before the importer ran (product still approved) behaves the same", () => {
    const products = PRODUCTS.map((p) => (p.id === P_OLD ? { ...p, status: "approved", release_id: 30, release_kind: "final" } : p));
    expect(ids(input({ products, grants: allGrants() }))).not.toContain(P_OLD);
    expect(ids(input({ products, grants: [grant({ user_id: ME, product_id: P_OLD })] }))).toEqual([P_OLD]);
  });

  it("a revoked grant does not keep a withdrawn book", () => {
    expect(ids(input({ grants: [grant({ user_id: ME, product_id: P_OLD, revoked_at: "2026-10-16T00:00:00Z" })] }))).toEqual([]);
  });
});

// SK S7 K3 — GET /api/my-books/pdf: refuses without access (and mints no
// link), redirects to a 10-minute presigned link with access, logs the
// download in analytics_access_log (scope book_download), and sends the reader
// back with "not available yet" when S3 refuses ("[sk-library] s3 denied").
// The access decision itself is tested in src/utils/my-books/__tests__.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/my-books/__tests__/pdf-route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, type FakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { grant, KID, ME, P_ALG, P_BIO, P_DRAFT, P_OLD, PRODUCTS, RELEASES } from "@/utils/my-books/__tests__/fixtures";

const mocks = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  admin: null as unknown,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  probe: vi.fn(async (): Promise<string> => "ok"),
  link: vi.fn(async (key: string, name?: string, s?: number): Promise<string | null> => `https://s3.example/${key}?X-Amz-Expires=${s}&n=${encodeURIComponent(name ?? "")}`),
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: (table: string) => ({ insert: async (row: Record<string, unknown>) => (mocks.inserts.push({ table, row }), { error: null }) }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));
vi.mock("@/utils/books/files", () => ({ s3Probe: mocks.probe, s3Link: mocks.link }));

import { GET } from "@/app/api/my-books/pdf/route";

const req = (product: string) => new NextRequest(`https://app.example/api/my-books/pdf?product=${product}`);
function setDb(grants: ReturnType<typeof grant>[], links: Record<string, unknown>[] = []): FakeDb {
  const d = fakeDb({
    sk_book_products: PRODUCTS,
    pub_releases: RELEASES,
    profiles: [{ id: ME, school_id: null }, { id: KID, full_name: "Aisyah" }],
    entitlements: [],
    parent_links: links,
    book_access_grants: grants,
  });
  mocks.admin = d;
  return d;
}

beforeEach(() => {
  mocks.user = { id: ME, email: "reader@example.com" };
  setDb([]);
});
afterEach(() => {
  mocks.inserts = [];
  vi.clearAllMocks();
  mocks.probe.mockImplementation(async () => "ok");
});

describe("GET /api/my-books/pdf", () => {
  it("signed out → 401, nothing signed", async () => {
    mocks.user = null;
    const res = await GET(req(P_BIO));
    expect(res.status).toBe(401);
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("a malformed product id → 404", async () => {
    const res = await GET(req("../../etc"));
    expect(res.status).toBe(404);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("no access → 404; no probe, no link, no log", async () => {
    const res = await GET(req(P_BIO));
    expect(res.status).toBe(404);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.inserts).toEqual([]);
  });

  it("a draft-only product → 404 even with a grant (drafts are never served)", async () => {
    setDb([grant({ user_id: ME, product_id: P_DRAFT })]);
    expect((await GET(req(P_DRAFT))).status).toBe(404);
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("with access → 302 to a 10-minute link to the LIVE final's digital PDF, named after the book, and logged", async () => {
    setDb([grant({ user_id: ME, product_id: P_BIO })]);
    const res = await GET(req(P_BIO));
    expect(res.status).toBe(302);
    expect(mocks.probe).toHaveBeenCalledWith("books/x/editions/e12/digital.pdf");
    expect(mocks.link).toHaveBeenCalledWith("books/x/editions/e12/digital.pdf", "Biology Cells.pdf", 600);
    expect(res.headers.get("location")).toBe("https://s3.example/books/x/editions/e12/digital.pdf?X-Amz-Expires=600&n=Biology%20Cells.pdf");
    expect(mocks.inserts).toEqual([
      {
        table: "analytics_access_log",
        row: { actor_id: ME, scope: "book_download", target_kind: "sk_book_product", target_id: P_BIO, detail: { release_id: 12, for_child: false, withdrawn: false } },
      },
    ]);
  });

  it("a parent downloads a verified child's book", async () => {
    setDb([grant({ user_id: KID, product_id: P_ALG, source: "code" })], [{ parent_id: ME, child_id: KID, verified_at: "2026-09-01T00:00:00Z" }]);
    const res = await GET(req(P_ALG));
    expect(res.status).toBe(302);
    expect(mocks.inserts[0].row.detail).toEqual({ release_id: 20, for_child: true, withdrawn: false });
  });

  it("withdrawn: an existing purchaser still downloads; a new grant holder gets 404", async () => {
    setDb([grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-01T00:00:00Z" })]);
    expect((await GET(req(P_OLD))).status).toBe(302);
    expect(mocks.link).toHaveBeenCalledWith("books/x/editions/e30/digital.pdf", expect.any(String), 600);
    vi.clearAllMocks();
    setDb([grant({ user_id: ME, product_id: P_OLD, activated_at: "2026-10-20T00:00:00Z" })]);
    expect((await GET(req(P_OLD))).status).toBe(404);
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("S3 refuses the role → back to the Library with 'not available yet', logged '[sk-library] s3 denied', no link", async () => {
    setDb([grant({ user_id: ME, product_id: P_BIO })]);
    mocks.probe.mockImplementation(async () => "denied");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(P_BIO));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.example/dashboard?book_pdf=unavailable");
    expect(err).toHaveBeenCalledWith("[sk-library] s3 denied", "books/x/editions/e12/digital.pdf");
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.inserts).toEqual([]);
    err.mockRestore();
  });

  it("a missing file → the same 'not available yet'", async () => {
    setDb([grant({ user_id: ME, product_id: P_BIO })]);
    mocks.probe.mockImplementation(async () => "missing");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(P_BIO));
    expect(res.headers.get("location")).toBe("https://app.example/dashboard?book_pdf=unavailable");
    err.mockRestore();
  });
});

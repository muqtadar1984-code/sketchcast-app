/**
 * /api/deck/{genId} — the route that replaced the signed deck URL the student
 * row used to hold.
 *
 * WHY IT EXISTS. The first cut rendered an hour-long signed URL into the row's
 * href and tried to refuse a stale one on the CLIENT, by measuring the link's
 * age from the row's mount. A client-router restore defeats that exactly:
 * returning via back/forward after an hour remounts the row with the CACHED
 * hour-old URL and a FRESH mount clock, so the age reads as zero, the expired
 * link passes, the row writes "Completed", and the download then fails at
 * storage. The row now holds no signed URL at all — it holds this path, and
 * the URL is minted on the click with a one-minute life.
 *
 * What is pinned below:
 *   * the PERMISSION DECISION — the quiz route's share check, reused, not
 *     re-implemented: a direct share, or a share to a class the student is
 *     enrolled in, and nothing else; a stranger who knows the id is refused
 *     before any storage path is read;
 *   * the ARTIFACT SELECTION — only deck_pptx is eligible, so naming a
 *     generation can never fetch its docx (legacy ones carry the answer key)
 *     or its questions_json (which IS the marking scheme);
 *   * the handler: 401 before the service role is built, a signed URL that
 *     lives ~60 s and carries the Deck.pptx disposition, and a 302 that is
 *     never cached.
 *
 * Run: npx vitest run src/app/api/deck/__tests__/deck.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { GET } from "@/app/api/deck/[genId]/route";
import {
  DECK_FILENAME,
  DECK_URL_TTL_SECONDS,
  pickDeckPath,
  resolveDeckWith,
  type DeckStore,
} from "@/app/api/deck/logic";
import { docDownloadName } from "@/utils/download-name";
import { FakeStore } from "@/app/api/quiz/__tests__/fake-store";

const GEN = "11111111-1111-4111-8111-111111111111";
const OTHER_GEN = "33333333-3333-4333-8333-333333333333";
const STU = "22222222-2222-4222-8222-222222222222";
const OTHER_STU = "44444444-4444-4444-8444-444444444444";
const CLASS = "55555555-5555-4555-8555-555555555555";
const DECK_PATH = "u1/g1/deck.pptx";

const art = (gen: string, kind: string, path: string) => ({ generation_id: gen, kind, storage_path: path });

/** Assigned by a DIRECT share (parent portal / homeschool). */
const directStore = () =>
  new FakeStore({
    generation_shares: [{ id: "share-1", generation_id: GEN, student_id: STU, class_id: null }],
    enrollments: [],
    artifacts: [art(GEN, "deck_pptx", DECK_PATH)],
  });

/** Assigned by a CLASS share the student is enrolled in. */
const classStore = () =>
  new FakeStore({
    generation_shares: [{ id: "share-2", generation_id: GEN, student_id: null, class_id: CLASS }],
    enrollments: [{ class_id: CLASS, student_id: STU }],
    artifacts: [art(GEN, "deck_pptx", DECK_PATH)],
  });

const store = (s: FakeStore) => s as unknown as DeckStore;

// ── 1. the permission decision ──────────────────────────────────────────────

describe("resolveDeckWith — who may have the file", () => {
  it("hands a directly-shared deck to the student it was shared with", async () => {
    await expect(resolveDeckWith(store(directStore()), STU, GEN)).resolves.toEqual({
      ok: true,
      path: DECK_PATH,
      filename: DECK_FILENAME,
    });
  });

  it("hands a class-shared deck to a student enrolled in that class", async () => {
    await expect(resolveDeckWith(store(classStore()), STU, GEN)).resolves.toEqual({
      ok: true,
      path: DECK_PATH,
      filename: DECK_FILENAME,
    });
  });

  it("refuses a student the deck was shared with SOMEONE ELSE directly", async () => {
    await expect(resolveDeckWith(store(directStore()), OTHER_STU, GEN)).resolves.toEqual({
      ok: false,
      status: 403,
      error: "This deck isn't assigned to you.",
    });
  });

  it("refuses a student who is not enrolled in the class it was shared with", async () => {
    const db = classStore();
    db.tables.enrollments = [{ class_id: "66666666-6666-4666-8666-666666666666", student_id: OTHER_STU }];
    const r = await resolveDeckWith(store(db), OTHER_STU, GEN);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a generation that was never shared at all — knowing the id is not entitlement", async () => {
    const db = directStore();
    db.tables.artifacts.push(art(OTHER_GEN, "deck_pptx", "u1/g2/deck.pptx"));
    const r = await resolveDeckWith(store(db), STU, OTHER_GEN);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("404s an id that is not a UUID, without reading anything", async () => {
    const db = directStore();
    const before = db.tables.generation_shares.length;
    await expect(resolveDeckWith(store(db), STU, "../../etc/passwd")).resolves.toEqual({
      ok: false,
      status: 404,
      error: "No such deck.",
    });
    expect(db.tables.generation_shares).toHaveLength(before);
  });

  it("404s an assigned generation that carries no deck file", async () => {
    const db = directStore();
    db.tables.artifacts = [art(GEN, "docx", "u1/g1/worksheet.docx")];
    await expect(resolveDeckWith(store(db), STU, GEN)).resolves.toEqual({
      ok: false,
      status: 404,
      error: "No such deck.",
    });
  });

  it("names the file Deck.pptx — the same name the signed URL used to bake in", () => {
    expect(DECK_FILENAME).toBe(docDownloadName("deck", "deck_pptx"));
    expect(DECK_FILENAME).toBe("Deck.pptx");
  });
});

// ── 2. the artifact selection ───────────────────────────────────────────────

describe("pickDeckPath — only ever the deck file", () => {
  it("picks the deck_pptx out of a generation's artifacts", () => {
    expect(pickDeckPath([art(GEN, "docx", "a.docx"), art(GEN, "deck_pptx", DECK_PATH)])).toBe(DECK_PATH);
  });

  it("never selects an answer key, a document or the marking scheme", () => {
    // Built by filtering FOR deck_pptx, so a kind the worker adds tomorrow is
    // dropped by construction rather than left in by an omitted exclusion.
    for (const kind of ["docx", "answer_key_docx", "questions_json", "video_mp4", "deck_pdf", "anything_new"]) {
      expect(pickDeckPath([art(GEN, kind, `x.${kind}`)]), kind).toBeNull();
    }
  });

  it("takes PART 1 when several deck files exist — by part number, not by path order", () => {
    // ICU collation puts "." after "_", so a path sort would put the
    // unsuffixed Part 1 behind deck_part2.pptx and hand over the wrong file.
    const parts = [art(GEN, "deck_pptx", "u/g/deck_part2.pptx"), art(GEN, "deck_pptx", "u/g/deck.pptx")];
    expect(pickDeckPath(parts)).toBe("u/g/deck.pptx");
  });

  it("is null for nothing at all, and for rows with no usable path", () => {
    expect(pickDeckPath([])).toBeNull();
    expect(pickDeckPath(null)).toBeNull();
    expect(pickDeckPath(undefined)).toBeNull();
    expect(pickDeckPath([{ kind: "deck_pptx", storage_path: null }])).toBeNull();
    expect(pickDeckPath([{ kind: "deck_pptx", storage_path: "" }])).toBeNull();
  });
});

// ── 3. the handler ──────────────────────────────────────────────────────────

/** The service-role client the handler builds: the FakeStore's reads plus the
 * one storage call this route makes. `signed` records what it was asked for. */
function adminFor(db: FakeStore) {
  const signed: { path: string; expiresIn: number; opts?: { download?: string } }[] = [];
  return {
    signed,
    client: {
      from: (t: string) => db.from(t),
      storage: {
        from: () => ({
          createSignedUrl: async (path: string, expiresIn: number, opts?: { download?: string }) => {
            signed.push({ path, expiresIn, opts });
            return { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/artifacts/${path}?token=jwt` } };
          },
        }),
      },
    },
  };
}

const signedIn = (id: string | null) => ({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
/** The dynamic segment as Next 16 hands it over: a PROMISE, not a string. */
const get = (id: string) =>
  GET(new Request(`http://localhost/api/deck/${id}`), { params: Promise.resolve({ genId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(signedIn(STU));
});

describe("GET /api/deck/[genId]", () => {
  it("401s a signed-out caller and never builds the service-role client", async () => {
    mocks.createClient.mockResolvedValue(signedIn(null));
    const res = await get(GEN);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Not signed in." });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("500s with a readable line when the service-role client cannot be built", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
    });
    const res = await get(GEN);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Deck downloads are unavailable right now.");
    expect(body.error).not.toMatch(/SERVICE_ROLE|missing/i);
  });

  it("AWAITS the params promise, then redirects to a URL minted right now", async () => {
    // Unawaited, `params` would stringify to "[object Promise]", fail the UUID
    // test and 404 — so a 302 to the signed path is the proof it was awaited.
    const a = adminFor(directStore());
    mocks.createAdminClient.mockReturnValue(a.client);
    const res = await get(GEN);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(DECK_PATH);
    expect(a.signed).toHaveLength(1);
    expect(a.signed[0].path).toBe(DECK_PATH);
  });

  it("signs for about a minute, with the Deck.pptx disposition — not the hour the page used to render", async () => {
    const a = adminFor(directStore());
    mocks.createAdminClient.mockReturnValue(a.client);
    await get(GEN);
    expect(a.signed[0].expiresIn).toBe(DECK_URL_TTL_SECONDS);
    expect(DECK_URL_TTL_SECONDS).toBeLessThanOrEqual(120);
    expect(a.signed[0].opts).toEqual({ download: "Deck.pptx" });
  });

  it("never lets the redirect be cached — a cached one would outlive its target", async () => {
    const a = adminFor(directStore());
    mocks.createAdminClient.mockReturnValue(a.client);
    const res = await get(GEN);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("403s a student the deck is not assigned to, and signs NOTHING", async () => {
    mocks.createClient.mockResolvedValue(signedIn(OTHER_STU));
    const a = adminFor(directStore());
    mocks.createAdminClient.mockReturnValue(a.client);
    const res = await get(GEN);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "This deck isn't assigned to you." });
    expect(a.signed).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("502s rather than redirecting nowhere when the signing itself comes back empty", async () => {
    const db = directStore();
    mocks.createAdminClient.mockReturnValue({
      from: (t: string) => db.from(t),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
    });
    const res = await get(GEN);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Deck couldn't load — refresh the page" });
  });
});

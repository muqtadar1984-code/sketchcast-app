/**
 * SK S6 slice B — POST /api/sk/stt/url. 404 with SK_STT unset (before auth is
 * consulted); the SK gate (flag, allow-list, sign-in); a student without
 * `voice` consent → 403 no_voice_consent, with it → a URL; an adult needs no
 * consent; language mapping and 400 for anything else; 30 URLs per user per
 * hour; the URL's host, params and X-Amz-Security-Token; and the URL never in
 * a log line. Credentials are a stub — no AWS call anywhere.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/stt-url.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S6Db } from "@/sk/__tests__/s6-fake-db";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { POST } from "@/app/api/sk/stt/url/route";
import { __setSttForTests } from "@/sk/speech/transcribe-server";

const STU = "22222222-2222-4222-8222-222222222222";
const KID = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";
const TEACHER = "55555555-5555-4555-8555-555555555555";
const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLE/token+value=";

const signedIn = (id: string | null, email = "t@example.com") =>
  mocks.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: id ? { id, email, email_confirmed_at: "2026-01-01T00:00:00Z" } : null } }) },
  });
const req = (body: unknown) =>
  new Request("http://x/api/sk/stt/url", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function db() {
  return new S6Db({
    profiles: [
      { id: STU, role: "student", school_id: null },
      { id: KID, role: "student", school_id: null },
      { id: TEACHER, role: "teacher", school_id: "sch-1" },
      { id: PARENT, role: "parent", school_id: null },
    ],
    schools: [{ id: "sch-1", config: {} }],
    consents: [{ guardian_id: PARENT, child_id: KID, scope: "voice", revoked_at: null }],
    parent_links: [{ parent_id: PARENT, child_id: KID, verified_at: "2026-10-01T00:00:00Z" }],
  });
}

let logs: unknown[][];
beforeEach(() => {
  process.env.FEATURE_SK = "true";
  process.env.SK_STT = "transcribe";
  delete process.env.SK_ALLOWED_EMAILS;
  delete process.env.STT_REGION;
  signedIn(TEACHER);
  mocks.createAdminClient.mockImplementation(() => db());
  __setSttForTests({ credentials: async () => ({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: TOKEN }) });
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => {
  __setSttForTests();
  delete process.env.FEATURE_SK;
  delete process.env.SK_STT;
  delete process.env.SK_ALLOWED_EMAILS;
  delete process.env.STT_REGION;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const reason = async (r: Response) => ((await r.json()) as { reason?: string }).reason;

describe("flag and gate", () => {
  it("404 when SK_STT is unset — before auth or the database is consulted", async () => {
    delete process.env.SK_STT;
    const r = await POST(req({ lang: "en" }));
    expect(r.status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
  it("404 for any SK_STT value other than transcribe", async () => {
    process.env.SK_STT = "browser";
    expect((await POST(req({ lang: "en" }))).status).toBe(404);
  });
  it("404 when FEATURE_SK is off, even with SK_STT=transcribe", async () => {
    delete process.env.FEATURE_SK;
    expect((await POST(req({ lang: "en" }))).status).toBe(404);
  });
  it("404 for a user off the SK allow-list; 401 signed out", async () => {
    process.env.SK_ALLOWED_EMAILS = "founder@example.com";
    signedIn(TEACHER, "someone@example.com");
    expect((await POST(req({ lang: "en" }))).status).toBe(404);
    delete process.env.SK_ALLOWED_EMAILS;
    signedIn(null);
    expect((await POST(req({ lang: "en" }))).status).toBe(401);
  });
  it("the allow-listed user gets through", async () => {
    process.env.SK_ALLOWED_EMAILS = "founder@example.com";
    signedIn(TEACHER, "founder@example.com");
    expect((await POST(req({ lang: "en" }))).status).toBe(200);
  });
});

describe("consent (decision 3: Transcribe for a student needs `voice`)", () => {
  it("a student without voice consent → 403 no_voice_consent, and nothing is signed", async () => {
    signedIn(STU);
    const r = await POST(req({ lang: "en" }));
    expect(r.status).toBe(403);
    expect(await reason(r)).toBe("no_voice_consent");
  });
  it("a student whose verified guardian granted voice → a URL", async () => {
    signedIn(KID);
    expect((await POST(req({ lang: "ms" }))).status).toBe(200);
  });
  it("a revoked grant or an UNVERIFIED link is no consent", async () => {
    signedIn(KID);
    const d = db();
    d.tables.parent_links![0]!.verified_at = null;
    mocks.createAdminClient.mockImplementation(() => d);
    expect((await POST(req({ lang: "en" }))).status).toBe(403);
    const d2 = db();
    d2.tables.consents![0]!.revoked_at = "2026-10-20T00:00:00Z";
    mocks.createAdminClient.mockImplementation(() => d2);
    expect((await POST(req({ lang: "en" }))).status).toBe(403);
  });
  it("adults (teacher, parent) are allowed without anyone's consent", async () => {
    signedIn(TEACHER);
    expect((await POST(req({ lang: "en" }))).status).toBe(200);
    signedIn(PARENT);
    expect((await POST(req({ lang: "en" }))).status).toBe(200);
  });
  it("fails closed: an unreadable profile or no service key → 403", async () => {
    signedIn("66666666-6666-4666-8666-666666666666");
    expect((await POST(req({ lang: "en" }))).status).toBe(403);
    signedIn(TEACHER);
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    expect((await POST(req({ lang: "en" }))).status).toBe(403);
  });
});

describe("language", () => {
  it.each([
    ["en", "en-US"],
    ["ms", "ms-MY"],
    ["ms-arab", "ms-MY"],
    ["ar", "ar-SA"],
    ["zh", "zh-CN"],
    ["en-US", "en-US"],
  ])("%s → %s", async (lang, code) => {
    const r = await POST(req({ lang }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string; languageCode: string };
    expect(j.languageCode).toBe(code);
    expect(new URL(j.url).searchParams.get("language-code")).toBe(code);
  });
  it("400 unsupported_language for any other locale, a missing lang or a bad body", async () => {
    for (const body of [{ lang: "hi" }, { lang: "fr" }, { lang: "" }, {}, { lang: 7 }, "not json", "[1]"]) {
      const r = await POST(req(body));
      expect(r.status).toBe(400);
      expect(await reason(r)).toBe("unsupported_language");
    }
  });
});

describe("the reply", () => {
  it("{ url, expiresAt, languageCode }, no-store; the URL has the host, params and the session token", async () => {
    const before = Date.now();
    const r = await POST(req({ lang: "ar" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const j = (await r.json()) as { url: string; expiresAt: string; languageCode: string };
    expect(Object.keys(j).sort()).toEqual(["expiresAt", "languageCode", "url"]);
    const u = new URL(j.url);
    expect(u.protocol).toBe("wss:");
    expect(u.host).toBe("transcribestreaming.us-east-1.amazonaws.com:8443");
    expect(u.pathname).toBe("/stream-transcription-websocket");
    expect(u.searchParams.get("media-encoding")).toBe("pcm");
    expect(u.searchParams.get("sample-rate")).toBe("16000");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-Security-Token")).toBe(TOKEN);
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^ASIAEXAMPLE\/\d{8}\/us-east-1\/transcribe\/aws4_request$/);
    const exp = Date.parse(j.expiresAt);
    expect(exp - before).toBeGreaterThanOrEqual(299_000);
    expect(exp - before).toBeLessThanOrEqual(301_000);
  });
  it("STT_REGION picks the regional host", async () => {
    process.env.STT_REGION = "eu-west-1";
    const j = (await (await POST(req({ lang: "en" }))).json()) as { url: string };
    expect(new URL(j.url).host).toBe("transcribestreaming.eu-west-1.amazonaws.com:8443");
  });
  it("no credentials → 503 unavailable, logged WITHOUT any URL", async () => {
    __setSttForTests({
      credentials: async () => {
        throw new Error("transcribe: no AWS credentials configured");
      },
    });
    const r = await POST(req({ lang: "en" }));
    expect(r.status).toBe(503);
    expect(await reason(r)).toBe("unavailable");
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(/wss:|X-Amz|amazonaws/);
  });
  it("the signed URL and its token never reach a log line", async () => {
    const r = await POST(req({ lang: "en" }));
    const { url } = (await r.json()) as { url: string };
    const all = JSON.stringify(logs);
    expect(all).not.toContain(url);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/X-Amz-Signature|wss:\/\//);
  });
});

describe("rate limit: 30 URLs per user per hour (per instance)", () => {
  it("the 31st request in the hour → 429 rate_limited; another user is unaffected", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(req({ lang: "en" }))).status).toBe(200);
    const r = await POST(req({ lang: "en" }));
    expect(r.status).toBe(429);
    expect(await reason(r)).toBe("rate_limited");
    signedIn(PARENT);
    expect((await POST(req({ lang: "en" }))).status).toBe(200);
  });
  it("refusals (403, 400) do not spend the budget", async () => {
    signedIn(STU);
    for (let i = 0; i < 35; i++) expect((await POST(req({ lang: "en" }))).status).toBe(403);
    signedIn(TEACHER);
    for (let i = 0; i < 35; i++) expect((await POST(req({ lang: "hi" }))).status).toBe(400);
    expect((await POST(req({ lang: "en" }))).status).toBe(200);
  });
  it("the hour rolls: budget comes back after an hour", async () => {
    const { takeSttUrl } = await import("@/sk/speech/transcribe-server");
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(takeSttUrl("u", t0 + i)).toBe(true);
    expect(takeSttUrl("u", t0 + 1000)).toBe(false);
    expect(takeSttUrl("u", t0 + 60 * 60_000 + 1)).toBe(true);
  });
});

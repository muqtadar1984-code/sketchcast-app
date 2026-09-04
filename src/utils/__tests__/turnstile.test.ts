import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyTurnstile, hostnameOf } from "../turnstile";

const EXPECT = { action: "school_register", hostname: "app.sketchcast.app" };

function stubSiteverify(body: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("hostnameOf — the host header as siteverify reports it", () => {
  it("lower-cases, drops the port and a trailing dot, nulls the empty", () => {
    expect(hostnameOf("App.SketchCast.app:443")).toBe("app.sketchcast.app");
    expect(hostnameOf("localhost:3000")).toBe("localhost");
    expect(hostnameOf("app.sketchcast.app.")).toBe("app.sketchcast.app");
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf(null)).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
  });
  afterEach(() => {
    process.env = env;
    vi.unstubAllGlobals();
  });

  it("is DARK without a secret — skips, and says so, without calling Cloudflare", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchMock = stubSiteverify({ success: true });
    expect(await verifyTurnstile(null, null, EXPECT)).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with a secret, refuses a missing or oversized token before calling Cloudflare", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    const fetchMock = stubSiteverify({ success: true });
    expect(await verifyTurnstile(null, "1.2.3.4", EXPECT)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyTurnstile("x".repeat(2049), "1.2.3.4", EXPECT)).toEqual({ ok: false, reason: "missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only success + the expected action + the expected hostname", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    stubSiteverify({ success: true, action: "school_register", hostname: "app.sketchcast.app" });
    expect(await verifyTurnstile("tok", "1.2.3.4", EXPECT)).toEqual({ ok: true, skipped: false });
  });

  it("refuses a token solved for another surface — success alone is not enough", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    stubSiteverify({ success: true, action: "login", hostname: "app.sketchcast.app" });
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: false, reason: "action" });
  });

  it("refuses a token solved on another host, comparing the way siteverify reports hostnames", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    stubSiteverify({ success: true, action: "school_register", hostname: "evil.example" });
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: false, reason: "hostname" });
    stubSiteverify({ success: true, action: "school_register", hostname: "APP.sketchcast.app" });
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: true, skipped: false });
  });

  it("refuses when the request has no host to bind to", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    stubSiteverify({ success: true, action: "school_register", hostname: "app.sketchcast.app" });
    expect(await verifyTurnstile("tok", null, { action: "school_register", hostname: null })).toEqual({ ok: false, reason: "no-host" });
  });

  it("surfaces Cloudflare's error codes, and fails CLOSED on a non-2xx or an outage", async () => {
    process.env.TURNSTILE_SECRET_KEY = "s";
    stubSiteverify({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: false, reason: "timeout-or-duplicate" });
    stubSiteverify({}, 503);
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: false, reason: "siteverify 503" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifyTurnstile("tok", null, EXPECT)).toEqual({ ok: false, reason: "unreachable" });
    quiet.mockRestore();
  });

  it("sends the secret, the token and the caller's IP to siteverify — and nothing else", async () => {
    process.env.TURNSTILE_SECRET_KEY = "shh";
    const fetchMock = stubSiteverify({ success: true, action: "school_register", hostname: "app.sketchcast.app" });
    await verifyTurnstile("tok", "9.9.9.9", EXPECT);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(Object.fromEntries(init.body)).toEqual({ secret: "shh", response: "tok", remoteip: "9.9.9.9" });
  });
});

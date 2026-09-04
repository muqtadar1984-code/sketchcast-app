import { describe, expect, it } from "vitest";
import { SIGNED_URL_AGE_MARGIN_MS, signedUrlExpired, signedUrlExpiresAt, signedUrlLifetimeMs, signedUrlWindow } from "../signed-url";

// A Supabase signed URL: …/storage/v1/object/sign/<bucket>/<path>?token=<jwt>
// (plus &download=<name> when signed with a disposition). The JWT payload is
// { url, iat, exp }. These build one with a chosen window rather than fixing a
// real token, so the assertions read as instants, not as opaque strings.
const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;
const signed = (exp: number, extra = "", iat = exp - 3600) =>
  `https://x.supabase.co/storage/v1/object/sign/artifacts/u/g/deck.pptx?token=${jwt({ url: "artifacts/u/g/deck.pptx", iat, exp })}${extra}`;

const HOUR = 3600_000;

describe("signedUrlWindow / signedUrlExpiresAt", () => {
  it("reads iat and exp (seconds) off the token and reports them in milliseconds", () => {
    expect(signedUrlWindow(signed(1_800_000_000))).toEqual({ issuedAt: 1_799_996_400_000, expiresAt: 1_800_000_000_000 });
    expect(signedUrlExpiresAt(signed(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it("still reads them when the URL also carries a download disposition", () => {
    expect(signedUrlExpiresAt(signed(1_800_000_000, "&download=Deck.pptx"))).toBe(1_800_000_000_000);
    expect(signedUrlLifetimeMs(signed(1_800_000_000, "&download=Deck.pptx"))).toBe(HOUR);
  });

  it("reads a payload whose base64url needs padding", () => {
    // A payload length not divisible by 4 once the '=' are stripped — the
    // common case for real tokens; atob rejects it without the padding back.
    for (const exp of [3601, 3612, 3723, 4834, 12345, 1_800_000_001]) {
      expect(signedUrlExpiresAt(signed(exp))).toBe(exp * 1000);
    }
  });

  it("fails OPEN — null — for anything that is not a readable signed URL", () => {
    expect(signedUrlWindow("not a url")).toBeNull();
    expect(signedUrlWindow("https://x.supabase.co/storage/v1/object/public/artifacts/a.pptx")).toBeNull();
    expect(signedUrlWindow("https://x.supabase.co/a?token=notajwt")).toBeNull();
    expect(signedUrlWindow(`https://x.supabase.co/a?token=${b64url("{}")}.${b64url("not json")}.s`)).toBeNull();
    expect(signedUrlWindow(`https://x.supabase.co/a?token=${jwt({ url: "a" })}`)).toBeNull();
    expect(signedUrlWindow(`https://x.supabase.co/a?token=${jwt({ exp: "soon", iat: 1 })}`)).toBeNull();
    // exp alone is not a lifetime — an age check has nothing to measure against.
    expect(signedUrlWindow(`https://x.supabase.co/a?token=${jwt({ exp: 1_800_000_000 })}`)).toBeNull();
    expect(signedUrlExpiresAt(`https://x.supabase.co/a?token=${jwt({ exp: 1_800_000_000 })}`)).toBeNull();
  });
});

describe("signedUrlLifetimeMs", () => {
  it("is exp minus iat — the hour the dashboard signs for", () => {
    expect(signedUrlLifetimeMs(signed(1_800_000_000))).toBe(HOUR);
    expect(signedUrlLifetimeMs(signed(1_800_000_000, "", 1_800_000_000 - 60))).toBe(60_000);
  });

  it("treats a non-positive lifetime as unreadable — never an instant refusal", () => {
    expect(signedUrlLifetimeMs(signed(1_800_000_000, "", 1_800_000_000))).toBeNull();
    expect(signedUrlLifetimeMs(signed(1_800_000_000, "", 1_800_000_001))).toBeNull();
    expect(signedUrlLifetimeMs("garbage")).toBeNull();
  });
});

describe("signedUrlExpired — by AGE held, never by the device clock", () => {
  const url = signed(1_800_000_000); // a one-hour token, minted on the server's clock
  const mountedAt = 5_000_000_000_000; // the device's clock — nowhere near the server's

  it("is false while the link has been held for less than its lifetime (minus the margin)", () => {
    expect(signedUrlExpired(url, mountedAt, mountedAt)).toBe(false);
    expect(signedUrlExpired(url, mountedAt, mountedAt + 30 * 60_000)).toBe(false);
    expect(signedUrlExpired(url, mountedAt, mountedAt + HOUR - SIGNED_URL_AGE_MARGIN_MS)).toBe(false);
  });

  it("is true once the age passes lifetime minus margin — the render-to-mount gap the row cannot see", () => {
    expect(signedUrlExpired(url, mountedAt, mountedAt + HOUR - SIGNED_URL_AGE_MARGIN_MS + 1)).toBe(true);
    expect(signedUrlExpired(url, mountedAt, mountedAt + HOUR)).toBe(true);
    expect(signedUrlExpired(url, mountedAt, mountedAt + 3 * HOUR)).toBe(true);
  });

  it("a device clock set years FAST (or slow) changes nothing — only the elapsed hold counts", () => {
    // The old check compared exp against Date.now(): a device already past
    // the token's exp refused every click forever. The age check does not
    // know what the device thinks the date is.
    const fast = 1_800_000_000_000 + 365 * 24 * HOUR;
    expect(signedUrlExpired(url, fast, fast + 1_000)).toBe(false);
    const slow = 1_700_000_000_000;
    expect(signedUrlExpired(url, slow, slow + 1_000)).toBe(false);
    expect(signedUrlExpired(url, slow, slow + 2 * HOUR)).toBe(true);
  });

  it("the margin is a parameter — zero margin refuses exactly past the lifetime", () => {
    expect(signedUrlExpired(url, mountedAt, mountedAt + HOUR, 0)).toBe(false);
    expect(signedUrlExpired(url, mountedAt, mountedAt + HOUR + 1, 0)).toBe(true);
  });

  it("never calls an unreadable URL expired — a shape change must not refuse every click", () => {
    expect(signedUrlExpired("https://x.supabase.co/a", 0, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(signedUrlExpired("garbage", 0, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(signedUrlExpired(`https://x.supabase.co/a?token=${jwt({ exp: 1 })}`, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

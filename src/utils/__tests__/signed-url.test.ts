import { describe, expect, it } from "vitest";
import { signedUrlExpiresAt, signedUrlExpired } from "../signed-url";

// A Supabase signed URL: …/storage/v1/object/sign/<bucket>/<path>?token=<jwt>
// (plus &download=<name> when signed with a disposition). The JWT payload is
// { url, iat, exp }. These build one with a chosen exp rather than fixing a
// real token, so the assertions read as instants, not as opaque strings.
const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;
const signed = (exp: number, extra = "") =>
  `https://x.supabase.co/storage/v1/object/sign/artifacts/u/g/deck.pptx?token=${jwt({ url: "artifacts/u/g/deck.pptx", iat: exp - 3600, exp })}${extra}`;

describe("signedUrlExpiresAt", () => {
  it("reads exp (seconds) off the token and reports it in milliseconds", () => {
    expect(signedUrlExpiresAt(signed(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it("still reads it when the URL also carries a download disposition", () => {
    expect(signedUrlExpiresAt(signed(1_800_000_000, "&download=Deck.pptx"))).toBe(1_800_000_000_000);
  });

  it("reads a payload whose base64url needs padding", () => {
    // A payload length not divisible by 4 once the '=' are stripped — the
    // common case for real tokens; atob rejects it without the padding back.
    for (const exp of [1, 12, 123, 1234, 12345, 1_800_000_001]) {
      expect(signedUrlExpiresAt(signed(exp))).toBe(exp * 1000);
    }
  });

  it("fails OPEN — null — for anything that is not a readable signed URL", () => {
    expect(signedUrlExpiresAt("not a url")).toBeNull();
    expect(signedUrlExpiresAt("https://x.supabase.co/storage/v1/object/public/artifacts/a.pptx")).toBeNull();
    expect(signedUrlExpiresAt("https://x.supabase.co/a?token=notajwt")).toBeNull();
    expect(signedUrlExpiresAt(`https://x.supabase.co/a?token=${b64url("{}")}.${b64url("not json")}.s`)).toBeNull();
    expect(signedUrlExpiresAt(`https://x.supabase.co/a?token=${jwt({ url: "a" })}`)).toBeNull();
    expect(signedUrlExpiresAt(`https://x.supabase.co/a?token=${jwt({ exp: "soon" })}`)).toBeNull();
  });
});

describe("signedUrlExpired", () => {
  const exp = 1_800_000_000;

  it("is false while the hour is still running", () => {
    expect(signedUrlExpired(signed(exp), exp * 1000 - 1)).toBe(false);
  });

  it("is true from the expiry instant on — the same instant storage refuses", () => {
    expect(signedUrlExpired(signed(exp), exp * 1000)).toBe(true);
    expect(signedUrlExpired(signed(exp), exp * 1000 + 60_000)).toBe(true);
  });

  it("never calls an unreadable URL expired — a shape change must not refuse every click", () => {
    expect(signedUrlExpired("https://x.supabase.co/a", Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(signedUrlExpired("garbage", Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

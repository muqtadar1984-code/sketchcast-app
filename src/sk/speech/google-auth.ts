// SK voice (founder 2026-10-30) — a Google OAuth access token for Cloud TTS
// from a service-account key, with no new dependency. Server only.
//
// The GCP org forbids API keys, so the route authenticates as a service
// account: the key JSON lives in GOOGLE_APPLICATION_CREDENTIALS_JSON (Vercel
// has no key file), an RS256 JWT is signed with node:crypto from its
// `private_key` / `client_email`, and the JWT-bearer grant at Google's token
// endpoint trades it for a one-hour access token. The token is cached in
// module memory until five minutes before it expires; concurrent callers
// share one exchange. The token URI is fixed — the key's own `token_uri` is
// never followed, so a signed assertion only ever goes to Google.
//
// Errors carry the HTTP status and Google's error code only, never the key,
// the assertion or the token.

import { createSign } from "node:crypto";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TTS_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Re-mint this long before the token's own expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const ASSERTION_LIFETIME_S = 3600;

export type ServiceAccount = { client_email: string; private_key: string };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The key JSON → { client_email, private_key }, or null when it is missing
 * or unusable. A `private_key` whose newlines arrived double-escaped (a
 * common paste into an env UI) is repaired. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  if (!raw || !raw.trim()) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const { client_email, private_key } = j as { client_email?: unknown; private_key?: unknown };
  if (typeof client_email !== "string" || !client_email || typeof private_key !== "string" || !private_key.includes("PRIVATE KEY")) return null;
  return { client_email, private_key: private_key.replace(/\\n/g, "\n") };
}

export function googleTtsConfigured(): boolean {
  return Boolean((process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? "").trim());
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString("base64url");

/** header.claims.signature, RS256, valid for an hour from `nowSec`. */
export function signAssertion(sa: ServiceAccount, nowSec: number, scope: string = GOOGLE_TTS_SCOPE): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + ASSERTION_LIFETIME_S }));
  const input = `${header}.${claims}`;
  const sig = createSign("RSA-SHA256").update(input).sign(sa.private_key);
  return `${input}.${b64url(sig)}`;
}

export type TokenSourceOptions = {
  /** The service account; default: GOOGLE_APPLICATION_CREDENTIALS_JSON, read per mint. */
  credentials?: () => ServiceAccount | null;
  fetch?: FetchLike;
  /** Milliseconds since the epoch; tests pass a fake clock. */
  now?: () => number;
};

export class GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly credentials: () => ServiceAccount | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  /** Token exchanges made (tests). */
  mints = 0;

  constructor(opts: TokenSourceOptions = {}) {
    this.credentials = opts.credentials ?? (() => parseServiceAccount(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON));
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
  }

  /** A valid access token: the cached one, or a fresh exchange. */
  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.cached.token;
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Drop the cached token (Google answered 401 to it). */
  invalidate(): void {
    this.cached = null;
  }

  private async mint(): Promise<string> {
    const sa = this.credentials();
    if (!sa) throw new Error("google auth: GOOGLE_APPLICATION_CREDENTIALS_JSON is missing or not a service-account key");
    const t0 = this.now();
    const assertion = signAssertion(sa, Math.floor(t0 / 1000));
    this.mints++;
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!res.ok || !j || typeof j.access_token !== "string" || !j.access_token) {
      const code = j && typeof j.error === "string" ? ` ${j.error}` : "";
      throw new Error(`google auth: token exchange failed (HTTP ${res.status}${code})`);
    }
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    this.cached = { token: j.access_token, expiresAt: t0 + ttl * 1000 };
    return j.access_token;
  }
}

let shared: GoogleTokenSource | null = null;

/** The process-wide token source (one cached token per server instance). */
export function googleTokenSource(): GoogleTokenSource {
  if (!shared) shared = new GoogleTokenSource();
  return shared;
}

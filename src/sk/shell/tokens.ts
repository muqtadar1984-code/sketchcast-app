// SK action tokens (Final Plan §8.2, §9.2). A confirm-tier action is never
// executed from model output or from a client-supplied parameter set: the
// server resolves the params, stores them in sk_action_tokens with an HMAC
// over the STORED fields, and hands the client an opaque token. Execution
// re-reads the row, re-derives the HMAC, checks user / expiry / context, and
// consumes atomically through the DB RPC (0163 `sk_consume_action_token`),
// which the per-action RPC calls inside its own transaction.
//
// Pure helpers + two thin DB adapters over a narrow admin surface so tests
// run on a fake. The admin client is the ONLY client allowed here (§8.1).

import { createHmac, randomBytes } from "node:crypto";

export const SK_TOKEN_TTL_SECONDS = 600; // §8.2: 10 minutes by default

export type ActionParams = Record<string, string | number | boolean | null>;

/** S4 slice D: params whose key starts with `sealed_` are stored and signed
 *  with the token (the server needs them at execution) but are NEVER sent to
 *  the browser on the card and NEVER written to the audit row — e.g.
 *  book.activate's code HMAC. */
export const SEALED_PARAM_PREFIX = "sealed_";

/** The params minus the sealed ones: what the card shows and the audit keeps. */
export function publicParams<T extends Record<string, unknown>>(params: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) if (!k.startsWith(SEALED_PARAM_PREFIX)) out[k] = v;
  return out as Partial<T>;
}

export type ActionTokenRow = {
  id: string;
  user_id: string;
  action: string;
  params: ActionParams;
  params_canonical: string;
  context_hash: string;
  nonce: string;
  hmac: string;
  expires_at: string;
  used_at: string | null;
};

/** The narrow admin surface tokens.ts uses; typed loosely for fakes. */
export type TokenDb = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** Stable JSON: keys sorted, no whitespace, so the HMAC does not depend on
 *  insertion order. Values are scalars only (ActionParams). */
export function canonicalParams(params: ActionParams): string {
  const keys = Object.keys(params).sort();
  return JSON.stringify(keys.map((k) => [k, params[k] ?? null]));
}

export function tokenSecret(): string | null {
  const s = (process.env.SK_SHELL_SECRET || process.env.BOOK_CODE_SECRET || "").trim();
  return s.length >= 16 ? s : null;
}

export function signToken(secret: string, f: { userId: string; action: string; canonical: string; contextHash: string; nonce: string; expiresAt: string }): string {
  return createHmac("sha256", secret).update([f.userId, f.action, f.canonical, f.contextHash, f.nonce, f.expiresAt].join("|")).digest("hex");
}

/** The opaque string the client carries: `<row id>.<hmac>`. */
export function encodeToken(id: string, hmac: string): string {
  return `${id}.${hmac}`;
}

export function decodeToken(token: string): { id: string; hmac: string } | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(token.trim());
  return m ? { id: m[1], hmac: m[2] } : null;
}

export type IssueInput = {
  userId: string;
  action: string;
  params: ActionParams;
  contextHash: string;
  now?: Date;
  ttlSeconds?: number;
};

export type Issued = { token: string; id: string; expiresAt: string };

/** Issues a token: one sk_action_tokens row. Refuses (null) when no secret is
 *  configured — confirm-tier actions are then unavailable rather than weak. */
export async function issueActionToken(db: TokenDb, input: IssueInput): Promise<Issued | null> {
  const secret = tokenSecret();
  if (!secret) return null;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? SK_TOKEN_TTL_SECONDS) * 1000).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const canonical = canonicalParams(input.params);
  const hmac = signToken(secret, { userId: input.userId, action: input.action, canonical, contextHash: input.contextHash, nonce, expiresAt });
  const { data, error } = await db
    .from("sk_action_tokens")
    .insert({
      user_id: input.userId,
      action: input.action,
      params: input.params,
      params_canonical: canonical,
      context_hash: input.contextHash,
      nonce,
      hmac,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data?.id) return null;
  return { token: encodeToken(String(data.id), hmac), id: String(data.id), expiresAt };
}

export type VerifyResult =
  | { ok: true; row: ActionTokenRow }
  | { ok: false; outcome: "not_found" | "refused" | "expired" | "already_used" | "context_mismatch" };

/**
 * Re-reads the row and re-derives the HMAC from the STORED fields (§8.2), so
 * a client can never alter what it confirmed. Does NOT consume: the per-action
 * RPC does that inside its own transaction (§9.2).
 */
export async function verifyActionToken(
  db: TokenDb,
  token: string,
  expect: { userId: string; contextHash: string; now?: Date },
): Promise<VerifyResult> {
  const secret = tokenSecret();
  const parts = decodeToken(token);
  if (!secret || !parts) return { ok: false, outcome: "refused" };
  const { data, error } = await db.from("sk_action_tokens").select("*").eq("id", parts.id).maybeSingle();
  if (error || !data) return { ok: false, outcome: "not_found" };
  const row = data as ActionTokenRow;
  const expected = signToken(secret, {
    userId: row.user_id,
    action: row.action,
    canonical: row.params_canonical,
    contextHash: row.context_hash,
    nonce: row.nonce,
    expiresAt: new Date(row.expires_at).toISOString(),
  });
  // Constant-time-ish compare: lengths are fixed (64 hex); compare all chars.
  let diff = expected.length ^ parts.hmac.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (parts.hmac.charCodeAt(i) || 0);
  if (diff !== 0 || row.hmac !== parts.hmac) return { ok: false, outcome: "refused" };
  if (row.user_id !== expect.userId) return { ok: false, outcome: "refused" };
  if (row.params_canonical !== canonicalParams(row.params)) return { ok: false, outcome: "refused" };
  if (row.used_at) return { ok: false, outcome: "already_used" };
  if (new Date(row.expires_at).getTime() <= (expect.now ?? new Date()).getTime()) return { ok: false, outcome: "expired" };
  if (row.context_hash !== expect.contextHash) return { ok: false, outcome: "context_mismatch" };
  return { ok: true, row };
}

/** The generic atomic consume (0163). Per-action RPCs call the SQL function
 *  themselves; this adapter exists for actions with no write of their own. */
export async function consumeActionToken(db: TokenDb, id: string, contextHash: string): Promise<string> {
  const { data, error } = await db.rpc("sk_consume_action_token", { p_token: id, p_context_hash: contextHash });
  if (error) return "error";
  return typeof data === "string" ? data : String(data ?? "error");
}

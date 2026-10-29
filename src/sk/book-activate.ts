// Book activation for a chosen child (SK S4 slice D; design 2026-10-29
// decision 3) — the PURE part, shared by the /activate page, its client form,
// the SK `book.activate` capability and the rules router. No Node imports, no
// database: the server half (HMACs, the redeem RPCs, the children read) lives
// in ./book-redeem.
//
// Who gets the book: a parent (any non-student) with VERIFIED linked children
// activates for ONE of them — one child is picked automatically, two or more
// must be chosen, there is no "for me" while a child is linked. With no
// linked child the grant goes to the signed-in user (today's behaviour).

import { CARD_PREFIX, CODE_BODY_LEN, EDITION_PREFIX, formatCode, isWellFormedCode, isWellFormedOrderNumber, normalizeCode, normalizeOrderNumber } from "./codes";

export type BookCodeKind = "card" | "edition";

// ── Children ─────────────────────────────────────────────────────────────────

export type LinkedChild = { id: string; name: string };

type LinkRow = {
  parent_id?: string | null;
  child_id?: string | null;
  verified_at?: string | null;
  profiles?: { full_name?: string | null; username?: string | null } | Array<{ full_name?: string | null; username?: string | null }> | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** parent_links rows → this parent's VERIFIED children, named, sorted, de-duplicated.
 *  Rows of another parent, unverified links and malformed ids are dropped here
 *  even though the query already filters them (defence in depth). */
export function verifiedChildrenFrom(rows: unknown, parentId: string): LinkedChild[] {
  const out = new Map<string, LinkedChild>();
  for (const r of (Array.isArray(rows) ? rows : []) as LinkRow[]) {
    if (!r || r.parent_id !== parentId || !r.verified_at || !isUuid(r.child_id)) continue;
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    const name = (p?.full_name || p?.username || "").trim() || "Child";
    out.set(r.child_id, { id: r.child_id, name });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the activation form shows. `self` = no picker (students, teachers,
 *  anyone without a verified child); `self_note` = a parent with no linked
 *  child: no picker, a note that it activates for them; `one` = the child is
 *  preselected; `pick` = 2+ children, required, no default. */
export type ChildPicker =
  | { mode: "self" }
  | { mode: "self_note" }
  | { mode: "one"; child: LinkedChild; children: LinkedChild[] }
  | { mode: "pick"; children: LinkedChild[] };

export function childPicker(role: string | null | undefined, children: LinkedChild[]): ChildPicker {
  if (role === "student") return { mode: "self" };
  if (children.length === 1) return { mode: "one", child: children[0]!, children };
  if (children.length > 1) return { mode: "pick", children };
  return role === "parent" ? { mode: "self_note" } : { mode: "self" };
}

/** The child the form submits for, or null (= for me). `undefined` = the
 *  parent must still choose (2+ children, nothing picked): do not submit. */
export function forChildFor(picker: ChildPicker, chosen: string | null | undefined): string | null | undefined {
  if (picker.mode === "self" || picker.mode === "self_note") return null;
  if (picker.mode === "one") return picker.child.id;
  return picker.children.some((c) => c.id === chosen) ? (chosen as string) : undefined;
}

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export type ChildPick = { kind: "one"; child: LinkedChild } | { kind: "many"; options: LinkedChild[] } | { kind: "none"; query: string } | { kind: "self" };

/**
 * Resolve the child for a parent's activation. An explicit id must be one of
 * the verified children (else none). A spoken name matches a whole name, a
 * first name, or a unique prefix. No name: one child → that child; 2+ → ask;
 * none linked → self.
 */
export function pickChild(children: LinkedChild[], o: { childId?: string; childQuery?: string }): ChildPick {
  if (o.childId) {
    const c = children.find((x) => x.id === o.childId);
    return c ? { kind: "one", child: c } : { kind: "none", query: o.childId };
  }
  const q = fold(o.childQuery ?? "");
  if (!q) {
    if (!children.length) return { kind: "self" };
    if (children.length === 1) return { kind: "one", child: children[0]! };
    return { kind: "many", options: children };
  }
  if (!children.length) return { kind: "none", query: o.childQuery ?? "" };
  const byWhole = children.filter((c) => fold(c.name) === q);
  if (byWhole.length === 1) return { kind: "one", child: byWhole[0]! };
  const byWord = children.filter((c) => fold(c.name).split(" ").includes(q) || q.split(" ").includes(fold(c.name).split(" ")[0]!));
  if (byWord.length === 1) return { kind: "one", child: byWord[0]! };
  const byPrefix = children.filter((c) => fold(c.name).startsWith(q));
  if (byPrefix.length === 1) return { kind: "one", child: byPrefix[0]! };
  if (byWord.length > 1) return { kind: "many", options: byWord };
  if (byPrefix.length > 1) return { kind: "many", options: byPrefix };
  return { kind: "none", query: o.childQuery ?? "" };
}

/** First name for the card and the lines ("Aisyah" from "Aisyah binti Ali"). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

// ── Codes ────────────────────────────────────────────────────────────────────

/** Which kind of book code this is, by its FORMAT only (prefix + 16-character
 *  body + check character). A code card carries a batch prefix that starts
 *  with SKB (SKB, SKB2, …); an edition code is exactly SKE. Null = malformed.
 *  Says nothing about whether the code exists (that is the RPC's job). */
export function bookCodeKind(input: string): BookCodeKind | null {
  const n = normalizeCode(input);
  const pl = n.length - (CODE_BODY_LEN + 1);
  if (pl < 3) return null;
  const prefix = n.slice(0, pl);
  if (prefix === EDITION_PREFIX) return isWellFormedCode(n, EDITION_PREFIX) ? "edition" : null;
  if (prefix.startsWith(CARD_PREFIX) && prefix.length <= 6 && isWellFormedCode(n, prefix)) return "card";
  return null;
}

/** "SKE-ABCD-EFGH-JKMN-PQRSC" → "SKE-••••-••••-••••-•QRSC": the prefix (the
 *  same on every copy or batch) and the last 4 characters only. */
export function maskCode(input: string): string {
  const n = normalizeCode(input);
  const printed = formatCode(n);
  const pl = Math.max(0, n.length - (CODE_BODY_LEN + 1));
  let seen = 0; // alphanumerics seen so far in the printed form
  const keepFrom = n.length - 4;
  return [...printed]
    .map((ch) => {
      if (ch === "-") return ch;
      const i = seen++;
      return i < pl || i >= keepFrom ? ch : "•";
    })
    .join("");
}

/** "123-1234567-1234567" → "•••-•••••••-•••4567". */
export function maskOrderNumber(input: string): string {
  const n = normalizeOrderNumber(input);
  let digits = n.replace(/\D/g, "").length;
  return [...n].map((ch) => (/\d/.test(ch) ? (--digits < 4 ? ch : "•") : ch)).join("");
}

const PUNCT_EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}*~$=]+$/gu;

export type FoundCode = { code: string; kind: BookCodeKind | null; start: number; end: number };

/** The first book code in what someone typed or said, by its FORMAT: a token
 *  starting SKB…/SKE…, possibly split by spaces or dashes into blocks. Returns
 *  the well-formed reading when there is one; otherwise the token as typed
 *  with kind null (so SK can say the code looks wrong). Null = no code at all. */
export function findBookCode(raw: string): FoundCode | null {
  const tokens: Array<{ text: string; start: number; end: number }> = [];
  for (const m of (raw ?? "").matchAll(/\S+/g)) tokens.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  for (let i = 0; i < tokens.length; i++) {
    const head = normalizeCode(tokens[i]!.text.replace(PUNCT_EDGE, ""));
    if (!/^SK[BE]/.test(head)) continue;
    for (let j = i; j < Math.min(tokens.length, i + 7); j++) {
      const joined = tokens
        .slice(i, j + 1)
        .map((t) => t.text.replace(PUNCT_EDGE, ""))
        .join("");
      const kind = bookCodeKind(joined);
      if (kind) return { code: normalizeCode(joined), kind, start: tokens[i]!.start, end: tokens[j]!.end };
      if (normalizeCode(joined).length > CODE_BODY_LEN + 7) break;
    }
    // Not well-formed. It still counts as an attempt at a code (so SK says it
    // looks wrong, and it never reaches the model) only when it LOOKS like one:
    // the printed dash form, or a prefix followed by 4–5 character blocks.
    // "skeleton" is a word, not a code.
    const tok = tokens[i]!.text.replace(PUNCT_EDGE, "");
    const dashed = /^sk[be][0-9a-z]{0,2}-[0-9a-z]{3,6}(?:-|$)/i.test(tok);
    const blocks = /^sk[be][0-9]?$/i.test(tok) && /^[0-9a-z]{4,5}$/i.test(tokens[i + 1]?.text.replace(PUNCT_EDGE, "") ?? "") && /^[0-9a-z]{4,5}$/i.test(tokens[i + 2]?.text.replace(PUNCT_EDGE, "") ?? "");
    const dense = head.length >= CODE_BODY_LEN && /\d/.test(tok);
    if (dashed || dense) return { code: normalizeCode(tok), kind: null, start: tokens[i]!.start, end: tokens[i]!.end };
    if (blocks) {
      const last = tokens[Math.min(tokens.length - 1, i + 4)]!;
      const span = tokens.slice(i, Math.min(tokens.length, i + 5)).map((t) => t.text.replace(PUNCT_EDGE, "")).join("");
      return { code: normalizeCode(span), kind: null, start: tokens[i]!.start, end: last.end };
    }
  }
  return null;
}

/** An Amazon order number anywhere in the text (17 digits, dashes/spaces optional). */
export function findOrderNumber(raw: string): string | null {
  const m = (raw ?? "").match(/(?<!\d)(\d{3})[\s-]?(\d{7})[\s-]?(\d{7})(?!\d)/);
  if (!m) return null;
  const n = `${m[1]}-${m[2]}-${m[3]}`;
  return isWellFormedOrderNumber(n) ? n : null;
}

/** Mask every book code and order number in a string — for audit params and
 *  the remembered conversation, so a code typed to SK is never stored. */
export function maskBookSecrets(text: string): string {
  let out = text ?? "";
  for (let guard = 0; guard < 5; guard++) {
    const f = findBookCode(out);
    if (!f) break;
    out = out.slice(0, f.start) + (f.kind ? maskCode(f.code) : "SK•••") + out.slice(f.end);
  }
  out = out.replace(/(?<!\d)(\d{3})([\s-]?)(\d{7})([\s-]?)(\d{3})(\d{4})(?!\d)/g, (_m, _a, s1, _b, s2, _c, d) => `•••${s1}•••••••${s2}•••${d}`);
  // Anything left in the printed dash form (a malformed code) is masked whole.
  return out.replace(/SK[BE][0-9A-Z]{0,2}(?:-[0-9A-Z*~$=]{3,6}){2,5}/gi, "SK•••");
}

/** Mask the secrets in an args object (string leaves only). */
export function maskBookSecretsDeep<T>(value: T): T {
  if (typeof value === "string") return maskBookSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => maskBookSecretsDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskBookSecretsDeep(v);
    return out as T;
  }
  return value;
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

/** Every refusal redeem_book_code() / redeem_edition_code() returns, plus the
 *  route-side ones (bad_order, not_configured, error). */
export const REDEEM_REASONS = ["invalid", "used", "revoked", "rate_limited", "not_your_child", "order_used", "daily_cap", "bad_order", "not_configured", "error"] as const;
export type RedeemReason = (typeof REDEEM_REASONS)[number];

export const toRedeemReason = (v: unknown): RedeemReason => ((REDEEM_REASONS as readonly string[]).includes(String(v)) ? (v as RedeemReason) : "error");

/** The /activate form's message key (dictionary `activate.errors.*`) for a
 *  route refusal: the route's `reason`, else the HTTP status. */
export type ActivateErrorKey = "invalid" | "used" | "revoked" | "rateLimited" | "notYourChild" | "orderUsed" | "dailyCap" | "badOrder" | "notConfigured" | "generic";
export function activateErrorKey(reason: unknown, status?: number): ActivateErrorKey {
  switch (reason) {
    case "invalid":
      return "invalid";
    case "used":
      return "used";
    case "revoked":
      return "revoked";
    case "rate_limited":
      return "rateLimited";
    case "not_your_child":
      return "notYourChild";
    case "order_used":
      return "orderUsed";
    case "daily_cap":
      return "dailyCap";
    case "bad_order":
      return "badOrder";
    case "not_configured":
      return "notConfigured";
  }
  if (status === 503) return "notConfigured";
  if (status === 429) return "rateLimited";
  if (status === 403) return "notYourChild";
  return "generic";
}

// `book.activate` — activate a book code for yourself (student) or for one of
// your verified children (parent). SK S4 slice D (design 2026-10-29 decision
// 3; Final Plan §4 "Activate book code": student confirm, parent confirm;
// §9.2: CLICK-ONLY — it spends a code).
//
// "activate my book code SKE-… for Aisyah", "I have a code", "aktifkan kod
// buku", "فعّل الكود".
//
// This handler RESOLVES, it never redeems. It reads the code's FORMAT only
// (SKB… code card or SKE edition code; nothing is looked up, so a format
// check never counts against the 5-per-hour rate limit), asks for what is
// missing — the Amazon order number for an edition code, which child when a
// parent has two or more — and returns a `confirm` card. The redeem happens
// only in /api/sk/act → act-book.ts, after the click.
//
// THE CODE NEVER LEAVES THIS HANDLER IN CLEAR. The card shows it masked
// (prefix + last 4); the token row stores only its HMAC (and the order
// number's), under `sealed_*` params that the turn route never sends to the
// browser and the act audit never records (tokens.ts publicParams). The
// rules router sends any utterance that contains a code here directly, so a
// code is never part of a model prompt either, and the runner masks codes in
// its audit params. While SK waits for the order number or the child, the
// HMACs ride in the signed conversation memory's `pending` slot.
//
// Children are read through the USER-SESSION client (parent_links' RLS:
// parent_id = auth.uid()), verified links only; the RPC checks the link
// again at execution.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { lineFor } from "@/sk/shell/lines";
import {
  BOOK_ASK_CHILD,
  BOOK_ASK_CODE,
  BOOK_ASK_ORDER,
  BOOK_BAD_CODE,
  BOOK_BAD_ORDER,
  BOOK_CARD_NOTE,
  BOOK_CARD_TITLE_FOR,
  BOOK_CARD_TITLE_SELF,
  BOOK_CHILD_NOT_FOUND,
  BOOK_CODE_KIND_CARD,
  BOOK_CODE_KIND_EDITION,
  BOOK_NOT_ON,
  BOOK_NOT_YOUR_CHILD,
} from "@/sk/shell/act-book-lines";
import { hmacCode, hmacOrderNumber, isWellFormedOrderNumber } from "@/sk/access";
import { bookCodeKind, findOrderNumber, firstName, isUuid, maskCode, maskOrderNumber, pickChild, type BookCodeKind, type LinkedChild } from "@/sk/book-activate";
import { bookCodeSecret, verifiedChildren } from "@/sk/book-redeem";

export const BOOK_PENDING_TASK = "book.activate";

/** What SK holds between turns while it asks (signed memory, HMACs only). */
export type BookPending = { need: "order" | "child"; kind: BookCodeKind; h: string; m: string; o?: string; om?: string; c?: string };

const HEX64 = /^[0-9a-f]{64}$/;

export function encodeBookPending(p: BookPending): { task: string; needs: string[] } {
  return {
    task: BOOK_PENDING_TASK,
    needs: [p.need, `k:${p.kind}`, `h:${p.h}`, `m:${p.m}`, ...(p.o ? [`o:${p.o}`] : []), ...(p.om ? [`om:${p.om}`] : []), ...(p.c ? [`c:${p.c}`] : [])],
  };
}

export function parseBookPending(pending: { task: string; needs: string[] } | null | undefined): BookPending | null {
  if (!pending || pending.task !== BOOK_PENDING_TASK || !Array.isArray(pending.needs)) return null;
  const get = (k: string) => pending.needs.find((n) => typeof n === "string" && n.startsWith(`${k}:`))?.slice(k.length + 1);
  const need = pending.needs[0] === "order" || pending.needs[0] === "child" ? pending.needs[0] : null;
  const kind = get("k");
  const h = get("h") ?? "";
  if (!need || (kind !== "card" && kind !== "edition") || !HEX64.test(h)) return null;
  const o = get("o");
  const c = get("c");
  return { need, kind, h, m: get("m") ?? "", ...(o && HEX64.test(o) ? { o, om: get("om") ?? "" } : {}), ...(c && isUuid(c) ? { c } : {}) };
}

const argStr = (args: Record<string, unknown>, key: string, max = 80): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, max) : "");

/** "for my daughter" names nobody: treat as no name. */
const GENERIC_CHILD_RE = /^(?:(?:my|the|our)\s+)?(?:son|daughter|child|kid|boy|girl|anak(?:\s+(?:saya|lelaki|perempuan))?|ابني|ابنتي|طفلي)$/iu;

export async function resolveBookActivate(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const say = (table: Record<string, string>, error: string, vars: Record<string, string | number> = {}, extra: Partial<SkCapabilityResult> = {}): SkCapabilityResult => ({
    ok: error === "",
    summary: lineFor(table, locale, vars),
    facts: [],
    ...(error ? { error } : {}),
    ...extra,
  });
  const secret = bookCodeSecret();
  if (!secret) return say(BOOK_NOT_ON, "not_configured", {}, { pending: null });

  const pend = parseBookPending(ctx.pending);
  const rawChildQuery = argStr(args, "childQuery", 60);
  const childQuery = GENERIC_CHILD_RE.test(rawChildQuery) ? "" : rawChildQuery;

  // ── The code (format only) ────────────────────────────────────────────────
  const codeIn = argStr(args, "code", 60);
  let kind: BookCodeKind;
  let h: string;
  let masked: string;
  if (codeIn) {
    const k = bookCodeKind(codeIn);
    if (!k) return say(BOOK_BAD_CODE, "bad_code", {}, { pending: null });
    kind = k;
    h = hmacCode(codeIn, secret);
    masked = maskCode(codeIn);
  } else if (pend) {
    ({ kind, h, m: masked } = pend);
  } else {
    return { ok: true, summary: lineFor(BOOK_ASK_CODE, locale), facts: [], pending: null };
  }

  // ── The order number (edition codes) ──────────────────────────────────────
  let o: string | undefined;
  let om: string | undefined;
  if (kind === "edition") {
    const orderIn = argStr(args, "orderNumber", 40) || (findOrderNumber(childQuery) ?? "");
    if (orderIn) {
      if (!isWellFormedOrderNumber(orderIn)) return say(BOOK_BAD_ORDER, "bad_order", {}, { pending: encodeBookPending({ need: "order", kind, h, m: masked, ...(pend?.c ? { c: pend.c } : {}) }) });
      o = hmacOrderNumber(orderIn, secret);
      om = maskOrderNumber(orderIn);
    } else if (pend?.o && !codeIn) {
      o = pend.o;
      om = pend.om;
    } else {
      return { ok: true, summary: lineFor(BOOK_ASK_ORDER, locale), facts: [], pending: encodeBookPending({ need: "order", kind, h, m: masked, ...(pend?.c ? { c: pend.c } : {}) }) };
    }
  }

  // ── Who it is for ─────────────────────────────────────────────────────────
  let child: LinkedChild | null = null;
  if (ctx.user.role !== "student") {
    const children = await verifiedChildren(deps.session, ctx.user.id);
    const childId = argStr(args, "childId", 64) || (pend?.c && !childQuery ? pend.c : "");
    const nameQuery = childQuery.replace(/(?<!\d)\d{3}[\s-]?\d{7}[\s-]?\d{7}(?!\d)/g, "").trim();
    const pick = pickChild(children, { childId: childId || undefined, childQuery: nameQuery });
    if (pick.kind === "none") {
      // An id that is not one of HER verified children is refused before any card.
      if (childId) return say(BOOK_NOT_YOUR_CHILD, "not_your_child", {}, { pending: null });
      // One more try at the name keeps the code; a second miss lets it go
      // (so a stray short message never keeps SK stuck asking).
      const again = pend?.need === "child" && !codeIn ? null : encodeBookPending({ need: "child", kind, h, m: masked, ...(o ? { o, om } : {}) });
      return say(BOOK_CHILD_NOT_FOUND, "child_not_found", { name: nameQuery }, { pending: again });
    }
    if (pick.kind === "many") {
      const names = pick.options.map((c) => firstName(c.name));
      return {
        ok: true,
        summary: lineFor(BOOK_ASK_CHILD, locale, { names: names.join(" / ") }),
        facts: pick.options.map((c) => ({ kind: "child", id: c.id, name: c.name })),
        entities: pick.options.map<ResolvedEntity>((c) => ({ kind: "learner", id: c.id, label: c.name, via: "book.activate" })),
        pending: encodeBookPending({ need: "child", kind, h, m: masked, ...(o ? { o, om } : {}) }),
      };
    }
    if (pick.kind === "one") child = pick.child;
  }

  // ── The card ──────────────────────────────────────────────────────────────
  const label = child ? firstName(child.name) : null;
  const title = label ? lineFor(BOOK_CARD_TITLE_FOR, locale, { child: label }) : lineFor(BOOK_CARD_TITLE_SELF, locale);
  const params: Record<string, string | number | boolean | null> = {
    code_kind: lineFor(kind === "edition" ? BOOK_CODE_KIND_EDITION : BOOK_CODE_KIND_CARD, locale),
    code: masked,
    ...(om ? { order_ref: om } : {}),
    for_child_id: child?.id ?? null,
    ...(label ? { child_label: label } : {}),
    click_only: true,
    // Server-only (never sent to the browser, never audited): what the redeem needs.
    sealed_kind: kind,
    sealed_code_hmac: h,
    ...(o ? { sealed_order_hmac: o } : {}),
  };
  return {
    ok: true,
    summary: `${title}. ${lineFor(BOOK_CARD_NOTE, locale)}`,
    facts: [{ kind: "book.activate", code: masked, ...(om ? { order: om } : {}), for: label ?? "self" }],
    entities: child ? [{ kind: "learner", id: child.id, label: child.name, via: "book.activate" }] : [],
    confirm: { action: "book.activate", title, params },
    pending: null,
  };
}

export const bookActivateAction: SkCapability = {
  meta: {
    name: "book.activate",
    description:
      "Activate a book code: a code card (SKB…) or the edition code printed in a book (SKE…, which also needs the buyer's Amazon order number). A student activates for herself; a parent activates for ONE of their linked children. Returns a confirmation card that must be CLICKED — a spoken yes never activates it. Use for 'activate my book code', 'I have a code', 'unlock the book for Aisyah', 'aktifkan kod buku', 'فعّل الكود'. code = the code exactly as given (omit if not given — the result asks for it); orderNumber = the Amazon order number if given; childQuery = the child's name as the parent said it. Never repeat the code in your reply.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The book code as typed (SKB… or SKE-…)." },
        orderNumber: { type: "string", description: "Amazon order number for an SKE edition code, e.g. 123-1234567-1234567." },
        childQuery: { type: "string", description: "Parents: the child's name as said, e.g. 'Aisyah'." },
        childId: { type: "string", description: "Parents: a child id already resolved this conversation." },
      },
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["student", "parent"],
  },
  handler: resolveBookActivate,
};

// Book activation — the SERVER part, the one place that HMACs a book code and
// calls redeem_book_code() / redeem_edition_code(). Used by both routes
// (/api/sk/redeem, /api/sk/activate) and SK's `book.activate` action
// (src/sk/shell/act-book.ts), so the hashing and the RPC call exist once.
//
// The RPCs are SECURITY DEFINER and granted to service_role ONLY (0158/0159;
// verified on production 2026-10-29), so the caller passes the ADMIN client
// and the SERVER-VERIFIED user id as p_user — never a client-supplied id. The
// RPC itself requires a verified parent_links row for p_for_child and rate
// limits failures (5/hour, book_code_attempts).
//
// Nothing here ever logs or stores the code or the order number: only their
// HMACs leave this module.

import { GRANT_TERMS, hmacCode, hmacOrderNumber } from "./access";
import { bookCodeKind, isUuid, toRedeemReason, verifiedChildrenFrom, type BookCodeKind, type LinkedChild, type RedeemReason } from "./book-activate";

/** BOOK_CODE_SECRET when usable (16+ characters), else null — activation is
 *  then off ("Book codes aren't switched on yet."), never weak. */
export function bookCodeSecret(): string | null {
  const s = process.env.BOOK_CODE_SECRET || "";
  return s.length >= 16 ? s : null;
}

export type HashedBookCode = { kind: BookCodeKind; codeHmac: string; orderHmac: string | null };

/** Validate the FORMAT and hash. Null when the code is malformed, or an
 *  edition code comes without a well-formed order number. */
export function hashBookCode(input: { code: string; orderNumber?: string | null; kind?: BookCodeKind }, secret: string): HashedBookCode | null {
  const kind = bookCodeKind(input.code);
  if (!kind || (input.kind && input.kind !== kind)) return null;
  if (kind === "card") return { kind, codeHmac: hmacCode(input.code, secret), orderHmac: null };
  const order = input.orderNumber ?? "";
  if (!/^\d{3}-?\d{7}-?\d{7}$/.test(order.replace(/\s/g, ""))) return null;
  return { kind, codeHmac: hmacCode(input.code, secret), orderHmac: hmacOrderNumber(order, secret) };
}

export type RedeemGrant = { id: string; product_id: string; activated_at: string; expires_at: string | null; tutor_expires_at: string | null };
export type RedeemResult = { outcome: "redeemed"; grant: RedeemGrant } | { outcome: Exclude<RedeemReason, "bad_order" | "not_configured"> };

/** The narrow admin surface: just the RPC. */
export type RedeemAdmin = { rpc: (fn: string, args?: Record<string, unknown>) => unknown };

/**
 * One redemption. `userId` MUST be the server-verified session user.
 * `forChildId` = a parent activating for a linked child (the RPC refuses an
 * unverified or foreign link with `not_your_child`). Never throws.
 */
export async function redeemHashed(
  admin: RedeemAdmin,
  h: { kind: BookCodeKind; codeHmac: string; orderHmac: string | null },
  who: { userId: string; forChildId: string | null },
  tag = "sk/redeem",
): Promise<RedeemResult> {
  if (who.forChildId !== null && !isUuid(who.forChildId)) return { outcome: "not_your_child" };
  let res: { data?: unknown; error?: { message?: string } | null } | null;
  try {
    res =
      h.kind === "card"
        ? ((await admin.rpc("redeem_book_code", { p_code_hmac: h.codeHmac, p_user: who.userId, p_for_child: who.forChildId, p_days: GRANT_TERMS.code.tutorDays })) as typeof res)
        : ((await admin.rpc("redeem_edition_code", {
            p_code_hmac: h.codeHmac,
            p_order_hmac: h.orderHmac,
            p_user: who.userId,
            p_for_child: who.forChildId,
            p_days: GRANT_TERMS.edition_code.tutorDays,
            p_channel: "kdp",
          })) as typeof res);
  } catch (e) {
    console.error(`[${tag}] rpc threw:`, (e as Error)?.message);
    return { outcome: "error" };
  }
  if (!res || res.error) {
    console.error(`[${tag}] rpc failed:`, res?.error?.message ?? "no response");
    return { outcome: "error" };
  }
  const data = (res.data ?? {}) as { outcome?: string; grant?: Partial<RedeemGrant> | null };
  if (data.outcome === "redeemed") {
    const g = data.grant ?? {};
    return {
      outcome: "redeemed",
      grant: { id: String(g.id ?? ""), product_id: String(g.product_id ?? ""), activated_at: String(g.activated_at ?? ""), expires_at: g.expires_at ?? null, tutor_expires_at: g.tutor_expires_at ?? null },
    };
  }
  const reason = toRedeemReason(data.outcome);
  return { outcome: reason === "bad_order" || reason === "not_configured" ? "error" : reason };
}

/** HTTP status for a refusal (the routes' existing mapping). */
export const redeemStatus = (reason: string): number => (reason === "rate_limited" ? 429 : reason === "not_your_child" ? 403 : reason === "error" ? 500 : 400);

/** The signed-in user's VERIFIED children, through the USER-SESSION client
 *  (parent_links' own RLS: parent_id = auth.uid()). Empty on any error. */
export async function verifiedChildren(session: { from: (t: string) => unknown }, userId: string): Promise<LinkedChild[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = session.from("parent_links");
    const res = (await q.select("parent_id, child_id, verified_at, profiles:child_id(full_name, username)").eq("parent_id", userId).not("verified_at", "is", null)) as { data?: unknown };
    return verifiedChildrenFrom(res?.data, userId);
  } catch {
    return [];
  }
}

/** The book's title for the success line ("Biology is now unlocked for
 *  Aisyah."), through the session client (approved products are readable by
 *  any signed-in user). Null when unknown. */
export async function bookTitleFor(session: { from: (t: string) => unknown }, productId: string | null | undefined): Promise<string | null> {
  if (!isUuid(productId)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = session.from("sk_book_products");
    const res = (await q.select("id, title").eq("id", productId).maybeSingle()) as { data?: { id?: string; title?: string | null } | null };
    const t = res?.data && res.data.id === productId ? (res.data.title ?? "").trim() : "";
    return t || null;
  } catch {
    return null;
  }
}

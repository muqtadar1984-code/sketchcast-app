// SK Shell — executing `book.activate` (S4 slice D) from a VERIFIED token row.
//
// act.ts has already verified the token (HMAC over the stored row, user,
// expiry, used_at, live context), refused a spoken yes (click-only), and
// revalidated the capability (student or parent). Then, in order:
//   1. the stored params are shape-checked (a malformed row is refused BEFORE
//      the consume, a server fault);
//   2. BOOK_CODE_SECRET must be set — else "Book codes aren't switched on
//      yet." and nothing is consumed;
//   3. for a child: the parent's VERIFIED link is re-read through the
//      user-session client — not linked any more → refused, nothing consumed;
//   4. the token is consumed (0163) — a second click is `already_used`;
//   5. the SAME redeem the routes use (src/sk/book-redeem.ts) runs with the
//      code's HMAC from the token row and the SERVER-VERIFIED user id. The
//      RPCs are service-role only (0158/0159), hence the admin client; the RPC
//      checks the verified link again and rate-limits failures.
// No sk_action_id: the code is single-use in the database and the token is
// single-use here, so a replay is `already_used` and a different token for a
// spent code is the RPC's `used`.
//
// The code never reaches this module: only its HMAC (sealed_* params, never
// sent to the browser or audited). Lines are fixed (act-book-lines.ts).

import type { ResolvedEntity } from "./types";
import type { ActionTokenRow } from "./tokens";
import { consumeThenWrite, fail, str, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import {
  BOOK_BOOK_FALLBACK,
  BOOK_DAILY_CAP,
  BOOK_FAILED,
  BOOK_INVALID,
  BOOK_NOT_ON,
  BOOK_NOT_YOUR_CHILD,
  BOOK_ORDER_USED,
  BOOK_RATE_LIMITED,
  BOOK_REVOKED,
  BOOK_UNLOCKED_FOR,
  BOOK_UNLOCKED_SELF,
  BOOK_USED,
} from "./act-book-lines";
import { isUuid } from "@/sk/book-activate";
import { bookCodeSecret, bookTitleFor, redeemHashed, verifiedChildren, type RedeemResult } from "@/sk/book-redeem";

const HEX64 = /^[0-9a-f]{64}$/;

/** RPC refusal → the act outcome and SK's line. `used` is the code's own
 *  single use (another token, or the /activate page, spent it). */
export const BOOK_REFUSALS: Record<Exclude<RedeemResult["outcome"], "redeemed" | "error">, { outcome: "already_used" | "refused"; line: Record<string, string> }> = {
  invalid: { outcome: "refused", line: BOOK_INVALID },
  used: { outcome: "already_used", line: BOOK_USED },
  revoked: { outcome: "refused", line: BOOK_REVOKED },
  rate_limited: { outcome: "refused", line: BOOK_RATE_LIMITED },
  not_your_child: { outcome: "refused", line: BOOK_NOT_YOUR_CHILD },
  order_used: { outcome: "refused", line: BOOK_ORDER_USED },
  daily_cap: { outcome: "refused", line: BOOK_DAILY_CAP },
};

export async function runBookActivate(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const { ctx } = input;
  const locale = ctx.user.locale;
  const p = row.params ?? {};
  const kind = p.sealed_kind === "card" || p.sealed_kind === "edition" ? p.sealed_kind : null;
  const codeHmac = typeof p.sealed_code_hmac === "string" && HEX64.test(p.sealed_code_hmac) ? p.sealed_code_hmac : null;
  const orderHmac = typeof p.sealed_order_hmac === "string" && HEX64.test(p.sealed_order_hmac) ? p.sealed_order_hmac : null;
  const forChildId = p.for_child_id === null || p.for_child_id === undefined ? null : isUuid(p.for_child_id) ? p.for_child_id : "bad";
  if (!kind || !codeHmac || (kind === "edition" && !orderHmac) || forChildId === "bad" || p.click_only !== true) return fail("refused", undefined, { reason: "bad_params" });

  if (!bookCodeSecret()) return fail("refused", lineFor(BOOK_NOT_ON, locale), { reason: "not_configured" });
  if (!input.session) return fail("error", undefined, undefined, "error:no_session");

  // A child: still one of HER verified children? (before anything is consumed)
  let childName: string | null = null;
  if (forChildId) {
    const mine = await verifiedChildren(input.session, ctx.user.id);
    const c = mine.find((x) => x.id === forChildId);
    if (!c) return fail("refused", lineFor(BOOK_NOT_YOUR_CHILD, locale), { reason: "not_your_child" });
    childName = str(p.child_label) || c.name;
  }

  const admin = input.admin;
  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (): Promise<WriteOutcome<RedeemResult>> => {
    const res = await redeemHashed(admin, { kind, codeHmac, orderHmac }, { userId: ctx.user.id, forChildId }, "sk/act book.activate");
    return { ok: true, value: res };
  });
  if (r.stage === "consume") return fail(r.outcome);
  if (!r.result.ok) return fail("error", lineFor(BOOK_FAILED, locale), undefined, `error:write:${r.result.error ?? "unknown"}`.slice(0, 500));
  const res = r.result.value;
  if (res.outcome === "error") return fail("error", lineFor(BOOK_FAILED, locale), undefined, "error:redeem_rpc");
  if (res.outcome !== "redeemed") {
    const m = BOOK_REFUSALS[res.outcome];
    return fail(m.outcome, lineFor(m.line, locale), { reason: res.outcome }, `${m.outcome}:${res.outcome}`);
  }

  const grant = res.grant;
  const book = (await bookTitleFor(input.session, grant.product_id)) ?? lineFor(BOOK_BOOK_FALLBACK, locale);
  const summary = childName ? lineFor(BOOK_UNLOCKED_FOR, locale, { book, child: childName }) : lineFor(BOOK_UNLOCKED_SELF, locale, { book });
  const entities: ResolvedEntity[] = forChildId && childName ? [{ kind: "learner", id: forChildId, label: childName, via: "book.activate" }] : [];
  return {
    response: {
      ok: true,
      outcome: "done",
      summary,
      result: { grant_id: grant.id, product_id: grant.product_id, for_child_id: forChildId, tutor_expires_at: grant.tutor_expires_at },
    },
    entities,
  };
}

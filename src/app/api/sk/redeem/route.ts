import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { redeemMessage } from "@/sk/access";
import { bookCodeSecret, bookTitleFor, hashBookCode, redeemHashed, redeemStatus } from "@/sk/book-redeem";

export const runtime = "nodejs";

// POST /api/sk/redeem — activate a printed book code for the signed-in user
// (or, for a verified parent, for a linked child: forChildId). Contracts §4.
// The code is never stored or logged: it is HMACed with BOOK_CODE_SECRET and
// the database function redeem_book_code() does the single-use check under a
// row lock and RETURNS an outcome (so every attempt is recorded for the rate
// limit). The hashing and the RPC call live in src/sk/book-redeem.ts, shared
// with SK's `book.activate`. Refusals carry `reason` (the outcome code) so the
// /activate form can say it in the reader's language; `error` stays English.
// Idempotent on eventId: a repeat returns the stored result.
const recent = new Map<string, { status: number; body: unknown; at: number }>(); // per-instance replay cache (the DB function is the real guard)

export async function POST(request: Request) {
  if (!skEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const secret = bookCodeSecret();
  if (!secret) return NextResponse.json({ error: "Activation is not configured.", reason: "not_configured" }, { status: 503 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!skUserAllowed(user)) return NextResponse.json({ error: "Not available." }, { status: 404 }); // restricted live: off-list ⇒ as if the flag were off
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { eventId?: string; code?: string; forChildId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const eventId = String(body.eventId ?? "").slice(0, 64);
  const code = String(body.code ?? "").slice(0, 40);
  const forChildId = body.forChildId ? String(body.forChildId).slice(0, 64) : null;
  if (!eventId) return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  const replayKey = `${user.id}:${eventId}`;
  const seen = recent.get(replayKey);
  if (seen && Date.now() - seen.at < 10 * 60_000) return NextResponse.json(seen.body, { status: seen.status });

  const refuse = (reason: string) => {
    const status = redeemStatus(reason);
    const res = { error: redeemMessage(reason), reason };
    recent.set(replayKey, { status, body: res, at: Date.now() });
    return NextResponse.json(res, { status });
  };

  const hashed = hashBookCode({ code, kind: "card" }, secret);
  if (!hashed) return refuse("invalid");

  const r = await redeemHashed(createAdminClient(), hashed, { userId: user.id, forChildId }, "sk/redeem");
  if (r.outcome !== "redeemed") return refuse(r.outcome);
  const grant = r.grant;
  const res = {
    grantId: grant.id,
    productId: grant.product_id,
    activatedAt: grant.activated_at,
    expiresAt: grant.expires_at,
    tutorExpiresAt: grant.tutor_expires_at,
    bookTitle: await bookTitleFor(supabase, grant.product_id),
    forChildId,
  };
  recent.set(replayKey, { status: 200, body: res, at: Date.now() });
  return NextResponse.json(res);
}

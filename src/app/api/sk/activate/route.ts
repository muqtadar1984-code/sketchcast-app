import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { EDITION_PREFIX, isWellFormedCode, isWellFormedOrderNumber, redeemMessage } from "@/sk/access";
import { bookCodeSecret, bookTitleFor, hashBookCode, redeemHashed, redeemStatus } from "@/sk/book-redeem";

export const runtime = "nodejs";

// POST /api/sk/activate — activate a KDP copy: the EDITION code printed in
// the book (SKE-…, the same in every copy) plus the buyer's Amazon order
// number, for the signed-in user (or, for a verified parent, a linked child:
// forChildId). Distribution plan §6. Gated exactly like /api/sk/redeem:
// FEATURE_SK, the SK_ALLOWED_EMAILS allow-list, 503 without BOOK_CODE_SECRET.
// Neither the code nor the order number is stored or logged: both are HMACed
// (src/sk/book-redeem.ts, shared with SK's `book.activate`) and the database
// function redeem_edition_code() checks the order number is unused and the
// edition's daily cap under a row lock, RETURNING an outcome so every attempt
// counts towards the shared rate limit. Refusals carry `reason` for the
// /activate form's own language. Idempotent on eventId.
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

  let body: { eventId?: string; code?: string; orderNumber?: string; forChildId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const eventId = String(body.eventId ?? "").slice(0, 64);
  const code = String(body.code ?? "").slice(0, 40);
  const orderNumber = String(body.orderNumber ?? "").slice(0, 40);
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
  if (!isWellFormedCode(code, EDITION_PREFIX)) return refuse("invalid");
  if (!isWellFormedOrderNumber(orderNumber)) return refuse("bad_order");
  const hashed = hashBookCode({ code, orderNumber, kind: "edition" }, secret);
  if (!hashed) return refuse("invalid");

  const r = await redeemHashed(createAdminClient(), hashed, { userId: user.id, forChildId }, "sk/activate");
  if (r.outcome !== "redeemed") return refuse(r.outcome);
  const grant = r.grant;
  const res = {
    grantId: grant.id,
    productId: grant.product_id,
    activatedAt: grant.activated_at,
    tutorExpiresAt: grant.tutor_expires_at ?? null,
    bookAccess: "permanent",
    bookTitle: await bookTitleFor(supabase, grant.product_id),
    forChildId,
  };
  recent.set(replayKey, { status: 200, body: res, at: Date.now() });
  return NextResponse.json(res);
}

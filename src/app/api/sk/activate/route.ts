import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { EDITION_PREFIX, GRANT_TERMS, hmacCode, hmacOrderNumber, isWellFormedCode, isWellFormedOrderNumber, redeemMessage } from "@/sk/access";

export const runtime = "nodejs";

// POST /api/sk/activate — activate a KDP copy: the EDITION code printed in
// the book (SKE-…, the same in every copy) plus the buyer's Amazon order
// number, for the signed-in user (or, for a verified parent, a linked child).
// Distribution plan §6. Gated exactly like /api/sk/redeem: FEATURE_SK, the
// SK_ALLOWED_EMAILS allow-list, 503 without BOOK_CODE_SECRET. Neither the code
// nor the order number is stored or logged: both are HMACed and the database
// function redeem_edition_code() checks the order number is unused and the
// edition's daily cap under a row lock, RETURNING an outcome so every attempt
// counts towards the shared rate limit. Idempotent on eventId.
const recent = new Map<string, { status: number; body: unknown; at: number }>(); // per-instance replay cache (the DB function is the real guard)

export async function POST(request: Request) {
  if (!skEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const secret = process.env.BOOK_CODE_SECRET || "";
  if (secret.length < 16) return NextResponse.json({ error: "Activation is not configured." }, { status: 503 });

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
  const forChildId = body.forChildId ? String(body.forChildId) : null;
  if (!eventId) return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  const replayKey = `${user.id}:${eventId}`;
  const seen = recent.get(replayKey);
  if (seen && Date.now() - seen.at < 10 * 60_000) return NextResponse.json(seen.body, { status: seen.status });

  const refuse = (reason: string, status = 400) => {
    const res = { error: redeemMessage(reason) };
    recent.set(replayKey, { status, body: res, at: Date.now() });
    return NextResponse.json(res, { status });
  };
  if (!isWellFormedCode(code, EDITION_PREFIX)) return refuse("invalid");
  if (!isWellFormedOrderNumber(orderNumber)) return refuse("bad_order");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("redeem_edition_code", {
    p_code_hmac: hmacCode(code, secret),
    p_order_hmac: hmacOrderNumber(orderNumber, secret),
    p_user: user.id,
    p_for_child: forChildId,
    p_days: GRANT_TERMS.edition_code.tutorDays,
    p_channel: "kdp",
  });
  if (error) {
    console.error("[sk/activate] rpc failed:", error.message);
    return refuse("error", 500);
  }
  const outcome = String((data as { outcome?: string } | null)?.outcome ?? "");
  if (outcome !== "redeemed") {
    const status = outcome === "rate_limited" ? 429 : outcome === "not_your_child" ? 403 : 400;
    return refuse(outcome, status);
  }
  const grant = (data as { grant?: { id: string; product_id: string; activated_at: string; tutor_expires_at: string | null } }).grant;
  const res = { grantId: grant?.id, productId: grant?.product_id, activatedAt: grant?.activated_at, tutorExpiresAt: grant?.tutor_expires_at ?? null, bookAccess: "permanent" };
  recent.set(replayKey, { status: 200, body: res, at: Date.now() });
  return NextResponse.json(res);
}

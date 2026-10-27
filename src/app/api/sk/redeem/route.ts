import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skUserAllowed } from "@/utils/flags";
import { hmacCode, isWellFormedCode, redeemMessage } from "@/sk/access";

export const runtime = "nodejs";

// POST /api/sk/redeem — activate a printed book code for the signed-in user
// (or, for a verified parent, for a linked child). Contracts §4. The code is
// never stored or logged: it is HMACed with BOOK_CODE_SECRET and the database
// function redeem_book_code() does the single-use check under a row lock and
// RETURNS an outcome (so every attempt is recorded for the rate limit).
// Idempotent on eventId: a repeat returns the stored result.
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

  let body: { eventId?: string; code?: string; forChildId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const eventId = String(body.eventId ?? "").slice(0, 64);
  const code = String(body.code ?? "").slice(0, 40);
  const forChildId = body.forChildId ? String(body.forChildId) : null;
  if (!eventId) return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  const replayKey = `${user.id}:${eventId}`;
  const seen = recent.get(replayKey);
  if (seen && Date.now() - seen.at < 10 * 60_000) return NextResponse.json(seen.body, { status: seen.status });

  if (!isWellFormedCode(code)) {
    const res = { error: redeemMessage("invalid") };
    recent.set(replayKey, { status: 400, body: res, at: Date.now() });
    return NextResponse.json(res, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("redeem_book_code", {
    p_code_hmac: hmacCode(code, secret),
    p_user: user.id,
    p_for_child: forChildId,
    p_days: 30,
  });
  if (error) {
    console.error("[sk/redeem] rpc failed:", error.message);
    const res = { error: redeemMessage("error") };
    recent.set(replayKey, { status: 500, body: res, at: Date.now() });
    return NextResponse.json(res, { status: 500 });
  }
  const outcome = String((data as { outcome?: string } | null)?.outcome ?? "");
  if (outcome !== "redeemed") {
    const status = outcome === "rate_limited" ? 429 : outcome === "not_your_child" ? 403 : 400;
    const res = { error: redeemMessage(outcome) };
    recent.set(replayKey, { status, body: res, at: Date.now() });
    return NextResponse.json(res, { status });
  }
  const grant = (data as { grant?: { id: string; product_id: string; activated_at: string; expires_at: string } }).grant;
  const res = { grantId: grant?.id, productId: grant?.product_id, activatedAt: grant?.activated_at, expiresAt: grant?.expires_at };
  recent.set(replayKey, { status: 200, body: res, at: Date.now() });
  return NextResponse.json(res);
}

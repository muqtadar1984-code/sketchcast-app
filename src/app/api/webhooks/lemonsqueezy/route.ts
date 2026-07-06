import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { verifyLsSignature, lsEventKey } from "@/utils/lemonsqueezy/webhook";
import { handleLsEvent, type Db, type LsEvent } from "@/utils/lemonsqueezy/handlers";

// Lemon Squeezy webhook receiver. Public but hardened:
//   * Node runtime (raw body + Node crypto).
//   * HMAC-SHA256 signature verified on the RAW body (X-Signature).
//   * Idempotent: LS has no persistent event id, so we build a stable key
//     (event + object + updated_at) and claim it in webhook_events; a crash
//     between claim and completion reprocesses (processed_at), never lost.
//   * No card data — LS is MoR; we persist Stripe/LS IDs and statuses only.

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("billing.ls.webhook.misconfigured: LEMONSQUEEZY_WEBHOOK_SECRET missing");
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }

  const raw = await request.text();
  const signature = request.headers.get("x-signature");
  if (!verifyLsSignature(raw, signature, secret)) {
    console.error("billing.ls.webhook.bad_signature");
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: LsEvent;
  try {
    event = JSON.parse(raw) as LsEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const eventName = event.meta?.event_name ?? "unknown";
  const objId = event.data?.id ?? "";
  const updatedAt = (event.data?.attributes as { updated_at?: string } | undefined)?.updated_at;
  const key = lsEventKey(eventName, objId, updatedAt);

  const admin = createAdminClient();

  const { error: claimErr } = await admin.from("webhook_events").insert({ id: key, type: eventName });
  if (claimErr) {
    if (claimErr.code === "23505") {
      const { data: prior } = await admin.from("webhook_events").select("processed_at").eq("id", key).maybeSingle();
      if (prior?.processed_at) return NextResponse.json({ received: true, duplicate: true });
      // Claimed-but-unfinished (prior crash) → reprocess (handlers idempotent).
    } else {
      console.error("billing.ls.webhook.claim_failed", claimErr.message);
      return NextResponse.json({ error: "Storage error." }, { status: 500 });
    }
  }

  try {
    await handleLsEvent(admin as unknown as Db, event);
    await admin.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", key);
  } catch (e) {
    console.error("billing.ls.webhook.handler_failed", { key, err: (e as Error).message });
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

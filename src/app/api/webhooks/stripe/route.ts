import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { createAdminClient } from "@/utils/supabase/admin";
import { stripe } from "@/utils/stripe/client";
import { handleStripeEvent, type Db } from "@/utils/stripe/webhook-handlers";

// Stripe webhook receiver. Public endpoint, hardened:
//   * Node runtime (raw body + Node crypto — NOT Edge).
//   * Signature verified against STRIPE_WEBHOOK_SECRET on the RAW body.
//   * Idempotent: the event id is claimed in webhook_events (unique PK)
//     before processing; a replay acks 200 without reprocessing. If
//     processing fails, the claim is RELEASED and we 500 so Stripe retries.
//   * No card data anywhere — events carry Stripe IDs and statuses only,
//     and that is all we persist or log.

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("billing.webhook.misconfigured: STRIPE_WEBHOOK_SECRET missing");
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }

  const raw = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    console.error("billing.webhook.bad_signature", (e as Error).message);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Claim the event id (unique PK = dedupe). A duplicate is only a TRUE
  // duplicate if the prior attempt finished (processed_at set) — a claim left
  // unfinished by a crash must be reprocessed, not acked away.
  const { error: claimErr } = await admin
    .from("webhook_events")
    .insert({ id: event.id, type: event.type });
  if (claimErr) {
    if (claimErr.code === "23505") {
      const { data: prior } = await admin
        .from("webhook_events")
        .select("processed_at")
        .eq("id", event.id)
        .maybeSingle();
      if (prior?.processed_at) {
        return NextResponse.json({ received: true, duplicate: true });
      }
      // Claimed but never finished (previous attempt crashed). Fall through
      // and reprocess — every handler is idempotent (upserts on stable keys).
    } else {
      console.error("billing.webhook.claim_failed", claimErr.message);
      return NextResponse.json({ error: "Storage error." }, { status: 500 });
    }
  }

  try {
    await handleStripeEvent(admin as unknown as Db, stripe(), event);
    // Mark finished so a later retry is recognised as a true duplicate.
    await admin.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", event.id);
  } catch (e) {
    // Leave the claim in place with processed_at NULL: Stripe's retry will
    // reprocess (handlers are idempotent). 500 tells Stripe to retry.
    console.error("billing.webhook.handler_failed", { id: event.id, type: event.type, err: (e as Error).message });
    return NextResponse.json({ error: "Handler failed." }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

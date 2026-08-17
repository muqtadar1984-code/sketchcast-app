// The one-time welcome email, fired from the dashboard's first render for a
// new account (src/app/dashboard/page.tsx, best-effort). Google sign-ups —
// 72% of recent signups — otherwise receive NO email at all, so this is the
// artifact in their inbox that makes coming back easy.
//
// Once-ever is guaranteed by the lifecycle ledger's unique (user_id, segment):
// the send is CLAIMED by inserting the 'welcome' row first, and only the
// request that wins the insert sends. A failed send releases the claim so the
// next dashboard visit retries; a duplicate visit hits the unique violation
// and does nothing. Recording into lifecycle_emails also starts the console
// Remind button's 3-day cooldown (its query reads this table unfiltered),
// while the cron's per-segment dedup is untouched — the day-3 no_book nudge
// still goes out if the user stays inactive.

import type { SupabaseClient } from "@supabase/supabase-js";
import { welcomeEmail } from "./copy";
import { lifecycleAppUrl, sendLifecycleEmail } from "./send";
import { unsubscribeToken } from "./token";

/** Feature ship date — accounts created before this are never welcomed
 * retroactively (the founder reached out to earlier users personally). */
export const WELCOME_FROM = "2026-08-17T00:00:00Z";

export type WelcomeProfileFacts = {
  role: string | null;
  is_demo: boolean | null;
  email_optout_at: string | null;
  created_at: string;
  full_name: string | null;
};

/** Pure guard — everything that disqualifies an account from the welcome. */
export function shouldWelcome(p: WelcomeProfileFacts, email: string | null | undefined): boolean {
  if (!email) return false; // students' synthetic addresses receive no mail
  if (p.role === "student") return false;
  if (p.is_demo) return false;
  if (p.email_optout_at) return false;
  if (p.created_at < WELCOME_FROM) return false;
  return true;
}

export function firstNameOf(fullName: string | null): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || null;
}

/**
 * Best-effort: never throws — a broken email path must never break the
 * dashboard. Fast path after the send is a single unique-indexed select.
 */
export async function maybeSendWelcomeEmail(
  admin: SupabaseClient,
  userId: string,
  email: string | null | undefined,
): Promise<void> {
  try {
    // Fast path: already welcomed (or claimed by a concurrent request).
    const { data: sent } = await admin
      .from("lifecycle_emails")
      .select("user_id")
      .eq("user_id", userId)
      .eq("segment", "welcome")
      .maybeSingle();
    if (sent) return;

    const { data: p } = await admin
      .from("profiles")
      .select("role, is_demo, email_optout_at, created_at, full_name")
      .eq("id", userId)
      .maybeSingle();
    if (!p || !shouldWelcome(p as WelcomeProfileFacts, email)) return;

    // Claim before sending: the unique (user_id, segment) index makes exactly
    // one concurrent request the sender; the rest hit 23505 and stop.
    const { error: claimErr } = await admin
      .from("lifecycle_emails")
      .insert({ user_id: userId, segment: "welcome" });
    if (claimErr) return; // lost the race (or ledger unavailable) — never double-send

    const appUrl = lifecycleAppUrl();
    const { subject, text } = welcomeEmail({
      firstName: firstNameOf((p as WelcomeProfileFacts).full_name),
      appUrl,
      unsubscribeUrl: `${appUrl}/api/lifecycle/unsubscribe?t=${encodeURIComponent(unsubscribeToken(userId))}`,
    });
    const ok = await sendLifecycleEmail(email as string, subject, text);
    if (!ok) {
      // Release the claim so the next dashboard visit retries a transient
      // failure — a missed welcome would otherwise be permanent.
      await admin.from("lifecycle_emails").delete().eq("user_id", userId).eq("segment", "welcome");
    }
  } catch (e) {
    console.error("welcome email skipped:", userId, e);
  }
}

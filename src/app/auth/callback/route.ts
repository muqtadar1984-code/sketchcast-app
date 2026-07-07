import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { claimLsPurchases } from "@/utils/lemonsqueezy/claim";

export const runtime = "nodejs";

// OAuth (Google, later Facebook) return handler. Supabase brokers the provider,
// then redirects here with a PKCE `code`. We establish the cookie session and
// route by role. GUARDRAIL: this ADULT self-signup path must never land on / create
// a student account — a fresh OAuth user is created as `teacher` by the
// handle_new_user trigger (Google never sends a `role`), and we defensively block
// any student that somehow arrives. Existing email/password auth is untouched.

// Only allow same-origin relative redirects (no open-redirect via `next`).
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

function loginWithError(origin: string, message: string) {
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  // Provider-side error (user cancelled consent, linking disallowed, etc.).
  const providerError = searchParams.get("error");
  if (providerError) {
    const desc = searchParams.get("error_description");
    const msg =
      providerError === "access_denied"
        ? "Sign-in was cancelled."
        : desc || "Sign-in failed. Please try again.";
    return loginWithError(origin, msg);
  }

  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"));
  if (!code) {
    return loginWithError(origin, "Sign-in link was invalid. Please try again.");
  }

  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return loginWithError(origin, "Could not complete sign-in. Please try again.");
  }

  // Role guardrail — never let this path resolve to a student account.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.role === "student") {
      await supabase.auth.signOut();
      return loginWithError(
        origin,
        "This sign-in is for teachers. Students log in with the ID from their teacher.",
      );
    }
    // Bind any Lemon Squeezy purchase parked under this (provider-verified)
    // email from a public pricing-page checkout. Best-effort; never blocks login.
    if (user.email && user.email_confirmed_at) {
      await claimLsPurchases(user.id, user.email);
    }
  }

  // Adult account (fresh Google users default to teacher, exactly like email
  // teacher-signup) → their dashboard, or a safe `next`.
  return NextResponse.redirect(`${origin}${next}`);
}

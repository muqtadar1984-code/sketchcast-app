"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

// Provider-agnostic OAuth button. `provider` is a small parameter so a Facebook
// button drops in later with the SAME code path + the same /auth/callback route —
// only add a new entry to PROVIDERS (no Facebook now).
type Provider = "google" | "facebook";

const PROVIDERS: Record<Provider, { label: string; Logo: () => React.ReactElement }> = {
  google: { label: "Google", Logo: GoogleG },
  facebook: { label: "Facebook", Logo: GoogleG }, // placeholder logo; not rendered yet
};

export default function OAuthButton({
  provider = "google",
  mode = "in",
  next,
}: {
  provider?: Provider;
  mode?: "in" | "up";
  next?: string; // path to return to after the callback establishes the session
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, Logo } = PROVIDERS[provider];
  const verb = mode === "up" ? "Sign up" : "Sign in";

  async function onClick() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    // Supabase brokers the provider; on return it hits our cookie-aware callback,
    // which establishes the session and routes by role.
    const redirectTo = `${window.location.origin}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ""}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // On success the browser is redirected to the provider — nothing else runs.
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-label={`${verb} with ${label}`}
        className="w-full h-11 inline-flex items-center justify-center gap-2.5 rounded-lg border border-[#E6E8E4] bg-white text-sm font-medium text-[#14181F] transition-colors hover:bg-[#F5F6F3] disabled:opacity-60"
      >
        <Logo />
        {loading ? "Redirecting…" : `${verb} with ${label}`}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600 mt-2">
          {error}
        </p>
      )}
    </div>
  );
}

// Google's official multi-colour "G" mark (required by Google button branding).
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

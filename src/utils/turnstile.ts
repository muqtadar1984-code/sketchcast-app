// Cloudflare Turnstile — the server half. The widget is components/turnstile.tsx.
//
// DARK UNTIL CONFIGURED. Two env vars, set together or not at all:
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY — the widget renders only when this is set
//   TURNSTILE_SECRET_KEY           — verification runs only when this is set
// With no secret the check is SKIPPED and says so in its result, so the school
// registration keeps working before the widget exists in the Cloudflare
// dashboard. With a secret, a missing, expired or failed token refuses. The
// asymmetry to avoid is a site key without a secret (widget shown, token
// ignored) — harmless but theatre — and the reverse (secret set, no widget):
// every submit would fail with "missing", which is loud, and correct.
//
// SDK-free, like the repo's other third-party clients (Resend, Lemon Squeezy).

export type TurnstileResult = { ok: true; skipped: boolean } | { ok: false; reason: string };

export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

export async function verifyTurnstile(token: string | null | undefined, ip: string | null): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: "missing" };
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; "error-codes"?: string[] };
    if (json.success) return { ok: true, skipped: false };
    return { ok: false, reason: (json["error-codes"] ?? []).join(",") || "failed" };
  } catch (e) {
    // Cloudflare unreachable is not the user's fault, but letting the form
    // through would make the guard a fair-weather one. Refuse, and log so an
    // outage is visible rather than silently waving registrations in.
    console.error("turnstile.siteverify_failed", (e as Error).message);
    return { ok: false, reason: "unreachable" };
  }
}

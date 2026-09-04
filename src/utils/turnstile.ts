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

/** The `host` header as siteverify reports hostnames: lower-case, no port. */
export function hostnameOf(host: string | null | undefined): string | null {
  const h = (host ?? "").trim().toLowerCase().split(":")[0].replace(/\.+$/, "");
  return h || null;
}

/**
 * Canonical siteverify (developers.cloudflare.com/turnstile): `success` alone
 * is not enough. A token is also bound to the ACTION the widget was rendered
 * with and the HOSTNAME it was solved on, and both are checked here — a token
 * minted on another site, or on this site's other widget, is refused even
 * though Cloudflare says it was solved. `expect.hostname` is the request's own
 * host, so every domain the widget lists works without a second allowlist.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null,
  expect: { action: string; hostname: string | null },
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token || token.length > 2048) return { ok: false, reason: "missing" };
  if (!expect.hostname) return { ok: false, reason: "no-host" };
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `siteverify ${res.status}` };
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      action?: string;
      hostname?: string;
      "error-codes"?: string[];
    };
    if (!json.success) return { ok: false, reason: (json["error-codes"] ?? []).join(",") || "failed" };
    if (json.action !== expect.action) return { ok: false, reason: "action" };
    if (hostnameOf(json.hostname) !== expect.hostname) return { ok: false, reason: "hostname" };
    return { ok: true, skipped: false };
  } catch (e) {
    // Cloudflare unreachable is not the user's fault, but letting the form
    // through would make the guard a fair-weather one. Refuse, and log so an
    // outage is visible rather than silently waving registrations in.
    console.error("turnstile.siteverify_failed", (e as Error).message);
    return { ok: false, reason: "unreachable" };
  }
}

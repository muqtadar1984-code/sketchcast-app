import { createAdminClient } from "@/utils/supabase/admin";
import { verifyUnsubscribeToken } from "@/utils/lifecycle/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-click unsubscribe from the footer of every lifecycle email.
//
// No login required, and that is the point: someone who has forgotten their
// password must still be able to stop the email. The HMAC token grants exactly
// one capability — setting your own email_optout_at — and nothing else.
//
// Suppresses lifecycle mail only. Transactional mail (password reset, school
// invites) is unaffected, because opting out of nudges must not lock you out of
// your own account recovery.

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · SketchCast</title>
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:34rem;
            margin:14vh auto;padding:0 1.25rem;color:#14181F;line-height:1.6">
  <h1 style="font-size:1.35rem;margin:0 0 .6rem">${title}</h1>
  <p style="color:#5B6470;margin:0 0 1.5rem">${body}</p>
  <a href="https://app.sketchcast.app/dashboard"
     style="color:#0C8175;text-decoration:none;font-weight:500">Open SketchCast →</a>
</div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return page(
      "That link didn't work",
      "The unsubscribe link looks incomplete or has been altered. Reply to any " +
        "email from us and we'll take you off the list by hand.",
      400,
    );
  }

  const { error } = await createAdminClient()
    .from("profiles")
    .update({ email_optout_at: new Date().toISOString() })
    .eq("id", userId);

  if (error) {
    console.error("unsubscribe failed:", userId, error.message);
    return page(
      "Something went wrong",
      "We couldn't update your preferences just now. Reply to any email from us " +
        "and we'll do it manually.",
      500,
    );
  }

  return page(
    "You're unsubscribed",
    "You won't get any more reminder emails from SketchCast. You'll still " +
      "receive essential account messages, like password resets.",
  );
}

import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { platformConsoleEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// In-portal tech-issue reporting, any signed-in role. SAVE FIRST (the RLS
// insert policy pins reporter_id to the caller), EMAIL SECOND (Resend to the
// founder — a send failure never loses the report). Context (role, school,
// user agent, recent job errors) is derived SERVER-side, never trusted from
// the body; students get data-minimized reports (no free text, no job errors).

const ISSUE_TO = process.env.FEEDBACK_EMAIL_TO || "muqtadar.quraishi@sketchcast.app";
const ISSUE_FROM = "SketchCast AI <noreply@sketchcast.app>";
const CATEGORIES = ["video", "deck_docs", "quiz", "upload", "login", "speed", "other"] as const;
const MAX_OPEN_PER_USER = 5;

type Body = {
  category?: string;
  title?: string;
  description?: string | null;
  url?: string | null;
};

async function sendEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("issue email skipped: RESEND_API_KEY not set");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: ISSUE_FROM, to: [ISSUE_TO], subject, text }),
  });
  if (!res.ok) console.error("issue email failed:", res.status, await res.text().catch(() => ""));
  return res.ok;
}

export async function POST(request: Request) {
  if (!platformConsoleEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const category = CATEGORIES.includes(body.category as (typeof CATEGORIES)[number])
    ? (body.category as string)
    : "other";
  const title = (body.title ?? "").trim().slice(0, 200);
  if (title.length < 4) {
    return NextResponse.json({ error: "Please describe the problem in a few words." }, { status: 400 });
  }
  const url = (body.url ?? "").trim().slice(0, 300);

  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id, full_name")
    .eq("id", user.id)
    .maybeSingle();
  const role = (me?.role as string | null) ?? null;
  const isStudent = role === "student";

  // Data minimization for minors: no free text, no pipeline context.
  const description = isStudent ? null : (body.description ?? "").trim().slice(0, 4000) || null;

  // Rate limit: at most N open reports per user (their own rows via RLS).
  const { count: openCount } = await supabase
    .from("platform_issues")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "triaged", "in_progress"]);
  if ((openCount ?? 0) >= MAX_OPEN_PER_USER) {
    return NextResponse.json(
      { error: "You already have several open reports — we're on them!" },
      { status: 429 },
    );
  }

  const context: Record<string, unknown> = {
    url,
    user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300),
  };
  if (!isStudent) {
    // Recent failed jobs on the caller's own generations (RLS-scoped read).
    const { data: gens } = await supabase.from("generations").select("id").eq("owner_id", user.id);
    const gids = (gens ?? []).map((g) => g.id);
    if (gids.length) {
      const { data: jobs } = await supabase
        .from("jobs")
        .select("error, created_at")
        .in("generation_id", gids)
        .eq("status", "error")
        .order("created_at", { ascending: false })
        .limit(3);
      const errs = (jobs ?? []).map((j) => (j.error ?? "").slice(0, 200)).filter(Boolean);
      if (errs.length) context.recent_job_errors = errs;
    }
  }

  const { data: row, error: iErr } = await supabase
    .from("platform_issues")
    .insert({
      reporter_id: user.id,
      reporter_role: role,
      school_id: me?.school_id ?? null,
      category,
      title,
      description,
      context,
    })
    .select("id")
    .single();
  if (iErr || !row) {
    return NextResponse.json({ error: iErr?.message ?? "Could not save the report." }, { status: 500 });
  }

  // Email second — retry once, never fail the request over it.
  const subject = `SketchCast issue [${category}]: ${title.slice(0, 80)}`;
  const text = [
    `Reporter: ${me?.full_name || user.email || user.id} (${role ?? "?"})`,
    `Page: ${url || "?"}`,
    description ? `\n${description}\n` : "",
    context.recent_job_errors ? `Recent job errors:\n- ${(context.recent_job_errors as string[]).join("\n- ")}` : "",
    // The console lives on its own subdomain — a /console link on the app host
    // redirects to /dashboard (console-routing), which dead-ends the email.
    `\nTriage: https://${process.env.NEXT_PUBLIC_CONSOLE_HOST || "app.sketchcast.app"}/console/issues/${row.id}`,
  ].filter(Boolean).join("\n");
  if (!(await sendEmail(subject, text))) await sendEmail(subject, text);

  return NextResponse.json({ ok: true, id: row.id });
}

export async function GET() {
  if (!platformConsoleEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // RLS returns only the caller's own reports.
  const { data } = await supabase
    .from("platform_issues")
    .select("id, category, title, status, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  return NextResponse.json({ issues: data ?? [] });
}

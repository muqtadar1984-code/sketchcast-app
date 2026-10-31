"use server";

// SK gaps console — the founder's decisions on a theme, and the per-miss
// dismiss. Server actions: the console layout guards the PAGE only, so every
// action re-checks staff itself (isPlatformAdminRequest, like the
// /api/console/* routes) before touching anything, and writes a
// platform_audit_log row like the other console mutations.
import { redirect } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPlatformAdminRequest } from "@/utils/platform-admin";
import { groupNewGaps } from "@/sk/gaps/group";
import { ISSUE_SAMPLES, themeIssue, type IssueSample } from "@/sk/gaps/issue";

type Admin = ReturnType<typeof createAdminClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = "/console/sk-gaps";

async function staffOrThrow() {
  const staff = await isPlatformAdminRequest();
  if (!staff) throw new Error("Not found.");
  return staff;
}

function idOf(fd: FormData, key: string): string {
  const v = String(fd.get(key) ?? "").trim();
  if (!UUID.test(v)) throw new Error(`Bad ${key}.`);
  return v;
}

/** Where to go back to: only this page (no open redirect), plus a message. */
function back(fd: FormData, msg: string): never {
  const raw = String(fd.get("back") ?? "");
  const url = new URL(raw.startsWith(BASE) ? raw : BASE, "http://x");
  if (url.pathname !== BASE) url.pathname = BASE;
  url.searchParams.set("msg", msg.slice(0, 200));
  const anchor = String(fd.get("anchor") ?? "");
  const hash = /^[\w-]{1,80}$/.test(anchor) ? `#${anchor}` : "";
  redirect(`${url.pathname}?${url.searchParams.toString()}${hash}`);
}

async function audit(admin: Admin, actorId: string, action: string, kind: string, id: string | null, detail: Record<string, unknown>) {
  const { error } = await admin.from("platform_audit_log").insert({ actor_id: actorId, action, target_kind: kind, target_id: id, detail });
  if (error) console.warn("sk-gaps console audit not written:", error.message);
}

async function loadTheme(admin: Admin, id: string) {
  const { data, error } = await admin
    .from("sk_gap_themes")
    .select("id, title, summary, status, issue_id, note, fixed_pr")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Theme not found.");
  return data as { id: string; title: string; summary: string | null; status: string; issue_id: string | null; note: string | null; fixed_pr: string | null };
}

/** Add to SK: files a platform_issues ticket with the summary and up to five
 *  sample questions, and marks the theme accepted. A theme that already has a
 *  ticket is only re-marked accepted (no second ticket). */
export async function addToSk(fd: FormData) {
  const staff = await staffOrThrow();
  const id = idOf(fd, "theme_id");
  const admin = createAdminClient();
  const theme = await loadTheme(admin, id);
  let issueId = theme.issue_id;
  if (!issueId) {
    const { data: samples } = await admin
      .from("sk_gaps")
      .select("question, wanted, role, signal, created_at")
      .eq("theme_id", id)
      .neq("status", "dismissed")
      .is("text_purged_at", null)
      .order("created_at", { ascending: false })
      .limit(ISSUE_SAMPLES * 3);
    const row = themeIssue(theme, (samples ?? []) as IssueSample[]);
    // reporter_id stays null: a staff reporter would be mailed the "resolved"
    // digest (issue_notices) when the ticket closes.
    const { data: issue, error } = await admin.from("platform_issues").insert(row).select("id").single();
    if (error || !issue) throw new Error(`Ticket not filed: ${error?.message ?? "no row"}`);
    issueId = issue.id as string;
  }
  const { error: uErr } = await admin
    .from("sk_gap_themes")
    .update({ status: "accepted", issue_id: issueId, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (uErr) throw new Error(uErr.message);
  await audit(admin, staff.id, "sk_gap_theme_accept", "sk_gap_theme", id, { before: theme.status, issue_id: issueId, new_issue: !theme.issue_id });
  back(fd, `Added to SK — ticket filed.`);
}

const VERDICTS: Record<string, string> = {
  wont_do: "Marked won't do.",
  already_possible: "Marked already possible — SK's instructions need the fix.",
  open: "Reopened.",
};

/** Won't do / Already possible / Reopen. An optional note is appended. */
export async function setThemeStatus(fd: FormData) {
  const staff = await staffOrThrow();
  const id = idOf(fd, "theme_id");
  const status = String(fd.get("status") ?? "");
  if (!(status in VERDICTS)) throw new Error("Bad status.");
  const admin = createAdminClient();
  const theme = await loadTheme(admin, id);
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  const note = String(fd.get("note") ?? "").trim().slice(0, 500);
  if (note) patch.note = (theme.note ? `${theme.note}\n${note}` : note).slice(-2000);
  const { error } = await admin.from("sk_gap_themes").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  await audit(admin, staff.id, "sk_gap_theme_status", "sk_gap_theme", id, { before: theme.status, after: status, note: note || null });
  back(fd, VERDICTS[status]);
}

/** Mark fixed, with the PR (or notes). The time it is marked (updated_at) is
 *  what the nightly grouping compares new misses against to reopen it. */
export async function markFixed(fd: FormData) {
  const staff = await staffOrThrow();
  const id = idOf(fd, "theme_id");
  const fixedPr = String(fd.get("fixed_pr") ?? "").trim().slice(0, 200);
  if (!fixedPr) back(fd, "Say which PR (or what) fixed it.");
  const admin = createAdminClient();
  const theme = await loadTheme(admin, id);
  const { error } = await admin
    .from("sk_gap_themes")
    .update({ status: "fixed", fixed_pr: fixedPr, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await audit(admin, staff.id, "sk_gap_theme_fixed", "sk_gap_theme", id, { before: theme.status, fixed_pr: fixedPr });
  back(fd, "Marked fixed.");
}

/** Dismiss one miss (not a real gap). It stops counting toward its theme. */
export async function dismissGap(fd: FormData) {
  const staff = await staffOrThrow();
  const id = idOf(fd, "gap_id");
  const admin = createAdminClient();
  const { data, error } = await admin.from("sk_gaps").update({ status: "dismissed" }).eq("id", id).select("id, theme_id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Miss not found.");
  await audit(admin, staff.id, "sk_gap_dismiss", "sk_gap", id, { theme_id: (data[0] as { theme_id: string | null }).theme_id });
  back(fd, "Miss dismissed.");
}

/** Group now: the nightly grouping, on demand (one Haiku call, only when
 *  something is new). */
export async function groupNow(fd: FormData) {
  const staff = await staffOrThrow();
  const admin = createAdminClient();
  const r = await groupNewGaps(admin);
  await audit(admin, staff.id, "sk_gap_group_now", "sk_gap_theme", null, {
    status: r.status,
    gaps: r.gaps,
    grouped: r.grouped,
    dismissed: r.dismissed,
    new_themes: r.newThemes,
    reopened: r.reopened,
    usd: r.usage.usd,
  });
  back(
    fd,
    r.status === "empty"
      ? "Nothing new to group."
      : r.status === "failed"
        ? `Grouping failed: ${r.error ?? "unknown error"}`
        : `Grouped ${r.grouped}, dismissed ${r.dismissed} as noise, ${r.newThemes} new theme(s), ${r.reopened} reopened, ${r.skipped} left for next time ($${r.usage.usd.toFixed(4)}).`,
  );
}

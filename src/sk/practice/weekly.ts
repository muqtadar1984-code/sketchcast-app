// The WEEKLY recommended plan (SK student Board plan 2026-10-31, phase 4).
// Server only. No new Vercel cron (Hobby: daily crons only, two in use): the
// daily lifecycle cron (/api/lifecycle/reminders, 03:30 UTC) calls this every
// day and it runs on SUNDAYS (UTC) only. Every student who practised in the
// last 7 days gets a kit-less plan over all her kits (plan-store.ts draftPlan,
// trigger "weekly"; it supersedes her previous open weekly plan). At most
// WEEKLY_MAX_STUDENTS per run; Haiku 5.5 words each plan (≈ $0.0003).
// Off with SK_LEARN_PLANS=off. Never throws.

import { claudeClient, claudeConfigured, claudeModel } from "@/utils/claude-backend";
import { skBedrockRegion, skModelMap } from "@/sk/claude-target";
import type { SkDb } from "@/sk/store-supabase";
import type { HelpModelCall } from "./help";
import { learnPlansOn, runWeeklyPlans, WEEKLY_MAX_STUDENTS } from "./plan-store";

/** SK's Haiku call in SK's region (as the practice route's). Never in tests. */
export const skPracticeCall: HelpModelCall = async (req) => {
  const client = claudeClient({ region: skBedrockRegion() });
  const res = (await client.messages.create({
    model: claudeModel(req.model, skModelMap()),
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  })) as unknown as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
  return {
    text: res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join(""),
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
  };
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminLike = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function runSkWeeklyPlans(
  adminFactory: () => AdminLike,
  now: Date = new Date(),
  call: HelpModelCall | null = claudeConfigured() ? skPracticeCall : null,
): Promise<{ ran: boolean; drafted?: number; skipped?: number; error?: string }> {
  if (now.getUTCDay() !== 0 || !learnPlansOn()) return { ran: false };
  try {
    const admin = adminFactory();
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const { data, error } = await admin.from("sk_practice_attempts").select("student_id").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
    if (error) return { ran: true, error: String(error.message ?? "read failed") };
    const students = [...new Set(((data ?? []) as { student_id: string }[]).map((r) => String(r.student_id)))].slice(0, WEEKLY_MAX_STUDENTS);
    const r = await runWeeklyPlans({ db: admin as unknown as SkDb, call, now: () => now.getTime(), log: (m) => console.warn(m) }, students);
    return { ran: true, ...r };
  } catch (e) {
    console.error("[sk-learn] weekly plans failed:", (e as Error).message);
    return { ran: true, error: (e as Error).message };
  }
}

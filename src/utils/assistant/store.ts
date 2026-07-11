// Session history for the AI Teaching Assistant (migration 0034). The ACTIVE
// session's turns ride raw in context for natural follow-ups; anything older is
// compacted into a short summary (cheaper AND faster than replaying turns).
// Retention: messages older than ~30 days are deleted on session open. All
// writes are service-role; students read their own rows via RLS.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Turn } from "./provider";

const SESSION_GAP_HOURS = 4; // silence longer than this starts a fresh session
const RETENTION_DAYS = 30;
const MAX_RAW_TURNS = 16; // raw turns of the active session kept in context

export type AssistantSession = {
  id: string;
  historySummary: string | null;
  recentTurns: Turn[];
  /** The chapter the conversation is currently anchored to (for follow-ups
   * with no topical words — they stay on this topic). */
  activeTopic: { bookId: string; chapterNum: number; title: string } | null;
};

/** Open (or create) the student's session: prune expired history, load the
 * active session's raw turns, and build the compact older-history summary. */
export async function openSession(admin: SupabaseClient, studentId: string): Promise<AssistantSession> {
  // Retention sweep — cheap (indexed) and keeps the promise without a cron.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  await admin.from("assistant_messages").delete().eq("student_id", studentId).lt("created_at", cutoff);

  const gapCutoff = new Date(Date.now() - SESSION_GAP_HOURS * 3600_000).toISOString();
  const { data: existing } = await admin
    .from("assistant_sessions")
    .select("id, last_at")
    .eq("student_id", studentId)
    .gte("last_at", gapCutoff)
    .order("last_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let sessionId = existing?.id as string | undefined;
  if (!sessionId) {
    const { data: created } = await admin
      .from("assistant_sessions")
      .insert({ student_id: studentId })
      .select("id")
      .single();
    sessionId = created?.id as string;
  }

  // Raw turns of the active session (capped), oldest→newest.
  const { data: msgs } = await admin
    .from("assistant_messages")
    .select("role, content, source_book_id, source_chapter, source_label")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(MAX_RAW_TURNS);
  const ordered = [...(msgs ?? [])].reverse();
  const recentTurns: Turn[] = ordered.map((m) =>
    m.role === "student" ? { role: "user", text: String(m.content) } : { role: "assistant", text: String(m.content) },
  );
  const lastSourced = [...ordered].reverse().find((m) => m.source_book_id && m.source_chapter != null);
  const activeTopic = lastSourced
    ? { bookId: String(lastSourced.source_book_id), chapterNum: Number(lastSourced.source_chapter), title: String(lastSourced.source_label ?? "") }
    : null;

  return {
    id: sessionId!,
    historySummary: await olderHistorySummary(admin, studentId, sessionId!),
    recentTurns,
    activeTopic,
  };
}

/** Pure: compact summary of older sessions from their student rows — the
 * topics/questions touched, never raw transcript. Deterministic; unit-tested.
 * (A model-written summary is a later upgrade; this is free and instant.) */
export function buildHistorySummary(rows: { content: unknown; source_label?: unknown }[]): string | null {
  if (!rows.length) return null;
  const topics = [...new Set(rows.map((m) => String(m.source_label || "")).filter(Boolean))].slice(0, 5);
  const questions = rows.slice(0, 5).map((m) => `"${String(m.content).slice(0, 80)}"`);
  const parts: string[] = [];
  if (topics.length) parts.push(`Topics covered recently: ${topics.join("; ")}.`);
  if (questions.length) parts.push(`Recent questions: ${questions.join(", ")}.`);
  return parts.join(" ") || null;
}

async function olderHistorySummary(admin: SupabaseClient, studentId: string, activeSessionId: string): Promise<string | null> {
  const { data } = await admin
    .from("assistant_messages")
    .select("content, source_label")
    .eq("student_id", studentId)
    .eq("role", "student")
    .neq("session_id", activeSessionId)
    .order("created_at", { ascending: false })
    .limit(12);
  return buildHistorySummary(data ?? []);
}

export type TurnLog = {
  question: string;
  answer: string;
  source: { bookId: string; chapterNum: number; label: string } | null;
  provider: string;
  latency: Record<string, number>; // retrievalMs, firstTokenMs, totalMs, toolMs?
  tokens: { inputTokens: number; outputTokens: number } | null;
};

/** Persist one Q/A turn + latency/cost telemetry. Best-effort: logging must
 * never break a teaching turn. */
export async function logTurn(admin: SupabaseClient, sessionId: string, studentId: string, t: TurnLog): Promise<void> {
  try {
    await admin.from("assistant_messages").insert([
      { session_id: sessionId, student_id: studentId, role: "student", content: t.question.slice(0, 2000) },
      {
        session_id: sessionId,
        student_id: studentId,
        role: "assistant",
        content: t.answer.slice(0, 8000),
        source_book_id: t.source?.bookId ?? null,
        source_chapter: t.source?.chapterNum ?? null,
        source_label: t.source?.label ?? null,
        provider: t.provider,
        latency: t.latency,
        tokens: t.tokens,
      },
    ]);
    await admin
      .from("assistant_sessions")
      .update({ last_at: new Date().toISOString() })
      .eq("id", sessionId);
  } catch (e) {
    console.error("assistant.logTurn", (e as Error).message);
  }
}

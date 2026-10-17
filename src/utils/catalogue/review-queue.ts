import type { PrecheckReport } from "./types";

// The Library's review inbox (layout D, the founder's choice of 2026-10-16):
// the topic page /library/topics/[id] carries a queue of every kit awaiting a
// reviewer on its left — English kits in `in_review`, translation kits whose
// `translation_status` is `in_review` — and the selected topic on its right.
// The selection travels in the URL: the path is the topic, `?lang=` names a
// translation kit to review in place of the English one, `?queue=all&q=`
// switches the left pane from the queue to every topic so the page still
// reaches a topic that is not under review. These helpers are pure (the
// server reads the rows in review-queue-server.ts); the page and the
// /library/review door share them.

/** 0134 — the Kit Translator's columns on topic_kits (translation_status,
 *  translation, precheck); the queue and the Translations section degrade
 *  without them. */
export const KIT_TRANSLATOR_MIGRATION = "0134_kit_translator.sql";

export const QUEUE_MODES = ["review", "all"] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];

export type InboxParams = {
  /** a translation kit's language to review, or null for the English kit */
  lang: string | null;
  queue: QueueMode;
  /** the all-topics search text (trimmed) */
  q: string;
};

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export function parseInboxParams(sp: Record<string, string | string[] | undefined> | null | undefined): InboxParams {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const lang = one(sp?.lang).trim();
  const queue = one(sp?.queue) === "all" ? "all" : "review";
  return { lang: lang && lang !== "en" && LANG.test(lang) ? lang : null, queue, q: one(sp?.q).trim().slice(0, 120) };
}

/** The inbox URL for a topic: the path is the topic, the rest is the view. */
export function inboxHref(topicId: string, opts: { lang?: string | null; queue?: QueueMode; q?: string } = {}): string {
  const p = new URLSearchParams();
  if (opts.lang && opts.lang !== "en") p.set("lang", opts.lang);
  if (opts.queue === "all") {
    p.set("queue", "all");
    if (opts.q?.trim()) p.set("q", opts.q.trim());
  }
  const qs = p.toString();
  return `/library/topics/${topicId}${qs ? `?${qs}` : ""}`;
}

/** Flags across check A and check C (post_render). */
export function flagCount(report: PrecheckReport | null | undefined): number {
  if (!report) return 0;
  return (report.flags?.length ?? 0) + (report.post_render?.flags?.length ?? 0);
}

/** Blocking findings across check A and check C. */
export function blockingCount(report: PrecheckReport | null | undefined): number {
  if (!report) return 0;
  return (report.blocking?.length ?? 0) + (report.post_render?.blocking?.length ?? 0);
}

/** "A: passed · C: passed", "A: 2 blocking", "not checked" — the one-line
 *  verdict the status line shows; the findings themselves are folded. */
export function precheckVerdict(report: PrecheckReport | null | undefined): string {
  if (!report) return "not checked";
  const a = report.blocking?.length ? `A: ${report.blocking.length} blocking` : "A: passed";
  const post = report.post_render;
  const c = !post ? null : post.blocking?.length ? `C: ${post.blocking.length} blocking` : "C: passed";
  return c ? `${a} · ${c}` : a;
}

type QueueTopic = { id: string; title: string; subject: string | null; status: string };

export type QueueKitRow = {
  id: string;
  topic_id: string;
  language: string;
  status: string;
  translation_status?: string | null;
  precheck?: PrecheckReport | null;
  updated_at: string;
  created_at: string;
  topics?: QueueTopic | QueueTopic[] | null;
};

export type QueueRow = {
  kitId: string;
  topicId: string;
  title: string;
  subject: string | null;
  topicStatus: string;
  language: string;
  /** a translation kit (reviewed through ?lang=) rather than the English kit */
  translation: boolean;
  /** when the kit entered review (the row's updated_at — the worker's last write) */
  since: string;
  flags: number;
  blocking: number;
};

/** Is this kit waiting for a reviewer? An English kit by its status; a
 *  translation by its translation_status (its kit status says the same while
 *  the pieces are done, but the translation's own lifecycle is the gate).
 *  Without 0134 the translation column is absent and the kit status decides. */
export function awaitsReview(k: Pick<QueueKitRow, "language" | "status" | "translation_status">): boolean {
  if (k.language === "en") return k.status === "in_review";
  return k.translation_status === "in_review" || (k.translation_status == null && k.status === "in_review");
}

/** The queue, newest first: one row per kit awaiting review, its topic's
 *  title beside it. A kit whose topic row did not come back is dropped —
 *  nothing to click through to. */
export function queueRowsOf(rows: readonly QueueKitRow[]): QueueRow[] {
  const out: QueueRow[] = [];
  const seen = new Set<string>();
  for (const k of rows) {
    if (!awaitsReview(k) || seen.has(k.id)) continue;
    const t = Array.isArray(k.topics) ? k.topics[0] : k.topics;
    if (!t) continue;
    seen.add(k.id);
    out.push({
      kitId: k.id,
      topicId: k.topic_id,
      title: t.title,
      subject: t.subject,
      topicStatus: t.status,
      language: k.language,
      translation: k.language !== "en",
      since: k.updated_at || k.created_at,
      flags: flagCount(k.precheck),
      blocking: blockingCount(k.precheck),
    });
  }
  return out.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
}

/** What review-queue-server.ts hands the page: the rows, a read error (never
 *  a missing table — that is an empty queue), and whether 0134 is missing. */
export type ReviewQueue = { rows: QueueRow[]; error: string | null; translationsMissing: boolean };

/** "just now", "35 min", "3 h", "2 d" — how long a kit has sat in review. */
export function timeInReview(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** The queue row for a topic: its English kit's row, or — when only a
 *  translation of it waits — that translation's. */
export function queueRowFor(rows: readonly QueueRow[], topicId: string): QueueRow | null {
  return rows.find((r) => r.topicId === topicId && !r.translation) ?? rows.find((r) => r.topicId === topicId) ?? null;
}

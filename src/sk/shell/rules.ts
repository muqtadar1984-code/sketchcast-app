// SK Shell — the deterministic rules router (Final Plan §2.1 router, S0 cut).
//
// S0 ships no model-based router: navigation and bare acknowledgements are
// decided here, by rules, with no model call (acceptance: a navigate lands
// within 2 s); everything else is handed to the teacher model with intent
// "ask". The Haiku router of §2.1 arrives with the teaching moves (S1/S2).
// Pure: text + context + clock in, decision out.

import type { SkCollector, SkContext, SkIntent } from "./types";
import { NAV_TARGETS, type NavFilters, type NavTarget } from "@/sk/capabilities/navigate";

export type RulesDecision =
  | { intent: "navigate"; target: NavTarget; filters: NavFilters; classQuery?: string; learnerQuery?: string }
  | { intent: "chat"; reply: string }
  | { intent: Exclude<SkIntent, "navigate" | "chat"> };

export const SK_CHAT_NOTHING_PENDING = "Nothing is waiting on an answer — ask me something, or tell me where to go.";
export const SK_CHAT_THANKS = "You're welcome.";

// Navigation verbs in the three launch locales (English, Malay, Arabic).
// `\b` is ASCII-only even with the u flag, so the boundaries are spelled out
// with letter classes — otherwise "افتح" never matches.
const VERB_RE =
  /(?<![\p{L}\p{N}])(?:open|show(?: me)?|go to|take me to|bring up|navigate to|switch to|jump to|head to|pull up|let'?s see|display|view|buka|pergi ke|tunjuk(?:kan)?(?: saya)?|papar(?:kan)?|bawa saya ke|افتح|اذهب (?:إلى|الى)|أرني|اعرض|انتقل (?:إلى|الى))(?![\p{L}\p{N}])/u;

/** Target keywords, most specific first — "school diary" must win over "diary"
 *  and "progress record" over "progress". Checked as whole-word phrases. */
const TARGET_WORDS: Array<[NavTarget, string[]]> = [
  ["school_diary", ["school diary", "diari sekolah", "يوميات المدرسة"]],
  ["school_teachers", ["school teachers", "teachers page", "teachers", "guru-guru", "senarai guru", "المعلمين", "المعلمون"]],
  ["school_access", ["school access", "access page", "access", "akses"]],
  ["school_admin", ["school admin", "school settings", "admin page", "admin", "pentadbir", "إدارة المدرسة"]],
  ["school_books", ["school books", "school shelf", "the shelf", "shelf", "buku sekolah", "رف المدرسة"]],
  ["reports", ["progress record", "progress report", "report card", "report", "laporan", "تقرير"]],
  ["analytics", ["my analytics", "analytics", "progress", "stats", "statistics", "completion", "analitik", "kemajuan", "التحليلات", "تحليلات"]],
  ["board", ["classroom board", "the board", "board", "present mode", "presentation", "papan", "اللوحة"]],
  ["children", ["my children", "children", "my kids", "kids", "anak-anak", "anak saya", "أطفالي", "أولادي"]],
  ["kits", ["ready-made kits", "ready made kits", "catalogue", "catalog", "kits", "kit", "kit sedia", "الحزم"]],
  ["diary", ["buku komunikasi", "diary", "diari", "اليوميات", "دفتر التواصل"]],
  ["timetable", ["my timetable", "timetable", "schedule", "jadual waktu", "jadual", "الجدول", "جدول"]],
  ["calendar", ["calendar", "kalendar", "التقويم"]],
  ["tutor", ["sk tutor", "the tutor", "tutor", "tutor sk", "المعلم الخصوصي"]],
  ["school", ["school overview", "school dashboard", "school page", "school health", "leadership", "my school", "the school", "school", "sekolah", "المدرسة"]],
  ["library", ["library", "my books", "books", "home page", "home", "dashboard", "my lessons", "perpustakaan", "halaman utama", "المكتبة"]],
];

const ACK_RE = /^(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|fine|alright|go ahead|cancel|ya|tidak|baik|boleh|نعم|لا|حسنا|حسناً|تمام)(?:[\s,.!]*)$/u;
const THANKS_RE = /^(?:thanks|thank you|thx|cheers|terima kasih|شكرا|شكراً)(?:[\s,.!]*)$/u;

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[?!.,;:]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTarget(t: string): NavTarget | null {
  for (const [target, words] of TARGET_WORDS) {
    for (const w of words) {
      // Whole phrase, bounded by start/end or a non-letter (works for Arabic too).
      const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(w)}(?:$|[^\\p{L}\\p{N}])`, "u");
      if (re.test(t)) return target;
    }
  }
  return null;
}

// "7B", "7 B", "class 7B", "Year 7B's", "kelas 5 Amanah" — never "10am"/"3pm".
const CLASS_RE = /(?:^|\s)(?:class|kelas|grade|year|form|tingkatan|darjah|tahun)\s+([0-9]{1,2}\s?[a-z]{1,2}|[0-9]{1,2}\s[a-z]{3,})(?:['’]s)?(?=\s|$)|(?:^|\s)([0-9]{1,2}\s?(?!am\b|pm\b)[a-z]{1,2})(?:['’]s)?(?=\s|$)/u;
const THIS_CLASS_RE = /\b(?:this|the current|current|my|the) class\b|\bkelas ini\b|هذا الفصل/u;
const ISO_DAY_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const ISO_MONTH_RE = /\b(\d{4}-\d{2})\b(?!-)/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const TOPIC_RE = /\b(?:kits?|catalogue|catalog)\s+(?:on|about|for|covering)\s+(.+)$/u;
const LEARNER_RE = /\b(?:report|progress record|progress report|laporan|تقرير)\s+(?:for|of|on|untuk)\s+(.+)$/u;

/** The user's LOCAL calendar day as a UTC-midnight Date (so the getUTC*
 *  accessors below read local values): the collector's iso carries the
 *  browser's offset, and "today" must mean the teacher's today. */
function localDate(now: Date, clock?: SkCollector["clock"]): Date {
  const m = (clock?.iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return now;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function shiftDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function dayFilter(t: string, now: Date, clock?: SkCollector["clock"]): string | undefined {
  const iso = t.match(ISO_DAY_RE)?.[1];
  if (iso) return iso;
  const base = localDate(now, clock);
  if (/\b(?:today|hari ini)\b|اليوم/u.test(t)) return ymd(base);
  if (/\b(?:tomorrow|esok)\b|غدا|غداً/u.test(t)) return ymd(shiftDays(base, 1));
  if (/\b(?:yesterday|semalam)\b|أمس|البارحة/u.test(t)) return ymd(shiftDays(base, -1));
  return undefined;
}

export function monthFilter(t: string, now: Date, clock?: SkCollector["clock"]): string | undefined {
  const iso = t.match(ISO_MONTH_RE)?.[1];
  if (iso && !ISO_DAY_RE.test(t)) return iso;
  const base = localDate(now, clock);
  const ym = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, "0")}`;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  if (/\b(?:this month|bulan ini)\b|هذا الشهر/u.test(t)) return ym(y, m);
  if (/\b(?:next month|bulan depan)\b|الشهر القادم|الشهر المقبل/u.test(t)) return m === 11 ? ym(y + 1, 0) : ym(y, m + 1);
  if (/\b(?:last month|bulan lepas)\b|الشهر الماضي/u.test(t)) return m === 0 ? ym(y - 1, 11) : ym(y, m - 1);
  const idx = MONTHS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(t));
  if (idx >= 0) return ym(y, idx);
  return undefined;
}

export function classQueryOf(t: string): string | undefined {
  const m = t.match(CLASS_RE);
  const raw = (m?.[1] ?? m?.[2])?.trim();
  return raw ? raw.replace(/\s+/g, " ") : undefined;
}

const CLASS_TARGETS: ReadonlySet<NavTarget> = new Set<NavTarget>(["analytics", "diary", "school_diary"]);

export function routeByRules(text: string, ctx: SkContext, now: Date, clock?: SkCollector["clock"]): RulesDecision {
  const raw = (text ?? "").trim();
  const t = norm(raw);
  if (!t) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };
  if (THANKS_RE.test(t)) return { intent: "chat", reply: SK_CHAT_THANKS };
  if (ACK_RE.test(t)) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };

  const isQuestion = /[?؟]\s*$/.test(raw) || /^(?:what|which|who|whose|how|when|where|why|is|are|do|does|did|can|could|has|have|berapa|siapa|apa|bila|mana|bagaimana|ما|من|كم|متى|كيف|هل)\b/u.test(t);
  const target = findTarget(t);
  const hasVerb = VERB_RE.test(t);
  // A bare target ("analytics", "papan") counts as a navigate; a question
  // about a target ("what's on the board?") does not.
  const bare = !!target && !isQuestion && t.split(" ").length <= 4;
  if (target && (hasVerb || bare) && !(isQuestion && !hasVerb)) {
    const filters: NavFilters = {};
    let classQuery: string | undefined;
    let learnerQuery: string | undefined;
    if (CLASS_TARGETS.has(target)) {
      if (THIS_CLASS_RE.test(t) && ctx.selection.classId) filters.classId = ctx.selection.classId;
      else classQuery = classQueryOf(t);
    }
    if (target === "diary" || target === "school_diary") {
      const d = dayFilter(t, now, clock);
      if (d) filters.day = d;
    }
    if (target === "calendar") {
      const m = monthFilter(t, now, clock);
      if (m) filters.month = m;
    }
    if (target === "kits") {
      const topic = t.match(TOPIC_RE)?.[1]?.trim();
      if (topic) filters.topic = topic.slice(0, 80);
    }
    if (target === "reports") {
      const who = raw.match(new RegExp(LEARNER_RE.source, "iu"))?.[1]?.trim();
      if (who) learnerQuery = who.replace(/['’]s$/u, "").slice(0, 60);
      else if (ctx.selection.learnerId) filters.learnerId = ctx.selection.learnerId;
    }
    return { intent: "navigate", target, filters, ...(classQuery ? { classQuery } : {}), ...(learnerQuery ? { learnerQuery } : {}) };
  }

  return { intent: "ask" };
}

export { NAV_TARGETS };

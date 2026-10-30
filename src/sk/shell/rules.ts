// SK Shell — the deterministic rules router (Final Plan §2.1 router, S0 cut).
//
// S0 ships no model-based router: navigation and bare acknowledgements are
// decided here, by rules, with no model call (acceptance: a navigate lands
// within 2 s); everything else is handed to the teacher model with intent
// "ask". The Haiku router of §2.1 arrives with the teaching moves (S1/S2).
// Pure: text + context + clock in, decision out.

import type { SkBoardMove, SkCollector, SkContext, SkIntent } from "./types";
import { NAV_TARGETS, type NavFilters, type NavTarget } from "@/sk/capabilities/navigate";
import { resolveSegment } from "@/sk/capabilities/board";
import { findBookCode, findOrderNumber } from "@/sk/book-activate";
// S4: the parent phrasings (child.*), decided before the act and navigate rules.
import { routeParent, type ParentRoute } from "./parent-rules";
// S5 slice A: the leader phrasings (school.health + the leader modes).
import { routeLeader, type LeaderRoute } from "./leader-rules";
// 2026-10-30: "say that in Malay" / "back to English" — the answer language.
import { parseLanguageCommand, type LangCommand } from "./language";
import { walkStartCommand } from "./client/walkthrough";
// 2026-10-30: the ONE greeting / politeness normaliser every rule reads through.
import { frameIntent, normalizeIntent } from "./intent-normalize";

export type RulesDecision =
  | { intent: "navigate"; target: NavTarget; filters: NavFilters; classQuery?: string; learnerQuery?: string; kitQuery?: string }
  | { intent: "chat"; reply: string }
  /** S1: a Board move decided by rules (only while the collector reports an
   *  open Board session). `args` are the capability's arguments; `k` is 0-based. */
  | { intent: "teach"; move: SkBoardMove; args: Record<string, unknown> }
  /** S2: a teacher action phrasing ("post a notice to 7B: …", "remind the
   *  parents …"). Decided here only so it is never mistaken for a navigate
   *  ("write in Ali's diary" names the diary); the model still resolves it
   *  through the action's capability, which returns a confirm card. */
  | { intent: "act"; action: SkActPhrase }
  /** S4 slice D: a book code / activation phrasing, or the answer SK asked
   *  for (order number, which child). Decided here for EVERY role so a code
   *  never reaches a model prompt; the route runs `book.activate` directly. */
  | { intent: "act"; action: "book.activate"; book: BookActArgs }
  /** S3 slice D: a student tutor move or read, decided by rules (students
   *  only). The moves and the reads make NO model call; tutor.explain makes
   *  exactly one (the kit turn, metered once). */
  | { intent: "tutor"; capability: SkTutorCapability; args: Record<string, unknown> }
  /** S4: a parent's question about a child, answered by the child.*
   *  capability itself — deterministic, no model (parent-rules.ts). */
  | { intent: "ask"; parent: ParentRoute }
  /** S5 slice A: a principal's / coordinator's school question, answered by
   *  the capability itself in the hat's school / scope mode — no model. */
  | { intent: "ask"; leader: LeaderRoute }
  /** 2026-10-30: repeat SK's last explanation in another language, or go
   *  back to one — every role; the route answers without the teacher model
   *  (a repeat makes ONE translation call on the last answer). */
  | { intent: "lang"; command: LangCommand }
  /** 2026-10-30: "Show me around" / "give me the tour" / "demo" — replay the
   *  first-login walkthrough, every role, no model. */
  | { intent: "tour" }
  | { intent: Exclude<SkIntent, "navigate" | "chat" | "teach" | "act" | "tutor" | "lang" | "tour"> };

export type SkTutorCapability = "tutor.play" | "tutor.section" | "tutor.slide" | "tutor.practise" | "tutor.where" | "tutor.progress" | "tutor.explain";

/** S4 slice D: what the rules pull out of a book-activation utterance. */
export type BookActArgs = { code?: string; orderNumber?: string; childQuery?: string };

export type SkActPhrase = "diary.note" | "parents.remind" | "marking.next" | "marking.grade" | "lesson.prepare" | "notice.school";

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

// Compiled ONCE: a `\p{L}\p{N}` class costs V8 about 1–2 ms to build, and
// building these ~120 on every turn made routeByRules a 160–250 ms step of
// every SK turn (measured 2026-10-29, fix/sk-speed). Same patterns, same order.
const TARGET_RES: Array<[NavTarget, RegExp[]]> = TARGET_WORDS.map(([target, words]) => [
  target,
  // Whole phrase, bounded by start/end or a non-letter (works for Arabic too).
  words.map((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(w)}(?:$|[^\\p{L}\\p{N}])`, "u")),
]);

export function findTarget(t: string): NavTarget | null {
  for (const [target, res] of TARGET_RES) {
    for (const re of res) if (re.test(t)) return target;
  }
  return null;
}

// "7B", "7 B", "class 7B", "Year 7B's", "kelas 5 Amanah" — never "10am"/"3pm".
const CLASS_RE = /(?:^|\s)(?:class|kelas|grade|year|form|tingkatan|darjah|tahun)\s+([0-9]{1,2}\s?[a-z]{1,2}|[0-9]{1,2}\s[a-z]{3,})(?:['’]s)?(?=\s|$)|(?:^|\s)([0-9]{1,2}\s?(?!am\b|pm\b)[a-z]{1,2})(?:['’]s)?(?=\s|$)/u;
const THIS_CLASS_RE = /\b(?:this|the current|current|my|the) class\b|\bkelas ini\b|هذا الفصل/u;
const ISO_DAY_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const ISO_MONTH_RE = /\b(\d{4}-\d{2})\b(?!-)/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RES = MONTHS.map((name) => new RegExp(`\\b${name}\\b`));
const TOPIC_RE = /\b(?:kits?|catalogue|catalog)\s+(?:on|about|for|covering)\s+(.+)$/u;
const LEARNER_RE = /\b(?:report|progress record|progress report|laporan|تقرير)\s+(?:for|of|on|untuk)\s+(.+)$/u;
/** The same, case-insensitive, for the raw (un-lowercased) text. */
const LEARNER_RE_I = new RegExp(LEARNER_RE.source, "iu");

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
  const idx = MONTH_RES.findIndex((re) => re.test(t));
  if (idx >= 0) return ym(y, idx);
  return undefined;
}

export function classQueryOf(t: string): string | undefined {
  const m = t.match(CLASS_RE);
  const raw = (m?.[1] ?? m?.[2])?.trim();
  return raw ? raw.replace(/\s+/g, " ") : undefined;
}

const CLASS_TARGETS: ReadonlySet<NavTarget> = new Set<NavTarget>(["analytics", "diary", "school_diary"]);

// ── S1: Board phrasings (English, Malay, Arabic) ────────────────────────────
//
// Deterministic, like navigation: a teacher mid-lesson must not wait on a
// model round trip to pause a video. Every pattern is anchored so "go back to
// the library" stays a navigate and "explain" is only taken with a concept.
// Spoken slide numbers are 1-based; the capabilities take k = n − 1.

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1,
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, delapan: 8, sembilan: 9, sepuluh: 10,
  واحد: 1, واحدة: 1, اثنان: 2, اثنين: 2, اثنتين: 2, اثنتان: 2, ثلاث: 3, ثلاثة: 3, أربع: 4, أربعة: 4, اربع: 4, اربعة: 4,
  خمس: 5, خمسة: 5, ست: 6, ستة: 6, سبع: 7, سبعة: 7, ثمان: 8, ثماني: 8, ثمانية: 8, تسع: 9, تسعة: 9, عشر: 10, عشرة: 10,
};
const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;

export function numberOf(s: string | undefined): number | null {
  if (!s) return null;
  const w = s.trim().toLowerCase();
  if (/^\d{1,2}$/.test(w)) return Number(w);
  return NUMBER_WORDS[w] ?? null;
}

/** `^` + optional politeness + body + optional politeness + `$`. */
const polite = (body: string) => new RegExp(`^(?:please |sila |tolong |من فضلك |الرجاء )?(?:${body})(?: please| sila| now| sekarang| الآن| من فضلك)?$`, "u");

const PAUSE_RE = polite("pause(?: (?:it|the video|there|here))?|stop(?: (?:it|there|here|the video))?|hold (?:on|it)(?: there)?|wait(?: there)?|berhenti(?: (?:sini|di sini|dulu|sekejap))?|jeda(?:kan)?(?: video)?|hentikan(?: video)?|tunggu(?: dulu| sekejap)?|توقف(?: هنا| هناك)?|قف(?: هنا)?|أوقف(?: الفيديو)?|اوقف(?: الفيديو)?|انتظر");
const RESUME_RE = polite("continue(?: (?:the video|playing|on))?|resume(?: (?:it|the video))?|carry on|go on|keep going|play on|un-?pause|sambung(?:kan)?(?: video| semula)?|teruskan(?: video)?|lanjutkan|mainkan semula|تابع(?: الفيديو)?|استمر|واصل(?: الفيديو)?|كمل|أكمل(?: الفيديو)?|اكمل");
const INTRO_RE = polite(
  "(?:start|play|begin|run|roll) (?:the |this )?(?:video|intro|introduction|lesson video|film)(?: from the (?:start|beginning|top))?|start (?:from the (?:beginning|top)|with the (?:video|intro|introduction))|play(?: it)? from the (?:start|beginning)|start the lesson|mula(?:kan)? (?:video|pengenalan|pelajaran|dari awal)|main(?:kan)? (?:video|pengenalan)(?: dari (?:awal|mula))?|putar video|ابدأ (?:الفيديو|المقدمة|الدرس)|ابدا (?:الفيديو|المقدمة|الدرس)|شغل (?:الفيديو|المقدمة)|شغّل (?:الفيديو|المقدمة)|اعرض الفيديو",
);
const NEXT_RE = polite("(?:go to |show |move to |buka |tunjuk(?:kan)? |pergi ke |اعرض |اذهب (?:إلى|الى) |انتقل (?:إلى|الى) )?(?:(?:the )?next (?:slide|segment|part|one)|(?:slaid|bahagian|segmen) (?:seterusnya|berikutnya|selepas ini)|(?:الشريحة|الجزء|المقطع) (?:التالية|التالي|القادمة|القادم))");
const PREV_RE = polite("(?:go to |show |move to |buka |tunjuk(?:kan)? |pergi ke |اعرض |اذهب (?:إلى|الى) |انتقل (?:إلى|الى) )?(?:(?:the )?(?:previous|last|preceding) (?:slide|segment|part)|(?:slaid|bahagian|segmen) (?:sebelumnya|sebelum ini|tadi)|(?:الشريحة|الجزء|المقطع) (?:السابقة|السابق))");
// Board UX (2026-10-28). "Skip to the PowerPoint / show the slides": the deck
// is never rendered (Final Plan §5.3) — slide 1 of the video's own frames,
// with SK saying so (`deck: true` picks that line in board.ts).
const SLIDES_RE = polite(
  "(?:skip to|go to|jump to|show(?: me)?|open|switch to|bring up|move to|buka|tunjuk(?:kan)?|papar(?:kan)?|pergi ke|langkau ke|اعرض|أرني|اذهب (?:إلى|الى)|انتقل (?:إلى|الى)|افتح) (?:the |this |our )?(?:power ?point(?: presentation| slides)?|slides|slide deck|slide ?show|deck|presentation|ppt|pptx|slaid(?:-slaid)?|persembahan(?: slaid)?|dek slaid|الشرائح|العرض(?: التقديمي)?|البوربوينت|عرض الشرائح)",
);
// Every slide onto the roll as pages (the founder's "load each slide as 1 page").
const LOAD_SLIDES_RE = polite(
  "(?:load|put|place|bring|lay) (?:all |all of )?(?:the |this )?(?:slides|slide deck|deck|power ?point|presentation)(?: (?:on|onto|to) (?:the )?(?:board|roll))?(?: as (?:pages?|a page each|one page each))?|load (?:the )?slides as pages|muat(?:kan)? (?:semua )?slaid(?: (?:ke|pada) (?:papan|gulungan))?(?: sebagai (?:halaman|muka surat))?|letak(?:kan)? slaid (?:di|ke|pada) papan|حمّل الشرائح(?: كصفحات| على اللوحة)?|حمل الشرائح(?: كصفحات| على اللوحة)?|ضع الشرائح على اللوحة",
);
// The kit's .pptx onto the roll, one rendered slide per page (founder
// 2026-10-28: "the pptx loaded on the board … each slide as 1 page"). The
// DECK words — deck, PowerPoint, presentation, pptx — load the file's own
// pages; "load the slides" stays the video's frames (LOAD_SLIDES_RE). Checked
// first, so "put the powerpoint on the board" is the deck.
const LOAD_DECK_RE = polite(
  "(?:load|put|place|lay) (?:the |this |our )?(?:slide deck|deck|power ?point(?: presentation| slides| deck)?|presentation|pptx?|ppt file|pptx file)(?: (?:on|onto|to|in) (?:the )?(?:board|roll))?(?: as (?:pages?|a page each|one page each|slides))?|muat(?:kan)? (?:semua )?(?:dek(?: slaid)?|power ?point|persembahan(?: slaid)?|pptx?)(?: (?:ke|pada|di) (?:papan|gulungan))?(?: sebagai (?:halaman|muka surat))?|letak(?:kan)? (?:dek(?: slaid)?|power ?point|persembahan) (?:di|ke|pada) papan|(?:حمّل|حمل|ضع) (?:العرض التقديمي|البوربوينت|ملف العرض|عرض الشرائح)(?: كصفحات| على اللوحة)?",
);
// The unit rail over the stage: a UI control, not a video move.
const RAIL_OPEN_RE = polite(
  "(?:show(?: me)?|open|bring up|display|tunjuk(?:kan)?|buka|papar(?:kan)?|اعرض|أرني|افتح) (?:the )?(?:units?(?: list| rail| panel)?|rail|side ?panel|panel|unit(?:-unit)?|senarai unit|rel|panel unit|الوحدات|اللوحة الجانبية|الشريط الجانبي|قائمة الوحدات)",
);
const RAIL_CLOSE_RE = polite(
  "(?:hide|close|dismiss|tutup|sorok(?:kan)?|أغلق|اغلق|أخفِ|اخف) (?:the )?(?:units?(?: list| rail| panel)?|rail|side ?panel|panel|unit(?:-unit)?|senarai unit|rel|panel unit|الوحدات|اللوحة الجانبية|الشريط الجانبي|قائمة الوحدات)",
);
const SLIDE_N_RE = polite(`(?:(?:go to|show(?: me)?|open|jump to|move to|skip to|buka|tunjuk(?:kan)?|papar(?:kan)?|pergi ke|اعرض|اذهب (?:إلى|الى)|انتقل (?:إلى|الى)) )?(?:the )?(?:slide|slaid|الشريحة|شريحة|للشريحة)(?: (?:number|no\\.?|nombor|رقم))? ${NUM}`);
const SEGMENT_N_RE = polite(`(?:(?:play|go to|jump to|skip to|show|main(?:kan)?|pergi ke|شغل|شغّل|اذهب (?:إلى|الى)|انتقل (?:إلى|الى)) )?(?:the )?(?:segment|part|section|segmen|bahagian|الجزء|جزء|المقطع|مقطع)(?: (?:number|no\\.?|nombor|رقم))? ${NUM}`);
const COMPARE_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك )?(?:(?:compare|contrast|bandingkan|banding|قارن(?: بين)?|قارني(?: بين)?) (?:the |between )?(.+?) (?:and|with|to|vs\\.?|versus|against|dan|dengan|و)\\s?(.+)|(?:(?:what(?:'s| is) )?(?:the )?difference between|(?:apa(?:kah)? )?(?:beza|perbezaan)(?: antara)?|(?:ما |ما هو )?الفرق بين) (.+?) (?:and|dan|dengan|و)\\s?(.+))$",
  "iu",
);
const EXPLAIN_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك |can you |could you |boleh |بإمكانك )?(?:explain|describe|teach(?: them| the class)?|go over|cover|clarify|terangkan|jelaskan|huraikan|ajar(?:kan)?|اشرح|اشرحي|وضح|وضّح|فسر|فسّر|بين)(?: (?:to )?(?:me|us|them|the class|kepada (?:mereka|kelas|saya)|pada mereka|لي|لنا|لهم|للصف))? (.+)$",
  "iu",
);
const FREEZE_RE = polite("freeze(?: (?:it|that))?(?: (?:there|here))?(?: the (?:frame|video|screen|picture))?|freeze frame|bekukan(?: (?:ia|skrin|video|bingkai))?|beku(?:kan)? skrin|ثبت(?: (?:الصورة|الشاشة|الإطار|اللقطة))?|ثبّت(?: (?:الصورة|الشاشة))?|جمد(?: (?:الصورة|الشاشة))?|جمّد(?: (?:الصورة|الشاشة))?");
const BLANK_RE = polite("(?:(?:a |new |another |give me a |open a |add a )?blank(?: page)?|new page|empty page|clear page|(?:buka |tambah |beri )?(?:halaman|muka surat|muka) (?:kosong|baru)|صفحة (?:فارغة|جديدة|بيضاء)|(?:افتح |أضف |اضف )صفحة (?:فارغة|جديدة))");
const BACK_RE = polite("(?:go |page |one page |take it |move )?back(?: (?:a |one )?page)?|previous page|last page|undo (?:the )?page|kembali(?: (?:satu |ke )?(?:halaman|muka surat)(?: sebelumnya)?)?|(?:halaman|muka surat) sebelum(?:nya)?|ارجع(?: صفحة)?|عد(?: (?:صفحة|للخلف))?|للخلف|الصفحة السابقة|صفحة للخلف|رجوع");
const PRACTISE_RE = polite(
  `(?:(?:give|show|put up|set|ask|pose|throw)(?: (?:them|the class|us|me|the students|the kids|everyone))? |let'?s (?:do|try|have) |(?:beri(?:kan)?|tunjuk(?:kan)?|tanya|bagi)(?: (?:mereka|kelas|kami|murid|pelajar))? |(?:أعط|اعط|أعطِ|اعطي|أعطي|اطرح|أطرح|اعرض|أعرض)(?:هم| الصف| الطلاب| التلاميذ)? )?(${NUM.slice(1, -1)}|some|a few|a couple of|beberapa|sedikit|بعض) (?:practice |practise |quick |more |latihan |)?(?:questions?|problems?|exercises?|qs|soalan(?: latihan)?|latihan|أسئلة|اسئلة|سؤال|سؤالاً|سؤالا|تمارين|تدريبات)(?: (?:on|about|for) (?:this|that|it|this part|this slide|the class|them))?(?: untuk kelas| untuk mereka| tentang ini| mengenai ini| للصف| لهم| عن هذا)?|(?:give them |show |beri |tunjuk |اعرض |أعرض )?(?:some |a few |beberapa |بعض )?(?:practice|practise) (?:questions|problems)|(?:soalan|latihan) latihan|أسئلة (?:تدريبية|للتدريب|تمرين)|practice time|latihan`,
);
const WALKTHROUGH_RE = polite(
  "(?:(?:let'?s |can we |shall we )?(?:walk|go|run|work|talk) (?:them |the class |us )?through (?:the |this )?(?:worksheet|questions|exercises|sheet|paper)(?: together| in order| one by one)?|(?:worksheet )?walk-?through|do the worksheet(?: together| in order)?|(?:open|show) the worksheet(?: questions)?|(?:mari |jom |kita )?(?:teliti|bincang(?:kan)?|semak|jalani|bimbing) (?:lembaran kerja|soalan lembaran kerja|lembaran)(?: bersama| satu demi satu| mengikut urutan)?|(?:buka|tunjuk(?:kan)?) lembaran kerja|(?:لن|ل|ا|دعنا ن|هيا ن)?(?:ستعرض|راجع|نراجع|نستعرض|تصفح|نتصفح) ورقة العمل(?: معاً| معا| بالترتيب| سؤالاً سؤالاً)?|(?:افتح|اعرض|أعرض) ورقة العمل)",
);
const RECAP_RE = polite(
  "(?:(?:let'?s )?(?:end|finish|wrap up|close|conclude|stop) (?:the |this |today'?s )?(?:lesson|class|session|period)(?: (?:now|here|there))?|(?:lesson |give (?:me |them |us )?(?:a |the )?)?recap(?: the lesson| of the lesson| time)?|wrap(?: it)? up|summar(?:y|ise|ize)(?: the lesson| time)?|(?:mari |jom |kita )?(?:tamat(?:kan)?|akhiri|habiskan|tutup) (?:pelajaran|kelas|sesi)(?: (?:ini|sekarang|hari ini))?|(?:buat |beri |berikan )?(?:rumusan|ringkasan|rekap|imbasan)(?: pelajaran)?|(?:أنهِ|أنه|انه|أنهي|انهي|اختم|اختتم|لننهِ|لننه|لنختم|أغلق|اغلق) (?:الدرس|الحصة|الجلسة)(?: الآن| هنا)?|(?:ملخص|الخلاصة|خلاصة|تلخيص)(?: الدرس)?|لخص الدرس|لخّص الدرس)",
);

// "Highlight a portion and ask SK" (founder 2026-10-28). Two sets, because
// "this" means something only when there IS a highlight:
//   EXPLAIN_THIS_RE — the imperative "explain this (part)" and the chip's own
//     line in all ten locales (sk.shell.explainSelection). Always the
//     selection move on the Board: without a highlight it answers "highlight
//     the part first" instead of looking up a concept called "this".
//   ASK_THIS_RE — the question forms ("what does this mean", "tell me more
//     about this"). The selection move only while a highlight is live (the
//     client sends it for 60 s); otherwise they go where they always went.
const THIS_EN = "(?:this|that|it|these|those)(?: (?:part|bit|line|sentence|phrase|word|words|point))?|the highlighted (?:part|bit|text|words?|line)|what i(?:'ve)? highlighted|the highlight";
const EXPLAIN_THIS_RE = polite(
  [
    `(?:can you |could you |would you )?(?:explain|clarify|describe|unpack)(?: (?:to |for )?(?:me|us|them|the class))? (?:${THIS_EN})(?: (?:to|for) (?:me|us|them|the class))?(?: (?:a bit )?more| further| in more detail)?`,
    "(?:terangkan|jelaskan|huraikan)(?: (?:kepada|pada) (?:saya|kami|mereka|kelas))? (?:ini|itu|bahagian (?:ini|itu)|yang (?:ini|saya serlahkan))(?: lagi| dengan lebih lanjut)?",
    "(?:تراڠکن|جلسکن) (?:بهاݢين )?(?:اين|ايني|ايت)",
    "(?:اشرح|اشرحي|وضح|وضّح|فسر|فسّر)(?: لي| لنا| لهم)? (?:هذا|هذه|ذلك|تلك)(?: (?:الجزء|الفقرة|السطر|الكلمة|الجملة))?(?: أكثر)?|(?:اشرح|اشرحي|وضح|وضّح) (?:الجزء|النص) المظلل",
    "explique(?:z|-moi|-nous)? (?:cette partie|ce passage|ceci|ça|cela)",
    "explica(?:me|nos)? (?:esta parte|este fragmento|esto|eso)",
    "explica(?:-me)?(?: lá)? (?:esta parte|este excerto|isto|isso)",
    "ఈ భాగాన్ని వివరించండి|దీన్ని వివరించండి",
    "हा भाग समजावून सांगा|हे समजावून सांगा",
    "इस हिस्से को समझाइए|इसे समझाइए|इस भाग को समझाइए",
  ].join("|"),
);
const ASK_THIS_RE = polite(
  [
    "what (?:does|do) (?:this|that|these|those)(?: (?:part|bit|line|sentence|phrase|word|words))? mean|what(?:'s| is) (?:this|that)(?: (?:part|bit))?(?: about| saying)?|what (?:is|are) (?:they|it) saying here",
    "tell (?:me|us|them|the class) (?:a bit )?more(?: about (?:this|that|it)(?: (?:part|bit))?)?|(?:say|go) (?:a bit )?more (?:about|on) (?:this|that)|more on (?:this|that)",
    "apa(?:kah)? maksud(?:nya)?(?: (?:ini|itu|bahagian ini|perkataan ini))?|(?:ceritakan|beritahu)(?: (?:saya|kami|mereka))? (?:lebih lanjut |lagi )?(?:tentang|mengenai) (?:ini|itu)",
    "(?:ما|ماذا) (?:معنى|يعني) (?:هذا|هذه|ذلك|تلك)(?: الجزء| الكلمة| السطر)?|(?:أخبرني|اخبرني|حدثني|أخبرنا) (?:المزيد |أكثر )?عن (?:هذا|هذه|ذلك)(?: الجزء)?",
  ].join("|"),
);

/** The selection move for this text, or null (see EXPLAIN_THIS_RE / ASK_THIS_RE). */
export function explainSelectionOf(t: string, ctx: SkContext): boolean {
  if (EXPLAIN_THIS_RE.test(t)) return true;
  return !!ctx.board?.selection && ASK_THIS_RE.test(t);
}

// Arabic's definite article stays: "الانتشار" IS the concept as said.
const EXPLAIN_LEAD_RE = /^(?:the |about |tentang |mengenai |عن )?/u;
const EXPLAIN_SLIDE_RE = new RegExp(`\\s+(?:using|with|on|from|guna(?:kan)?|dengan|pada|بـ?|باستخدام|على|في|من) (?:the )?(?:slide|slaid|الشريحة|شريحة) ${NUM}$`, "u");

function cleanConcept(s: string): string {
  return s.replace(EXPLAIN_LEAD_RE, "").replace(/[?؟.!,;:]+$/u, "").trim().slice(0, 120);
}

const prevK = (ctx: SkContext) => Math.max(0, (ctx.board?.k ?? 1) - 1);
const nextK = (ctx: SkContext) => (ctx.board?.k ?? -1) + 1;

/** Board moves by rules. Null when the text is not a Board phrase. The
 *  caller only asks while `ctx.board` (an open session) is present. */
export function routeBoard(raw: string, normed: string, ctx: SkContext): RulesDecision | null {
  const teach = (move: SkBoardMove, args: Record<string, unknown> = {}): RulesDecision => ({ intent: "teach", move, args });
  // "pause, please" / "stop there, now": commas are breath, not meaning.
  const t = normed.replace(/\s*[,،]\s*/gu, " ").trim();
  if (PAUSE_RE.test(t)) return teach("pause");
  if (RESUME_RE.test(t)) return teach("resume");
  if (INTRO_RE.test(t)) return teach("intro");
  if (NEXT_RE.test(t)) return teach("slide", { k: nextK(ctx) });
  if (PREV_RE.test(t)) return teach("slide", { k: prevK(ctx) });
  // Board UX: the whole-deck phrasings before the numbered slide, so "show the
  // slides" is slide 1 of the frames and "load the slides" is the page load.
  if (LOAD_DECK_RE.test(t)) return teach("load_deck");
  if (LOAD_SLIDES_RE.test(t)) return teach("load_slides");
  if (SLIDES_RE.test(t)) return teach("slide", { k: 0, deck: true });
  if (RAIL_OPEN_RE.test(t)) return teach("rail", { open: true });
  if (RAIL_CLOSE_RE.test(t)) return teach("rail", { open: false });
  let m = t.match(SLIDE_N_RE);
  if (m) {
    const n = numberOf(m[1]);
    if (n && n >= 1) return teach("slide", { k: n - 1 });
  }
  m = t.match(SEGMENT_N_RE);
  if (m) {
    const n = numberOf(m[1]);
    if (n && n >= 1) return teach("segment", { k: n - 1 });
  }
  if (FREEZE_RE.test(t)) return teach("freeze");
  if (BLANK_RE.test(t)) return teach("blank");
  if (BACK_RE.test(t)) return teach("back");
  if (WALKTHROUGH_RE.test(t)) return teach("walkthrough");
  if (RECAP_RE.test(t)) return teach("recap");
  m = t.match(PRACTISE_RE);
  if (m) {
    const n = numberOf(m[1]) ?? 3;
    return teach("practise", { n: Math.max(1, Math.min(10, n)) });
  }
  // The highlighted part of a deck slide, before compare/explain: "explain
  // this" is the highlight, never a concept called "this".
  if (explainSelectionOf(t.replace(/[?؟]+$/u, "").trim(), ctx)) return teach("explain_selection");
  // Compare before explain: "explain the difference between a and b" is a compare.
  const bare = raw.replace(/[?؟.!]+$/u, "").trim();
  const c = bare.match(COMPARE_RE);
  if (c) {
    const a = cleanConcept(c[1] ?? c[3] ?? "");
    const b = cleanConcept(c[2] ?? c[4] ?? "");
    if (a && b) return teach("compare", { a, b });
  }
  const e = bare.match(EXPLAIN_RE);
  if (e) {
    let rest = e[1].trim();
    const inner = rest.match(COMPARE_RE);
    if (inner) {
      const a = cleanConcept(inner[1] ?? inner[3] ?? "");
      const b = cleanConcept(inner[2] ?? inner[4] ?? "");
      if (a && b) return teach("compare", { a, b });
    }
    const args: Record<string, unknown> = {};
    const s = rest.match(EXPLAIN_SLIDE_RE);
    if (s) {
      const n = numberOf(s[1]);
      if (n && n >= 1) args.k = n - 1;
      rest = rest.slice(0, s.index).trim();
    }
    const concept = cleanConcept(rest);
    if (concept) return teach("explain", { concept, ...args });
  }
  return null;
}

// ── Starting a lesson with no Board session open (§2.7) ──────────────────────
//
// "start the lesson", "start the lesson for 7B on Specialised Cells", "open the
// board with Plant and Animal Cells", "mulakan pelajaran", "ابدأ الدرس" — and,
// with no session, the intro phrasings too ("start the video"): all become a
// `navigate board` with autostart and whatever class / kit words were said,
// which the turn route resolves and, failing that, fills from the Board's own
// pick or the timetable (start-lesson.ts). A bare "open the board" stays a
// plain navigate: going there is not the same as starting a lesson.
const START_LESSON_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك |الرجاء )?(?:" +
    "(?:start|begin|kick off|set up|mula(?:kan)?|ابدأ|ابدا) (?:the |a |my |this |today'?s )?(?:lesson|class|board|classroom board|pelajaran|kelas|papan|الدرس|الحصة|اللوحة)" +
    "|(?:open|buka|افتح) (?:the |a )?(?:board|classroom board|papan|اللوحة) (?=\\S)" +
    ")(?<rest>.*)$",
  "u",
);
const KIT_RE = /(?:^|\s)(?:on|about|with|using|covering|tentang|mengenai|dengan|menggunakan|عن|باستخدام|بـ)\s+(.+)$/u;
const TRAILING_PREP_RE = /\s+(?:for|to|with|untuk|bagi|dengan|لـ|ل)\s*$/u;

/** Class and kit words of a start-the-lesson phrase; null when it is not one. */
export function startLessonOf(normed: string, rawText: string): { classQuery?: string; kitQuery?: string } | null {
  const t = normed.replace(/\s*[,،]\s*/gu, " ").trim();
  let rest: string | null = null;
  const m = t.match(START_LESSON_RE);
  if (m) rest = (m.groups?.rest ?? "").trim();
  else if (INTRO_RE.test(t)) rest = "";
  if (rest === null) return null;
  const out: { classQuery?: string; kitQuery?: string } = {};
  const classQuery = classQueryOf(rest);
  if (classQuery) out.classQuery = classQuery;
  // The kit words, with the class token taken out and the original casing
  // kept for the title lookup ("Plant and Animal Cells", not lower-case).
  const withoutClass = rest.replace(CLASS_RE, " ").replace(/\s+/g, " ").replace(TRAILING_PREP_RE, "").trim();
  const k = withoutClass.match(KIT_RE)?.[1]?.replace(TRAILING_PREP_RE, "").trim();
  if (k) {
    const idx = rawText.toLowerCase().lastIndexOf(k.toLowerCase());
    out.kitQuery = (idx >= 0 ? rawText.slice(idx, idx + k.length) : k).replace(/[?؟.!]+$/u, "").trim().slice(0, 80);
  }
  return out;
}

// ── S2 teacher actions (diary note, parent reminders) ───────────────────────
//
// EN / MS / AR imperatives, anchored at the start (after a polite word), and
// never a question. Reminders first: "send a reminder to the parents" is a
// reminder, "send a reminder to 7B" is a diary note.
const ACT_POLITE = "(?:please |pls |sila |tolong |boleh |can you |could you |من فضلك |الرجاء |رجاء )?";
const CLASS_TOKEN = "(?:class |kelas |grade |year |form |tingkatan |darjah |tahun |الصف |صف |الفصل |فصل )?[0-9]{1,2} ?[a-z]{1,2}(?![a-z])";
const REMIND_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    "remind (?:the |their |all the |all |every )?(?:parents|families|mums and dads)" +
    "|(?:send|write|post) (?:a |the )?reminders? to (?:the |their |all the |all )?(?:parents|families)" +
    "|ingatkan (?:semua |para )?(?:ibu ?bapa|keluarga)" +
    "|(?:hantar|kirim) peringatan (?:kepada|pada|ke) (?:semua )?(?:ibu ?bapa|keluarga)" +
    "|(?:ذكّر|ذكر) (?:جميع )?(?:أولياء|اولياء) (?:الأمور|الامور)" +
    "|(?:أرسل|ارسل) (?:تذكيرا|تذكيراً|تذكير) (?:إلى |الى |ل)?(?:أولياء|اولياء) (?:الأمور|الامور)" +
    ")",
  "u",
);
// S5 slice D: a SCHOOL-WIDE or ALL-STAFF notice (notice.school, click-only).
// Checked before the diary phrasings, which would otherwise take "post a
// notice to …" / "hantar notis …" for one class's diary.
const WHOLE = "(?:the |all |all the |every |each |our |the whole |the entire |whole |entire )?";
const SCHOOLWIDE = "(?:whole school|entire school|school|everyone|everybody|staff|staffs|teachers|teaching staff|parents and (?:students|teachers)|all parents)";
const NOTICE_SCHOOL_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    // post a notice to the whole school / send an announcement to all staff / share a message with everyone
    "(?:post|send|put up|put out|publish|share|issue|make|give|write) (?:a |an |the )?(?:school(?:-wide| wide)? |staff |general )?(?:notice|announcement|message|memo|circular|notification) (?:to|for|with) " + WHOLE + SCHOOLWIDE + "(?![\\p{L}])" +
    // send a school notice / post a staff notice / make a school-wide announcement
    "|(?:post|send|put up|publish|issue|make|write) (?:a |an |the )?(?:school(?:-wide| wide)?|staff|whole[- ]school) (?:notice|announcement|memo|circular|notification)" +
    // tell all staff / tell the whole school / tell everyone at school / announce to everyone
    "|(?:tell|inform|notify|remind|let) " + WHOLE + "(?:whole school|entire school|staff|teachers|teaching staff|everyone|everybody)(?![\\p{L}])(?! (?:in|of|from) (?:class |form |grade )?[0-9])" +
    "|announce (?:to|for) " + WHOLE + SCHOOLWIDE + "(?![\\p{L}])" +
    // MS: hantar notis kepada semua … / maklumkan kepada semua guru / beritahu semua staf / notis sekolah
    "|(?:hantar|siarkan|keluarkan|kirim|buat) (?:satu )?(?:notis|makluman|pengumuman|hebahan|memo|pekeliling) (?:sekolah|kepada (?:semua|seluruh|warga)|untuk (?:semua|seluruh|warga)|kpd (?:semua|seluruh))" +
    "|(?:maklumkan|beritahu|bagitahu|hebahkan|umumkan) (?:kepada |pada |kpd )?(?:semua|seluruh|warga) (?:guru|cikgu|staf|kakitangan|warga sekolah|sekolah|ibu ?bapa|murid|pelajar|orang)" +
    // AR: أرسل إشعارًا للمدرسة / انشر إعلانا لجميع المعلمين / أخبر جميع الموظفين
    "|(?:أرسل|ارسل|انشر|أصدر|اصدر|وجّه|وجه) (?:إشعار|اشعار|إعلان|اعلان|تعميم|تنبيه)[\u064b-\u0652ا]* (?:لل|إلى ال|الى ال|ل|إلى |الى )?(?:مدرسة|جميع|كل|موظفين|معلمين|هيئة)" +
    "|(?:أخبر|اخبر|بلغ|بلّغ|أبلغ|ابلغ) (?:جميع|كل) (?:المعلمين|الموظفين|المدرسة|الطلاب|أولياء|اولياء)" +
    ")",
  "u",
);
const DIARY_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    // post a notice to 7B / send a note to 7B's parents / put a message in 7B's diary
    "(?:post|send|put|add|write|give|share|leave) (?:a |an |the )?(?:notice|note|message|announcement|reminder|diary note|diary entry) (?:to|for|in|on|into) " +
    // add to the diary for 7B / write in Ali's diary / put this in 7B's diary
    "|(?:add|write|put|post|note)(?: this| that| it| something| a line| an entry)? (?:to|in|into|on) (?:the |[\\p{L}0-9 ]{1,30}['’]s |the class |class )?(?:class )?diary" +
    // tell 7B … / tell 7B's parents …
    "|tell " + CLASS_TOKEN +
    // MS: tulis dalam diari 7B / maklumkan kepada 7B / hantar notis kepada 7B / beritahu 7B
    "|tulis(?:kan)? (?:dalam|di|ke|pada) (?:dalam )?(?:buku komunikasi|diari)" +
    "|maklumkan (?:kepada|pada|kpd) " +
    "|(?:hantar|siarkan|catat(?:kan)?|tulis(?:kan)?|kirim) (?:satu )?(?:notis|nota|mesej|pesanan|catatan|makluman) " +
    "|beritahu " + CLASS_TOKEN +
    // AR: اكتب في مذكرة 7B / انشر إشعارا للصف 7B / أخبر 7B
    "|(?:اكتب|أكتب|سجل|سجّل) (?:في|فى) (?:مذكرة|يوميات|اليوميات|دفتر)" +
    "|(?:انشر|أرسل|ارسل|أضف|اضف) (?:إشعارا|إشعاراً|اشعارا|إعلانا|إعلاناً|ملاحظة|رسالة|تنبيها|تنبيهاً)" +
    "|(?:أخبر|اخبر|بلغ|بلّغ) " + CLASS_TOKEN +
    // S4 slice C — a parent: tell Aisyah's teacher … / let Adam's teacher know …
    // / beritahu cikgu Adam … / أخبر معلمة عائشة … (the diary note to her child's
    // teacher; the capability's parent branch resolves the child).
    "|(?:tell|inform|message|let) (?:[\\p{L}][\\p{L}'’-]{0,30}['’]s? |my (?:son|daughter|child|kid)['’]s |(?:his|her|their) )?(?:class |form )?teachers?(?: know)?(?![\\p{L}])" +
    "|(?:beritahu|bagitahu|maklumkan(?: kepada| pada)?) (?:kepada |pada )?(?:cikgu|guru)(?: kelas)?(?![\\p{L}])" +
    "|(?:أخبر|اخبر|بلغ|بلّغ) (?:معلم|معلمة|مدرس|مدرسة|المعلم|المعلمة)(?![\\p{L}])" +
    ")",
  "u",
);

// ── S2 slice B: the marking queue and lesson prep ───────────────────────────
//
// Same contract: imperatives anchored at the start, never a question. A
// marking.next phrasing is a READ, but it is decided here for the same reason
// as the actions — "next worksheet to mark" must never navigate to the kits.
const DIGITS = "[0-9٠-٩]+(?:[.,][0-9٠-٩]+)?";
const MARK_NEXT_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    // mark the next one (from 7B) / grade the next worksheet / let's mark the next one
    "(?:let'?s )?(?:mark|grade|check) (?:the )?next(?: one| submission| worksheet| test(?: paper)?| paper| piece of work)?" +
    // next worksheet to mark / next one to grade
    "|(?:the )?next (?:one|worksheet|test(?: paper)?|paper|submission|piece of work)s? (?:to|i need to|for me to) (?:mark|grade|check)" +
    // what's left to mark / what's next to mark
    "|what'?s (?:left|next|still) (?:to|for me to) (?:mark|grade)" +
    // let's do some marking / start marking
    "|(?:let'?s (?:do (?:some |the )?)?|start (?:the )?|begin (?:the )?)(?:marking|grading)" +
    // show me / bring up the next one to mark
    "|(?:show me|bring up|open|pull up) the next (?:one |submission |worksheet |test )?(?:to|i need to) (?:mark|grade)" +
    // MS: tanda yang seterusnya / semak kerja berikutnya / kerja seterusnya untuk ditanda / mula menanda
    "|(?:tanda|semak|periksa)(?:kan)? (?:yang |kerja |lembaran kerja |ujian )?(?:seterusnya|berikutnya)" +
    "|(?:kerja|lembaran kerja|ujian|yang) (?:seterusnya|berikutnya) untuk (?:ditanda|disemak|diperiksa)" +
    "|mula(?:kan)? (?:menanda|menyemak|tanda)" +
    // AR: صحح التالي / صحّح الورقة التالية / التالي للتصحيح / ابدأ التصحيح
    "|(?:صحح|صحّح|قيّم|قيم) (?:الورقة |العمل |الواجب |الاختبار )?(?:التالي|التالية)" +
    "|(?:التالي|التالية) (?:للتصحيح|للتقييم)" +
    "|(?:ابدأ|إبدأ|لنبدأ|نبدأ) (?:ال)?(?:تصحيح|تقييم)" +
    ")",
  "u",
);
const MARK_GRADE_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    // give it 7 out of 10 / mark it 6/10 / give Ali 8 out of 10 / score that one 9 over 10 / give him 7 marks
    "(?:give|mark|score|grade|award|put)(?: it| that| this| this one| that one| him| her| them| [\\p{L}]{2,20})? (?:a |an )?" + DIGITS + "(?: ?(?:out of|over|/) ?" + DIGITS + "| marks?| points?)" +
    // 7 out of 10, good work
    "|" + DIGITS + " ?(?:out of|/) ?" + DIGITS + "(?:$|[ ,.;:—-])" +
    // MS: beri 7 daripada 10 / berikan dia 8/10 / bagi markah 7 daripada 10 / markah 7/10
    "|(?:beri(?:kan)?|bagi)(?: dia| ia| ini| itu| markah| [\\p{L}]{2,20})? " + DIGITS + " ?(?:daripada|drpd|/|per) ?" + DIGITS +
    "|markah(?:nya)? " + DIGITS + " ?(?:daripada|drpd|/) ?" + DIGITS +
    // AR: أعطه 7 من 10 / ضع لها 8 من 10 / الدرجة 7 من 10
    "|(?:أعطه|اعطه|أعطها|اعطها|أعطِه|ضع له|ضع لها|امنحه|امنحها|قيّمه|قيمه|قيّمها|قيمها)(?: درجة)? " + DIGITS + " ?(?:من|/) ?" + DIGITS +
    "|(?:الدرجة|العلامة) " + DIGITS + " ?(?:من|/) ?" + DIGITS +
    ")",
  "u",
);
const PREP_DAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|next \\p{L}+|class|[0-9]{1,2} ?[a-z]{1,2})";
const LESSON_PREPARE_PHRASE_RE = new RegExp(
  "^" +
    ACT_POLITE +
    "(?:" +
    // make a kit for chapter 3 / prepare a kit on Specialised Cells / generate the lesson kit for …
    "(?:prepare|prep|make|create|generate|build|set up)(?: me)? (?:a |an |the |my )?(?:full |new |whole )?(?:lesson |teaching )?kits? (?:for|on|about|from) " +
    // prepare the lesson on photosynthesis / generate a lesson for chapter 2
    "|(?:prepare|prep|generate|make|create)(?: me)? (?:a |the |my )?(?:video )?lesson (?:for|on|about|from) " +
    // prepare chapter 3 (of Biology)
    "|(?:prepare|prep|generate) (?:chapter|ch\\.?|unit) ?[0-9]" +
    // prepare Specialised Cells for Friday
    "|(?:prepare|prep) [\\p{L}0-9][\\p{L}0-9 '’-]{1,60} for " + PREP_DAY +
    // MS: sediakan kit untuk bab 3 / buat kit pelajaran tentang sel / sediakan bab 3 / sediakan Sel Khusus untuk Jumaat
    "|(?:sediakan|siapkan|buat(?:kan)?|jana(?:kan)?|hasilkan) (?:satu |sebuah )?(?:kit|pelajaran)(?: pelajaran)? (?:untuk|bagi|tentang|mengenai) " +
    "|(?:sediakan|siapkan|jana(?:kan)?) bab ?[0-9]" +
    "|(?:sediakan|siapkan) [\\p{L}0-9][\\p{L}0-9 '’-]{1,60} untuk (?:hari )?(?:isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|esok|kelas)" +
    // AR: جهّز حزمة للفصل 3 / حضّر درس الخلايا / أنشئ حزمة للفصل 2
    "|(?:جهّز|جهز|حضّر|حضر|أعدّ|أعد|اعد|أنشئ|انشئ|ولّد|ولد)(?: لي)? (?:حزمة|الحزمة|حزمة درس|درس|الدرس|درسا|درساً)" +
    ")",
  "u",
);

/** The S2 action a phrase asks for, or null. Questions never are actions. */
export function actPhraseOf(t: string, raw: string): SkActPhrase | null {
  if (/[?؟]\s*$/u.test(raw)) return null;
  if (REMIND_PHRASE_RE.test(t)) return "parents.remind";
  if (NOTICE_SCHOOL_PHRASE_RE.test(t)) return "notice.school";
  if (DIARY_PHRASE_RE.test(t)) return "diary.note";
  if (MARK_GRADE_PHRASE_RE.test(t)) return "marking.grade";
  if (MARK_NEXT_PHRASE_RE.test(t)) return "marking.next";
  if (LESSON_PREPARE_PHRASE_RE.test(t)) return "lesson.prepare";
  return null;
}

// ── S4 slice D: book activation (book.activate) ─────────────────────────────
//
// Three ways in, all deterministic:
//   1. the text CONTAINS a book code (SKB…/SKE…, any role, question or not) —
//      a code must never become part of a model prompt;
//   2. a student or parent says an activation phrase ("I have a code",
//      "activate my book", "aktifkan kod buku", "فعّل الكود");
//   3. SK just asked for the order number or the child (memory `pending`) and
//      this is the short answer.
const BOOK_POLITE = "(?:please |pls |sila |tolong |can you |could you |boleh |من فضلك |الرجاء )?";
const BOOK_PHRASE_RE = new RegExp(
  "^" +
    BOOK_POLITE +
    "(?:" +
    "(?:activate|redeem|enter|use|unlock) (?:my |a |the |this |our |his |her )?(?:book ?code|code|book)" +
    "|i (?:have|'ve got|ve got|got) (?:a |the |my )?(?:book ?)?code" +
    "|(?:aktifkan|tebus|masukkan|guna(?:kan)?) (?:kod(?: buku)?|buku)" +
    "|saya (?:ada|mempunyai) kod" +
    "|(?:فعّل|فعل|تفعيل|أدخل|ادخل) (?:الكود|الرمز|كود|رمز|الكتاب|كتاب)" +
    "|(?:لدي|لديّ|عندي) (?:كود|رمز)" +
    ")",
  "u",
);
const BOOK_ROLES: ReadonlySet<string> = new Set(["student", "parent"]);
const FOR_CHILD_RE = /(?:^|\s)(?:for|untuk|bagi|kepada|لـ|من أجل|الى|إلى)\s+([\p{L}][\p{L}'’ .-]{0,40})$/u;

function childPhraseOf(rest: string): string | undefined {
  const m = rest
    .trim()
    .replace(/[.!?؟,]+$/u, "")
    .match(FOR_CHILD_RE);
  const name = m?.[1]?.trim();
  return name ? name.slice(0, 60) : undefined;
}

/** The book.activate decision for this utterance, or null. */
export function bookActivateOf(raw: string, t: string, ctx: SkContext): BookActArgs | null {
  const found = findBookCode(raw);
  const orderNumber = findOrderNumber(raw) ?? undefined;
  const strip = (s: string) => {
    let out = s;
    if (found) out = out.slice(0, found.start) + " " + out.slice(found.end);
    return out
      .replace(/(?<!\d)\d{3}[\s-]?\d{7}[\s-]?\d{7}(?!\d)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  if (found) {
    const childQuery = childPhraseOf(strip(raw));
    return { code: found.code, ...(orderNumber ? { orderNumber } : {}), ...(childQuery ? { childQuery } : {}) };
  }
  const question = /[?؟]\s*$/u.test(raw);
  if (!question && BOOK_ROLES.has(ctx.user.role) && BOOK_PHRASE_RE.test(t)) {
    const childQuery = childPhraseOf(strip(raw));
    return { ...(orderNumber ? { orderNumber } : {}), ...(childQuery ? { childQuery } : {}) };
  }
  if (ctx.pending?.task === "book.activate" && !question) {
    if (orderNumber) {
      const childQuery = childPhraseOf(strip(raw));
      return { orderNumber, ...(childQuery ? { childQuery } : {}) };
    }
    // "Aisyah" / "for Aisyah" / "untuk Aisyah": a short answer to "which child?".
    // A parent's question about a child ("how is Aisyah doing", "Adam's week")
    // is not that answer: it falls through to the parent rules (child.*).
    const rest = strip(raw).replace(/[.!,]+$/u, "");
    const words = rest.split(" ").filter(Boolean);
    if (ctx.pending.needs?.[0] === "child" && words.length >= 1 && words.length <= 4 && !VERB_RE.test(t) && !routeParent(raw, ctx)) return { childQuery: childPhraseOf(rest) ?? rest };
  }
  return null;
}

// ── S3 slice D: the student tutor's phrasings (EN / MS / AR) ────────────────
//
// Checked FIRST for a student and never for anyone else. Pure moves on her
// kit player (play, pause, restart, a section, the slide, practice) and the
// two reads (where am I, how am I doing) are decided here and make no model
// call; "explain …" is decided here too and makes exactly one (the kit turn).

const T_PAUSE_RE = polite(
  "pause(?: (?:it|the video|the lesson|there|here))?|stop(?: (?:it|there|here|the video))?|hold on|wait(?: a (?:sec|second|moment))?|berhenti(?: (?:sekejap|dulu|di sini))?|jeda(?:kan)?(?: video)?|hentikan(?: video)?|tunggu(?: (?:dulu|sekejap))?|توقف(?: هنا)?|أوقف(?: الفيديو)?|اوقف(?: الفيديو)?|انتظر(?: قليلا| قليلاً)?",
);
const T_RESTART_RE = polite(
  "(?:start|play|watch)(?: it| the (?:video|lesson))? (?:again|over|from the (?:start|beginning|top))|restart(?: the (?:video|lesson))?|from the (?:start|beginning|top)|(?:mula|main(?:kan)?|tonton)(?: (?:semula|video|pelajaran))? dari (?:awal|mula)|mula(?:kan)? semula|ulang(?: dari awal)?|(?:ابدأ|ابدا|شغل|شغّل)(?: الفيديو| الدرس)? من (?:البداية|الأول|جديد)|أعد التشغيل|اعد التشغيل|من البداية",
);
const T_PLAY_RE = polite(
  "play(?: it| the (?:video|lesson|section|part))?|continue(?: (?:the video|the lesson|playing|watching))?|resume(?: (?:it|the video))?|carry on|go on|keep (?:going|playing|watching)|(?:yes |ok |okay )?(?:let'?s )?(?:carry on|continue|keep going)|(?:start|watch) the (?:video|lesson)|main(?:kan)?(?: (?:video|pelajaran|ia))?|sambung(?:kan)?(?: (?:video|tonton|semula))?|teruskan(?: (?:video|menonton))?|tonton(?: video)?|(?:ya |ok )?teruskan|شغل(?: الفيديو| الدرس)?|شغّل(?: الفيديو| الدرس)?|تابع(?: الفيديو| الدرس)?|استمر|واصل(?: الفيديو)?|أكمل(?: الفيديو| الدرس)?|اكمل(?: الفيديو| الدرس)?",
);
const T_WHERE_RE = polite(
  "where am i|where was i|where(?:'s| is) my place|what(?:'s| is)? next|what now|what (?:should|do|can) i do (?:next|now)|what should i (?:watch|study|learn|practi[cs]e) next|(?:di )?mana saya(?: sekarang)?|saya di mana|apa (?:seterusnya|lagi|yang perlu saya (?:buat|lakukan)(?: seterusnya| sekarang)?)|(?:lepas ni|selepas ini) apa|أين أنا|اين انا|ما التالي|ماذا بعد|ماذا (?:أفعل|افعل) (?:الآن|بعد ذلك)|ما الخطوة التالية",
);
const T_PROGRESS_RE = polite(
  "how am i doing|how(?:'m| am) i doing so far|how did i do|(?:show |what(?:'s| is) )?my progress|my (?:results|scores?)|what have i (?:mastered|learn(?:ed|t))|what do i need to work on|(?:bagaimana|macam mana) (?:prestasi|kemajuan|keputusan) saya|(?:tunjuk(?:kan)? )?kemajuan saya|prestasi saya|apa yang (?:saya dah kuasai|perlu saya perbaiki)|كيف (?:أدائي|ادائي|مستواي|تقدمي)|(?:أرني |اعرض )?تقدمي|ما الذي أتقنته|ماذا أتقنت|نتائجي",
);
const T_PRACTISE_RE = new RegExp(
  `^(?:please |sila |tolong |من فضلك )?(?:quiz me|test me|let me (?:practi[cs]e|try)|(?:i want to |can i |let'?s )?practi[cs]e(?: (?:this|it|now|questions|this (?:part|section)))?|(?:give|show) me (?:some |a few |the )?(?:practice |practise )?questions|(?:practice|practise) questions|(?:open |show )?(?:the )?practi[cs]e(?: panel)?|uji saya|(?:beri|bagi|tunjuk(?:kan)?) saya (?:beberapa )?soalan(?: latihan)?|(?:saya nak |mari )?(?:buat )?latihan|soalan latihan|اختبرني|(?:أعطني|اعطني) (?:بعض )?(?:الأسئلة|أسئلة|اسئلة)|(?:أريد|اريد) (?:أن |ان )?(?:أتدرب|اتدرب)|تمرين|تمارين|أسئلة (?:تدريبية|للتدريب))(?: (?:(?:on|for|about|untuk|tentang|على|عن) )?(?:section|part|bahagian|الجزء) ${NUM})?$`,
  "u",
);
const T_SLIDE_RE = new RegExp(
  `^(?:please |sila |tolong |من فضلك )?(?:(?:show|open|see)(?: me)? (?:the |this )?slide|(?:the )?slide|let me see the slide|(?:tunjuk(?:kan)?|buka|lihat)(?: saya)? slaid(?: (?:ini|itu))?|slaid|(?:اعرض|أرني|ارني)(?: لي)? (?:الشريحة|الشريحه)|الشريحة)(?: (?:number |no\\.? |nombor |رقم )?${NUM})?$`,
  "u",
);
const T_SECTION_N_RE = new RegExp(
  `^(?:please |sila |tolong |من فضلك )?(?:(?:go to|jump to|skip to|play|show(?: me)?|take me to|pergi ke|lompat ke|main(?:kan)?|tunjuk(?:kan)?|انتقل (?:إلى|الى)|اذهب (?:إلى|الى)|شغل|شغّل) )?(?:the )?(?:section|part|bahagian|الجزء|جزء)(?: (?:number|no\\.?|nombor|رقم))? ${NUM}$`,
  "u",
);
const T_NEXT_RE = polite(
  "(?:go to |play |show(?: me)? |pergi ke |main(?:kan)? |انتقل (?:إلى|الى) )?(?:the )?next(?: (?:section|part|bit|one))?|(?:bahagian )?(?:seterusnya|berikutnya)|(?:الجزء )?(?:التالي)",
);
const T_PREV_RE = polite(
  "(?:go to |play |show(?: me)? |pergi ke |main(?:kan)? |انتقل (?:إلى|الى) )?(?:the )?(?:previous|last)(?: (?:section|part|bit|one))|go back(?: a (?:section|part))?|(?:bahagian )?sebelum(?:nya| ini)|kembali|(?:الجزء )?السابق|ارجع|عد للخلف",
);
/** "go to the red blood cells part", "take me to tissues", "pergi ke bahagian sel darah merah", "انتقل إلى جزء خلايا الدم". */
const T_SECTION_WORDS_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك )?(?:go to|jump to|skip to|take me to|play|show me|back to|pergi ke|lompat ke|main(?:kan)?|tunjuk(?:kan)?|kembali ke|انتقل (?:إلى|الى)|اذهب (?:إلى|الى)|شغل|شغّل|ارجع (?:إلى|الى)) (?:the )?(?:(?:section|part|bit|bahagian|جزء|الجزء) (?:on |about |tentang |mengenai |عن )?)?(.+?)(?: (?:part|section|bit))?$",
  "u",
);
const T_EXPLAIN_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك |can you |could you |boleh )?(?:explain|describe|clarify|terangkan|jelaskan|huraikan|اشرح|اشرحي|وضح|وضّح|فسر|فسّر)(?: (?:it|this|that|this (?:part|section|bit)|ini|itu|bahagian ini|هذا|هذه|هذا الجزء))?(?: (?:to )?(?:me|saya|لي))?(?: (?:again|lagi|semula|مرة أخرى|again please))?$",
  "u",
);
const T_EXPLAIN_TOPIC_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك |can you |could you |boleh )?(?:explain|describe|clarify|terangkan|jelaskan|huraikan|اشرح|اشرحي|وضح|وضّح|فسر|فسّر)(?: (?:to )?(?:me|saya|لي))? (?:the |about |tentang |mengenai |عن )?(.+)$",
  "u",
);
const T_CONFUSED_RE = polite(
  "i (?:don'?t|do not) (?:understand|get it|get this)|i'?m (?:confused|lost)|what does (?:this|that|it) mean|(?:saya )?(?:tak|tidak) (?:faham|paham)|saya keliru|apa maksud(?:nya| ini)?|لم (?:أفهم|افهم)|لا (?:أفهم|افهم)|ما معنى (?:هذا|ذلك)|ماذا يعني (?:هذا|ذلك)",
);
const T_CHAPTER_RE = new RegExp(
  "^(?:please |sila |tolong |من فضلك )?(?:(?:open|go to|show(?: me)?|take me to|start|buka|pergi ke|tunjuk(?:kan)?|mula(?:kan)?|افتح|اذهب (?:إلى|الى)|انتقل (?:إلى|الى)) )?(?:the )?(?:chapter|bab|الفصل|فصل) ([0-9]{1,3})$",
  "u",
);
const T_CHAPTERS_RE = polite(
  "(?:(?:show|open|go to|back to)(?: me)? )?(?:all |my |the )?chapters|(?:the )?chapter list|(?:tunjuk(?:kan)?|buka|kembali ke) (?:semua )?bab|senarai bab|bab-bab saya|(?:اعرض|افتح|ارجع (?:إلى|الى)) (?:كل )?الفصول|قائمة الفصول|فصولي",
);

/** The student's book: the open kit's, the selection's, or the /sk/<product> path's. */
function tutorProduct(ctx: SkContext): string | undefined {
  if (ctx.tutor?.product) return ctx.tutor.product;
  if (ctx.selection.productSlug) return ctx.selection.productSlug;
  const m = /^\/sk\/([^/?#]+)/.exec(ctx.place.path);
  return m?.[1] && /^[a-z0-9][a-z0-9_-]{0,119}$/i.test(m[1]) ? m[1] : undefined;
}

/** A section heading the words name, from the kit player's own list. */
function sectionByWords(words: string, ctx: SkContext): number | null {
  const segs = ctx.tutor?.segments ?? [];
  if (!segs.length || !words.trim()) return null;
  const hit = resolveSegment(words, { sessionId: "tutor", segments: segs.map((s) => ({ k: s.k, heading: s.heading, id: s.key })) });
  return hit ? hit.k : null;
}

/** Student tutor phrasings. Null when the text is not one (it then goes on to
 *  the navigate rules, and anything left is a question for tutor.explain). */
export function routeTutor(raw: string, normed: string, ctx: SkContext): RulesDecision | null {
  const tu = (capability: SkTutorCapability, args: Record<string, unknown> = {}): RulesDecision => ({ intent: "tutor", capability, args });
  const t = normed.replace(/\s*[,،]\s*/gu, " ").replace(/[?؟]+$/u, "").trim();
  if (T_PAUSE_RE.test(t)) return tu("tutor.play", { action: "pause" });
  if (T_RESTART_RE.test(t)) return tu("tutor.play", { action: "restart" });
  if (T_WHERE_RE.test(t)) return tu("tutor.where");
  if (T_PROGRESS_RE.test(t)) return tu("tutor.progress");
  if (T_PLAY_RE.test(t)) return tu("tutor.play", { action: "play" });
  let m = t.match(T_PRACTISE_RE);
  if (m) {
    const n = numberOf(m[1]);
    return tu("tutor.practise", n && n >= 1 ? { k: n - 1 } : {});
  }
  m = t.match(T_SLIDE_RE);
  if (m) {
    const n = numberOf(m[1]);
    return tu("tutor.slide", n && n >= 1 ? { k: n - 1 } : {});
  }
  m = t.match(T_SECTION_N_RE);
  if (m) {
    const n = numberOf(m[1]);
    if (n && n >= 1) return tu("tutor.section", { k: n - 1 });
  }
  if (T_NEXT_RE.test(t)) return tu("tutor.section", { step: "next" });
  if (T_PREV_RE.test(t)) return tu("tutor.section", { step: "previous" });
  // A chapter of her book: a navigate, no model.
  const ch = t.match(T_CHAPTER_RE);
  if (ch) {
    const product = tutorProduct(ctx);
    return { intent: "navigate", target: "tutor", filters: product ? { product, chapter: ch[1] } : {} };
  }
  if (T_CHAPTERS_RE.test(t)) {
    const product = tutorProduct(ctx);
    return { intent: "navigate", target: "tutor", filters: product ? { product } : {} };
  }
  if (T_EXPLAIN_RE.test(t) || T_CONFUSED_RE.test(t)) return tu("tutor.explain");
  // "go to the red blood cells part": only when the words name one of HER
  // sections (so "go to my timetable" stays a navigate).
  const w = t.match(T_SECTION_WORDS_RE);
  if (w) {
    const k = sectionByWords(w[1] ?? "", ctx);
    if (k !== null) return tu("tutor.section", { k });
  }
  const e = raw.replace(/[?؟.!]+$/u, "").trim().match(T_EXPLAIN_TOPIC_RE) ?? t.match(T_EXPLAIN_TOPIC_RE);
  if (e) {
    const words = (e[1] ?? "").trim().slice(0, 120);
    const k = sectionByWords(words, ctx);
    return tu("tutor.explain", k !== null ? { k } : { question: raw.slice(0, 600) });
  }
  return null;
}

// "Show me around" in the ten app languages (the phrases the tour itself
// teaches in each language's last stop) plus the real paraphrases people use
// (founder 2026-10-30: "Hi SK, show me around?" must start it). The text is
// the shared normaliser's core (intent-normalize.ts): greetings, "SK",
// "please", "can you" and the trailing "?" are already off. Anchored like the
// language commands: "show me around the cell", "give me a demo of
// photosynthesis" and "what can you do in the diary?" are questions.
const TOUR_NOUN = "(?:(?:quick|short|full|little|guided|app|product) )?(?:tour|walkthrough|walk-through|demo|onboarding|tutorial)";
const THE_APP = "(?:the app|this app|the application|sketchcast|the portal|this portal|the website|the site|everything|the place|here)";
const WALK_TOUR_RE = polite(
  [
    // English
    `show me around(?: ${THE_APP})?|show me (?:the|a) ${TOUR_NOUN}|show me the ropes`,
    `show me how (?:this|it|${THE_APP}) works|show me how to use (?:this|it|${THE_APP})|show me what (?:you|sk|sketchcast|this app|the app) can do`,
    `give me (?:the|a|an) (?:${TOUR_NOUN}|(?:quick |short |full )?(?:rundown|overview|intro|introduction))(?: (?:of|to|around) (?:${THE_APP}|it|this))?`,
    `(?:take|start|begin|play|replay|run|redo|do|launch|open|restart) (?:the|a|my|your) ${TOUR_NOUN}(?: (?:of|around) ${THE_APP})?(?: again)?`,
    `take me (?:on|for) (?:a|the) ${TOUR_NOUN}(?: (?:of|around) ${THE_APP})?|take me (?:around|through ${THE_APP})`,
    `(?:can|could|may) (?:i|we) (?:get|have|take|see|do) (?:a|the) ${TOUR_NOUN}(?: (?:of|around) ${THE_APP})?`,
    `(?:the |a |an )?${TOUR_NOUN}(?: (?:of|around) ${THE_APP})?(?: again)?`,
    `walk me through (?:${THE_APP}|it|this|how (?:this|it|${THE_APP}) works)`,
    `how (?:does|do) (?:this app|the app|the application|sketchcast|this portal|the portal|this thing|this website) work|how (?:do i|do you|to|should i) use (?:this app|the app|sketchcast|this portal|the portal)`,
    `guide me(?: (?:around|through (?:${THE_APP}|it|this)))?|(?:start|begin|show me) (?:the |my )?onboarding`,
    // Malay (Rumi)
    "tunjuk(?:kan)? (?:saya )?(?:sekeliling|sekitar)(?: (?:aplikasi|app|sketchcast)(?: ini)?)?|tunjukkan saya",
    "bawa saya (?:melawat|bersiar|berjalan-jalan|meninjau)(?: (?:aplikasi|app|sketchcast)(?: ini)?)?",
    "(?:mula(?:kan)? |beri(?:kan)? (?:saya )?|buat )?(?:satu )?lawatan(?: berpandu)?(?: (?:aplikasi|app|sketchcast)(?: ini)?)?",
    "(?:tunjuk(?:kan)? |beri(?:kan)? (?:saya )?)?(?:satu )?demo(?: (?:aplikasi|app|sketchcast)(?: ini)?)?",
    "tunjuk(?:kan)? (?:saya )?(?:cara|macam mana|bagaimana) (?:nak )?(?:guna|menggunakan|pakai) (?:aplikasi|app|sketchcast)(?: ini)?",
    "(?:bagaimana|macam mana) (?:aplikasi|app|sketchcast)(?: ini)? (?:berfungsi|bekerja)|bimbing saya|panduan (?:aplikasi|pengenalan)",
    // Malay (Jawi)
    "تونجوقکن سکليليڠ|تونجوقکن ساي|(?:مولاکن )?لاوتن(?: برڤندو)?",
    // Arabic
    "خذني (?:في |فى )?(?:ب)?جولة(?: (?:تعريفية|سريعة))?(?: في التطبيق)?|عرفني بالمكان|عرّفني بالمكان|(?:عرفني|عرّفني) (?:على |ب)التطبيق",
    "أرني المكان|ارني المكان|أرني التطبيق|ارني التطبيق|(?:أرني|ارني) كيف يعمل التطبيق",
    "(?:(?:ابدأ|ابدا|إبدأ|أعطني|اعطني) )?(?:ال)?جولة(?: (?:التعريفية|تعريفية|سريعة|إرشادية))?|كيف يعمل (?:هذا )?التطبيق|(?:(?:أعطني|اعطني) )?(?:ال)?عرض (?:ال)?توضيحي",
    // French
    "fais-moi visiter|faites-moi visiter|(?:une |la )?visite guidée|(?:fais|faites)-moi (?:faire )?(?:le|un) tour(?: de l'app(?:lication)?)?",
    "montre-moi (?:l'app(?:lication)?|comment (?:ça|l'app(?:lication)?) (?:marche|fonctionne))|comment (?:fonctionne|marche) l'app(?:lication)?",
    "(?:lance|démarre|demarre|commence|lancez|démarrez|commencez) la visite(?: guidée)?|(?:(?:fais|faites|donne|donnez)-moi )?une démo",
    // Spanish
    "enséñame la app|ensename la app|muéstrame la app|muestrame la app|(?:dame|hazme|danos) un (?:recorrido|tour)(?: por la app)?",
    "(?:un )?recorrido(?: guiado)?(?: por la app)?|(?:empieza|comienza|inicia) el (?:recorrido|tour)|(?:dame |hazme )?una demo",
    "c[óo]mo funciona (?:la app|esta app|la aplicaci[óo]n)|(?:mu[ée]strame|ens[ée]ñame|ensename) c[óo]mo funciona",
    // Portuguese
    "me mostra o app|me mostre o app|faça um tour|faca um tour|me (?:dá|da|dê|de) um tour(?: pelo app)?|um tour(?: guiado)?(?: pelo app)?",
    "(?:comece|começa|comeca|inicia|inicie) o tour|como funciona o app|me (?:mostra|mostre) como funciona",
    // Hindi
    "मुझे सब दिखाओ|मुझे सब दिखाइए|टूर दिखाओ|टूर दिखाइए|टूर शुरू (?:करो|करें|कीजिए)|(?:मुझे )?(?:ऐप|एप) (?:दिखाओ|दिखाइए|दिखाएं)",
    "मुझे घुमाओ|मुझे घुमा दो|(?:यह )?(?:ऐप|एप) कैसे काम करता है|मुझे टूर (?:दो|दीजिए|चाहिए)",
    // Marathi
    "मला सगळे दाखव|मला सगळं दाखव|टूर दाखवा|टूर दाखव|टूर सुरू (?:करा|कर)|(?:मला )?(?:ॲप|अॅप|ऍप) दाखवा|(?:हे )?(?:ॲप|अॅप|ऍप) कसे काम करते",
    // Telugu
    "నాకు అన్నీ చూపించు|నాకు అన్నీ చూపించండి|టూర్ (?:చూపించు|చూపించండి|ప్రారంభించు|ప్రారంభించండి|మొదలుపెట్టు)",
    "(?:నాకు )?యాప్ (?:చూపించు|చూపించండి)|(?:ఈ )?యాప్ ఎలా (?:పనిచేస్తుంది|పని చేస్తుంది)",
  ].join("|"),
);

/** "Show me around" (any app language): replay the first-login walkthrough.
 *  2026-10-30 (founder): also "continue / resume / start the tour" in natural
 *  phrasing ("Continue with the tour.") — with no tour running in her tab that
 *  STARTS one (no model). While a tour runs, the turn route hands the same
 *  words to the running tour first (walkCommand → resume), so this never
 *  restarts a tour that is on. The greeting / politeness frame comes off
 *  first ("Hi SK, show me around?" → "show me around"). */
export function isWalkthroughRequest(text: string): boolean {
  return WALK_TOUR_RE.test(normalizeIntent(text ?? "")) || walkStartCommand(text ?? "");
}

/** A rules decision that is only "hand it to the model" (no parent / leader read). */
function plainAsk(d: RulesDecision): boolean {
  return d.intent === "ask" && !("parent" in d) && !("leader" in d);
}

/**
 * The rules router. Every rule below is anchored, so a frame around a command
 * ("Hi SK, …", "can you …", "…, please?") used to send it to the model. Now
 * the text is routed as said and, when nothing took it, AGAIN with the frame
 * off (intent-normalize.ts) — the same anchored patterns, the same meanings.
 * A trailing "?" survives the second pass, so a question stays a question
 * (actions and book phrasings are never taken from one).
 */
export function routeByRules(text: string, ctx: SkContext, now: Date, clock?: SkCollector["clock"]): RulesDecision {
  const raw = (text ?? "").trim();
  const first = routeOnce(raw, ctx, now, clock);
  if (!plainAsk(first)) return first;
  const f = frameIntent(raw);
  if (!f.framed || !f.text) return first;
  const second = routeOnce(f.question ? `${f.text}?` : f.text, ctx, now, clock);
  if (plainAsk(second)) return first;
  // A page move found only after the frame was removed needs an explicit move
  // verb ("open the board", "take me to the diary"): without one, "I want to
  // know about the board" stays a question instead of a jump to the Board.
  if (second.intent === "navigate" && !FRAMED_NAV_VERB_RE.test(norm(f.text))) return first;
  return second;
}

/** The move verbs a FRAMED message must keep for the second pass to navigate. */
const FRAMED_NAV_VERB_RE =
  /^(?:open|go to|go|goto|take me to|take me|bring me to|bring up|show me|navigate to|switch to|jump to|head to|buka|pergi ke|bawa saya ke|tunjukkan|افتح|اذهب إلى|خذني إلى|ouvre|ouvrir|va à|aller à|abre|abrir|ir a|ir para|vai para|खोलो|खोलें|ले चलो|उघडा|తెరువు)\b/u;

function routeOnce(text: string, ctx: SkContext, now: Date, clock?: SkCollector["clock"]): RulesDecision {
  const raw = (text ?? "").trim();
  const t = norm(raw);
  if (!t) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };
  if (THANKS_RE.test(t)) return { intent: "chat", reply: SK_CHAT_THANKS };
  if (ACK_RE.test(t)) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };

  // S4 slice D: a book code (or the answer SK asked for) is decided here for
  // every role, before anything that could hand the text to a model.
  const book = bookActivateOf(raw, t, ctx);
  if (book) return { intent: "act", action: "book.activate", book };

  // 2026-10-30: an answer-language command, for every role, before anything
  // that could read "explain that again in English" as a Board or tutor move.
  const lang = parseLanguageCommand(raw);
  if (lang) return { intent: "lang", command: lang };

  // 2026-10-30: "Show me around" replays the walkthrough (the client runs it).
  if (isWalkthroughRequest(raw)) return { intent: "tour" };

  // S3 slice D: a student's tutor phrasings come first, and a student never
  // reaches the Board, start-a-lesson or teacher-action rules below.
  const student = ctx.user.role === "student";
  if (student) {
    const tu = routeTutor(raw, t, ctx);
    if (tu) return tu;
  } else if (ctx.board?.sessionId) {
    // S1: with a Board session open, the Board phrasings come first; without
    // one the S0 rules apply unchanged ("open the board" → navigate).
    const b = routeBoard(raw, t, ctx);
    if (b) return b;
  } else {
    // No session: "start the lesson / the video" is a navigate-and-start; the
    // other Board phrasings on the Board page itself ("pause", "slide 4") are
    // still decided here, so the route answers with its fixed line and no
    // model narrates a Board that is not running.
    const sl = startLessonOf(t, raw);
    if (sl) return { intent: "navigate", target: "board", filters: { autostart: true }, ...(sl.classQuery ? { classQuery: sl.classQuery } : {}), ...(sl.kitQuery ? { kitQuery: sl.kitQuery } : {}) };
    if (ctx.place.page === "board") {
      const b = routeBoard(raw, t, ctx);
      if (b) return b;
    }
  }

  // S4: a parent asking about a child ("how is Aisyah doing", "Aisyah's
  // week", "bagaimana anak saya", "كيف حال ابني") — parents only.
  const parent = routeParent(raw, ctx);
  if (parent) return { intent: "ask", parent };

  // S5: a principal / coordinator (by HAT) asking about the school or their
  // scope ("how is the school doing", "siapa berisiko dalam tahun 5").
  const leader = student ? null : routeLeader(raw, ctx);
  if (leader) return { intent: "ask", leader };

  // S2: a teacher action phrasing is never a navigate (the model resolves it).
  const act = student ? null : actPhraseOf(t, raw);
  if (act) return { intent: "act", action: act };

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
    // A student names no class or learner: her navigate is her own pages.
    if (CLASS_TARGETS.has(target) && !student) {
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
    if (target === "reports" && !student) {
      const who = raw.match(LEARNER_RE_I)?.[1]?.trim();
      if (who) learnerQuery = who.replace(/['’]s$/u, "").slice(0, 60);
      else if (ctx.selection.learnerId) filters.learnerId = ctx.selection.learnerId;
    }
    return { intent: "navigate", target, filters, ...(classQuery ? { classQuery } : {}), ...(learnerQuery ? { learnerQuery } : {}) };
  }

  return { intent: "ask" };
}

export { NAV_TARGETS };
export type { ParentRoute, SkParentCapability } from "./parent-rules";
export type { LeaderRoute, SkLeaderCapability } from "./leader-rules";

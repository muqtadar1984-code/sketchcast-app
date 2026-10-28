// SK Shell — the deterministic rules router (Final Plan §2.1 router, S0 cut).
//
// S0 ships no model-based router: navigation and bare acknowledgements are
// decided here, by rules, with no model call (acceptance: a navigate lands
// within 2 s); everything else is handed to the teacher model with intent
// "ask". The Haiku router of §2.1 arrives with the teaching moves (S1/S2).
// Pure: text + context + clock in, decision out.

import type { SkBoardMove, SkCollector, SkContext, SkIntent } from "./types";
import { NAV_TARGETS, type NavFilters, type NavTarget } from "@/sk/capabilities/navigate";

export type RulesDecision =
  | { intent: "navigate"; target: NavTarget; filters: NavFilters; classQuery?: string; learnerQuery?: string; kitQuery?: string }
  | { intent: "chat"; reply: string }
  /** S1: a Board move decided by rules (only while the collector reports an
   *  open Board session). `args` are the capability's arguments; `k` is 0-based. */
  | { intent: "teach"; move: SkBoardMove; args: Record<string, unknown> }
  | { intent: Exclude<SkIntent, "navigate" | "chat" | "teach"> };

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

export function routeByRules(text: string, ctx: SkContext, now: Date, clock?: SkCollector["clock"]): RulesDecision {
  const raw = (text ?? "").trim();
  const t = norm(raw);
  if (!t) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };
  if (THANKS_RE.test(t)) return { intent: "chat", reply: SK_CHAT_THANKS };
  if (ACK_RE.test(t)) return { intent: "chat", reply: SK_CHAT_NOTHING_PENDING };

  // S1: with a Board session open, the Board phrasings come first; without
  // one the S0 rules apply unchanged ("open the board" → navigate).
  if (ctx.board?.sessionId) {
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
      const who = raw.match(LEARNER_RE_I)?.[1]?.trim();
      if (who) learnerQuery = who.replace(/['’]s$/u, "").slice(0, 60);
      else if (ctx.selection.learnerId) filters.learnerId = ctx.selection.learnerId;
    }
    return { intent: "navigate", target, filters, ...(classQuery ? { classQuery } : {}), ...(learnerQuery ? { learnerQuery } : {}) };
  }

  return { intent: "ask" };
}

export { NAV_TARGETS };

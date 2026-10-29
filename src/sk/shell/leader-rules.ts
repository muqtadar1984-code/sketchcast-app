// SK S5 slice A — the LEADER phrasings of the rules router (English, Malay,
// Arabic). With the principal or the coordinator hat on, "how is the school
// doing", "who's at risk in grade 5", "which teachers have marking piling
// up", "what's overdue", "who is teaching now" are answered by the capability
// itself — deterministic, no model — so every number in the answer is one of
// the tool's facts. PURE: text + context in, decision out.
//
// Only for a leader hat (leader-scope.ts leaderScope ≠ "own"): a teacher's
// "who's at risk" keeps going to the model with the teacher's own tools,
// exactly as before S5.

import type { SkContext } from "./types";
import { leaderScope } from "@/sk/capabilities/leader-scope";

export type SkLeaderCapability = "school.health" | "learners.risk" | "assignments.status" | "timetable.now_next" | SkFigureCapability;
/** S5 slice C: the leader figures (school-figures.ts). */
export type SkFigureCapability = "school.seats" | "school.cost" | "school.gaps" | "school.trend";
export type LeaderRoute = { capability: SkLeaderCapability; args: Record<string, string> };

/** A grade named in the words: "grade 5", "year 5", "form 2", "tahun 5",
 *  "tingkatan 2", "darjah 5", "الصف 5". Kept as said ("form 2"): the
 *  capability matches it on the normalised level (school-books gradeLevel). */
const GRADE_RE = /(?:^|\s)((?:grade|year|form|standard|class|tahun|tingkatan|darjah|الصف|صف)\s?([0-9٠-٩]{1,2}))(?=\s|$)/u;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const westernDigits = (s: string) => s.replace(/[٠-٩]/gu, (d) => String(AR_DIGITS.indexOf(d)));

export function gradeOf(t: string): string | undefined {
  const m = t.match(GRADE_RE);
  if (!m) return undefined;
  const word = m[1].replace(/[0-9٠-٩]+$/u, "").trim();
  const n = westernDigits(m[2]);
  // "class 5" names a grade the way "grade 5" does; a class like "5b" never matches (digits then end).
  return `${word === "class" || word === "صف" || word === "الصف" ? "grade" : word} ${n}`.slice(0, 20);
}

/** Lower-cased, curly apostrophes straightened, the question mark and
 *  trailing punctuation dropped, a polite lead dropped, spaces collapsed. */
function norm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[?؟.!،,]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please |pls |sila |tolong |boleh |can you |could you |من فضلك |الرجاء )/u, "")
    .replace(/ (?:please|sila)$/u, "")
    .trim();
}

/** " in grade 5" / " dalam tahun 5" / " في الصف 5" — optional at the end. */
const IN_GRADE = "(?: (?:in|for|of|across|dalam|bagi|untuk|di|في|لـ|ل)? ?(?:grade|year|form|standard|class|tahun|tingkatan|darjah|الصف|صف) ?[0-9٠-٩]{1,2})?";
const re = (body: string) => new RegExp(`^(?:${body})${IN_GRADE}$`, "u");

const PATTERNS: Array<[SkLeaderCapability, Record<string, string>, RegExp[]]> = [
  [
    "school.health",
    { focus: "teachers" },
    [
      re("which teachers (?:have|got) (?:(?:a |their )?marking|grading) (?:piling up|backed up|backlog|overdue|to do)"),
      re("which teachers (?:are )?(?:behind|slow|late) (?:on|with) (?:their )?(?:marking|grading)"),
      re("which teachers need (?:help|support|attention)"),
      re("(?:show (?:me )?)?(?:the )?teacher (?:flags|workload|workloads)"),
      re("who (?:has|have) (?:(?:the most|a lot of) )?(?:marking|grading) (?:piling up|backlog|to do)"),
      re("teachers with (?:a )?(?:marking|grading) backlog"),
      re("guru (?:mana|yang mana) (?:yang )?(?:banyak|tertunggak|lewat) (?:kerja )?(?:menanda|tanda|penandaan|semakan)"),
      re("guru (?:mana|yang mana) (?:yang )?perlu(?:kan)? (?:bantuan|sokongan)"),
      re("(?:senarai )?guru (?:yang )?tertunggak (?:menanda|penandaan)"),
      re("beban (?:kerja )?guru"),
      re("(?:أي|اي) المعلمين (?:لديهم|عندهم) (?:تصحيح|واجبات للتصحيح) (?:متراكم|متراكمة|متأخر)"),
      re("المعلمون المتأخرون (?:في|عن) التصحيح"),
      re("(?:من|أي) (?:من )?المعلمين (?:يحتاج|يحتاجون) (?:إلى |الى )?(?:مساعدة|دعم)"),
      re("عبء عمل المعلمين"),
    ],
  ],
  [
    "school.health",
    { focus: "overview" },
    [
      re("how(?: is|'s) (?:the|our|my) school(?: doing| going| performing)?"),
      re("how are we doing(?: as a school)?"),
      re("how(?: is|'s) (?:my|our) (?:grade|scope|year group)(?: doing)?"),
      re("how(?: is|'s| are) (?:grade|year|form|standard|tahun|tingkatan) ?[0-9]{1,2}(?: doing| going)?"),
      re("(?:give me |show me )?(?:a |the )?school (?:overview|summary|briefing|health|snapshot|report)"),
      re("(?:give me |show me )?(?:a |the )?(?:school-wide|whole-school) (?:overview|summary|picture)"),
      re("(?:bagaimana|macam mana) (?:prestasi |keadaan )?sekolah(?: (?:kita|saya|ini))?"),
      re("(?:bagaimana|macam mana) (?:prestasi |keadaan )?(?:tahun|tingkatan|darjah) ?[0-9]{1,2}"),
      re("ringkasan (?:prestasi )?sekolah"),
      re("(?:prestasi|kesihatan) sekolah"),
      re("كيف (?:حال|أداء|اداء|وضع) (?:المدرسة|مدرستنا|مدرستي)"),
      re("كيف (?:حال|أداء|اداء) (?:الصف|صف) ?[0-9٠-٩]{1,2}"),
      re("(?:ملخص|نظرة عامة على) (?:أداء |اداء )?المدرسة"),
    ],
  ],
  [
    "learners.risk",
    {},
    [
      re("who(?: is|'s| are) at risk"),
      re("which (?:students|learners|pupils|kids|children) are (?:at risk|struggling|falling behind)"),
      re("(?:show (?:me )?|list )?(?:the )?at[- ]risk (?:students|learners|pupils|list)"),
      re("who(?: is|'s| are) (?:struggling|falling behind)"),
      re("any(?:one| students| learners) at risk"),
      re("siapa (?:yang )?(?:berisiko|ketinggalan)"),
      re("murid (?:mana|yang mana) (?:yang )?(?:berisiko|ketinggalan)"),
      re("(?:senarai )?murid (?:yang )?berisiko"),
      re("من (?:هم )?(?:الطلاب )?(?:المعرضون|المعرّضون) للخطر"),
      re("(?:أي|اي) الطلاب (?:في خطر|متعثرون|متأخرون)"),
      re("من (?:هم )?(?:الطلاب )?(?:المتعثرون|المتأخرون)"),
      re("(?:قائمة )?الطلاب (?:المعرضين|المعرّضين) للخطر"),
    ],
  ],
  [
    "assignments.status",
    {},
    [
      re("how are (?:the )?(?:assignments|homework|worksheets|quizzes) going"),
      re("what(?: is|'s) overdue"),
      re("(?:show (?:me )?)?(?:the )?(?:assignment|homework) (?:status|completion)"),
      re("how much (?:work|homework) is (?:done|overdue)"),
      re("(?:which|what) (?:assignments|homework) (?:are|is) overdue"),
      re("overdue (?:work|assignments|homework)"),
      re("status tugasan"),
      re("(?:tugasan|kerja rumah) (?:yang )?lewat"),
      re("(?:bagaimana|macam mana) (?:dengan )?(?:tugasan|kerja rumah)"),
      re("apa yang lewat"),
      re("ما (?:حالة|وضع) الواجبات"),
      re("(?:ما )?الواجبات المتأخرة"),
      re("كيف تسير الواجبات"),
    ],
  ],
  // S5 gate finding 2026-10-29 (p-tt-02, c-tt-03): "what's on next" read the
  // CURRENT period. The next-period phrasings come first and carry
  // when: "next"; the rest are "now" (the capability's default).
  [
    "timetable.now_next",
    { when: "next" },
    [
      re("what(?: is|'s) on next(?: period)?"),
      re("what(?: is|'s) (?:on |in )?(?:the )?next period"),
      re("what(?: is|'s) next"),
      re("what(?: lessons| classes)? (?:are|is) (?:on )?next"),
      re("who(?: is|'s) teaching next(?: period)?"),
      re("which classes are (?:on )?next"),
      re("(?:the )?next period"),
      re("(?:apa|kelas apa|pelajaran apa) (?:yang )?seterusnya"),
      re("siapa (?:yang )?mengajar (?:pada )?(?:waktu )?seterusnya"),
      re("(?:kelas|pelajaran|waktu|jadual(?: waktu)?) (?:yang )?seterusnya"),
      re("(?:apa|kelas apa) (?:pada |dalam )?waktu (?:yang )?seterusnya"),
      re("(?:ما|ماذا) (?:هي )?(?:الحصة|الحصص|الدرس|الدروس) (?:التالية|التالي|القادمة|القادم)"),
      re("من (?:يدرّس|يدرس) (?:في )?(?:الحصة )?(?:التالية|التالي|القادمة)"),
      re("(?:الحصة|الحصص|الدرس) (?:التالية|التالي|القادمة)"),
      re("(?:ما|ماذا) (?:التالي|بعد ذلك)"),
    ],
  ],
  [
    "timetable.now_next",
    {},
    [
      re("what(?: is|'s) happening (?:right )?now"),
      re("who(?: is|'s) teaching (?:right )?now"),
      re("what(?: lessons| classes)? (?:are|is) on (?:right )?now"),
      re("what(?: is|'s) on (?:right )?now"),
      re("which classes are (?:on|running|in session) (?:right )?now"),
      re("siapa (?:yang )?mengajar sekarang"),
      re("kelas apa (?:yang berjalan )?sekarang"),
      re("apa (?:yang )?berlaku sekarang"),
      re("jadual (?:waktu )?sekarang"),
      re("من (?:يدرّس|يدرس) الآن"),
      re("ما (?:الحصص|الدروس) (?:الآن|الجارية)"),
      re("ماذا يحدث الآن"),
    ],
  ],
  // ── S5 slice C: the leader figures (school-figures.ts) ─────────────────────
  [
    "school.seats",
    {},
    [
      re("how many (?:teachers and students|students and teachers|teachers|students|pupils|learners)(?: (?:do we have|have we got|are there|does the school have|are in the school|are enrolled))?"),
      re("(?:show (?:me )?)?(?:our|the|my) (?:school'?s? )?(?:licen[cs]e|subscription|plan)(?: status| details)?"),
      re("(?:show (?:me )?)?(?:our |the )?(?:school )?(?:seats|seat count|seat usage|headcount|head count)"),
      re("how many seats(?: (?:do we have|are used|have we used))?"),
      re("berapa (?:ramai |orang )?(?:guru dan (?:murid|pelajar)|(?:murid|pelajar) dan guru|guru|murid|pelajar)(?: (?:kita|yang ada|di sekolah ini|dalam sekolah))?"),
      re("(?:jumlah|bilangan) (?:guru dan (?:murid|pelajar)|guru|murid|pelajar)(?: sekolah)?"),
      re("(?:status )?lesen(?: sekolah)?(?: kita)?"),
      re("كم عدد (?:المعلمين(?: و ?الطلاب)?|الطلاب(?: و ?المعلمين)?)(?: لدينا| في المدرسة)?"),
      re("(?:ما )?(?:حالة )?(?:ترخيص|اشتراك) (?:المدرسة|مدرستنا)"),
      re("(?:عدد )?(?:المقاعد|مقاعد المدرسة)"),
    ],
  ],
  [
    "school.cost",
    {},
    [
      re("how much (?:have we|has the school|did we|do we|are we) (?:spent|spend|spending)(?: on (?:kits|generation|generating|lessons|ai))?"),
      re("what(?: is|'s) (?:our|the school'?s?) (?:generation |kit |ai )?(?:cost|costs|spend|spending)"),
      re("(?:show (?:me )?)?(?:the |our )?(?:generation|kit|ai|school) (?:cost|costs|spend|spending)"),
      re("how much do (?:our )?kits cost(?: us)?"),
      re("(?:the )?cost of (?:our )?(?:kits|generation|lessons)"),
      re("which teachers (?:spend|cost|spent) the most"),
      re("berapa (?:kos|belanja) (?:penjanaan|kit|sekolah)(?: kita)?"),
      re("(?:kos|perbelanjaan) (?:penjanaan|kit)(?: sekolah)?"),
      // S5 gate finding 2026-10-29 (p-cost-03): "kos penjanaan kit" fell through to navigate.
      re("berapa (?:banyak )?(?:kos|belanja)(?: (?:penjanaan|kit|sekolah|ai))*(?: (?:kita|sekolah|bulan ini))?"),
      re("(?:jumlah )?(?:kos|perbelanjaan|belanja) (?:penjanaan )?(?:kit|ai)(?: (?:sekolah|kita|bulan ini))?"),
      re("(?:jumlah )?(?:kos|perbelanjaan) (?:penjanaan|sekolah)(?: kit)?(?: (?:sekolah|kita|bulan ini))?"),
      re("berapa (?:banyak )?(?:yang )?(?:kita|sekolah) (?:telah )?belanja(?:kan)?(?: untuk kit)?"),
      re("كم (?:تكلفة|كلفة) (?:الحزم|الإنشاء|التوليد|المدرسة)"),
      re("(?:ما )?(?:تكلفة|تكاليف) (?:الحزم|الإنشاء|التوليد|المدرسة)"),
      re("كم (?:أنفقنا|انفقنا|أنفقت المدرسة)(?: على الحزم)?"),
      re("(?:ما |كم )?(?:ال)?(?:تكلفة|تكاليف|كلفة)(?: (?:الحزم|الإنشاء|التوليد|المدرسة|إنشاء الحزم|توليد الحزم|الذكاء الاصطناعي))?"),
      re("كم (?:كلفت|تكلّف|تكلف|كلّفت) (?:الحزم|المدرسة|إنشاء الحزم)"),
    ],
  ],
  [
    "school.gaps",
    {},
    [
      re("(?:what are |show (?:me )?)?(?:the |our )?(?:shelf|book|library) gaps"),
      re("what(?: is|'s| are) missing (?:from|on) (?:the |our )?(?:school )?shelf"),
      re("which subjects (?:have no|don't have|do not have|are missing|lack) (?:a )?books?"),
      re("(?:do we have|are there) (?:any )?gaps (?:on|in) (?:the |our )?(?:school )?shelf"),
      re("what books are we missing"),
      re("which subjects need (?:a )?(?:books?|kits)"),
      re("(?:apa )?jurang (?:dalam )?rak(?: buku)?(?: sekolah)?"),
      re("subjek (?:mana|apa) (?:yang )?(?:tiada|tak ada|tidak ada) buku"),
      re("buku apa (?:yang )?(?:tiada|kurang|belum ada)"),
      re("apa yang (?:tiada|kurang) (?:di|dalam) rak(?: buku)?(?: sekolah)?"),
      re("(?:ما )?(?:الفجوات|النواقص) في (?:الرف|رف الكتب|رف المدرسة)"),
      re("(?:أي|اي|ما) المواد (?:التي )?(?:ليس لها|بلا|بدون) (?:كتاب|كتب)"),
      re("ما (?:الكتب الناقصة|الكتب التي تنقصنا)"),
      re("ما الذي ينقص (?:الرف|رف المدرسة|رف الكتب)"),
    ],
  ],
  [
    "school.trend",
    {},
    [
      re("(?:show (?:me )?)?(?:the |our )?(?:4|four)[- ]week trend"),
      re("(?:show (?:me )?)?(?:the |our )?(?:school |submission |homework )?trends?(?: (?:for|over) the last (?:4|four) weeks)?"),
      re("how are we trending"),
      re("are we (?:improving|getting better|getting worse|slipping)"),
      re("(?:how is|how's) (?:submission|homework|work|marking) (?:trending|going over time|over the last (?:4|four) weeks)"),
      re("on[- ]time (?:rate|submissions)(?: (?:trend|over time))?"),
      re("trend (?:sekolah|4 minggu|empat minggu|penghantaran|tugasan)"),
      re("(?:adakah )?kita (?:semakin )?(?:baik|bertambah baik|merosot)"),
      re("(?:bagaimana|macam mana) (?:dengan )?trend(?: kita| sekolah)?"),
      re("(?:ما )?(?:الاتجاه|اتجاه) (?:المدرسة|الأسابيع الأربعة|آخر 4 أسابيع|التسليم|الواجبات)"),
      re("هل (?:نحن )?نتحسن"),
      re("كيف (?:يسير|هو) الاتجاه"),
    ],
  ],
];

/** The leader route for this utterance, or null (not a leader hat, or not a
 *  leader phrasing). */
export function routeLeader(raw: string, ctx: SkContext): LeaderRoute | null {
  if (leaderScope(ctx).mode === "own") return null;
  const t = norm(raw ?? "");
  if (!t) return null;
  for (const [capability, base, patterns] of PATTERNS) {
    if (!patterns.some((p) => p.test(t))) continue;
    // S5 slice C: seats are the principal's alone (decision 5) — a
    // coordinator's "how many teachers" is not routed to it.
    if (capability === "school.seats" && leaderScope(ctx).mode !== "school") return null;
    const grade = gradeOf(t);
    return { capability, args: { ...base, ...(grade ? { grade } : {}) } };
  }
  return null;
}

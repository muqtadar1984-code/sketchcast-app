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

export type SkLeaderCapability = "school.health" | "learners.risk" | "assignments.status" | "timetable.now_next";
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
      re("how (?:is|'s) (?:the|our|my) school(?: doing| going| performing)?"),
      re("how are we doing(?: as a school)?"),
      re("how (?:is|'s) (?:my|our) (?:grade|scope|year group)(?: doing)?"),
      re("how (?:is|'s|are) (?:grade|year|form|standard|tahun|tingkatan) ?[0-9]{1,2}(?: doing| going)?"),
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
  [
    "timetable.now_next",
    {},
    [
      re("what(?: is|'s) happening (?:right )?now"),
      re("who(?: is|'s) teaching (?:right )?now"),
      re("what(?: lessons| classes)? (?:are|is) on (?:right )?now"),
      re("what(?: is|'s) on (?:right )?now"),
      re("what(?: is|'s) on next(?: period)?"),
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
];

/** The leader route for this utterance, or null (not a leader hat, or not a
 *  leader phrasing). */
export function routeLeader(raw: string, ctx: SkContext): LeaderRoute | null {
  if (leaderScope(ctx).mode === "own") return null;
  const t = norm(raw ?? "");
  if (!t) return null;
  for (const [capability, base, patterns] of PATTERNS) {
    if (!patterns.some((p) => p.test(t))) continue;
    const grade = gradeOf(t);
    return { capability, args: { ...base, ...(grade ? { grade } : {}) } };
  }
  return null;
}

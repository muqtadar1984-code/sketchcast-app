// SK S4 — the PARENT phrasings of the rules router (English, Malay, Arabic).
// A parent asking about a child is answered by the child.* capability itself —
// deterministic, no model — so "how are my kids doing" with two children is
// one block per child, every time. PURE: text + context in, decision out.
//
// The child: a linked child's name found in the words wins (ctx.children
// only); otherwise the words the phrasing names ("how is Adam doing" → "Adam")
// go to the capability, whose resolveChild refuses a name that is not one of
// the parent's children; "my kids" / "anak saya" / "ابني" (or nothing) →
// every child.

import type { SkContext } from "./types";

export type SkParentCapability = "child.status" | "child.diary" | "child.notices" | "child.risk" | "child.progress" | "child.week";
export type ParentRoute = { capability: SkParentCapability; args: { child?: string } };

const W = "[\\p{L}\\p{M}][\\p{L}\\p{M}'’.-]*";
/** A name or "my kids": one to three words. */
const WHO = `(?<who>${W}(?: ${W}){0,2}?)`;
/** The same, possessive: "Aisyah's", "my kids'". */
const WHOS = `${WHO}(?:['’]s|['’])?`;

const re = (s: string) => new RegExp(`^${s}$`, "u");

const PATTERNS: Array<[SkParentCapability, RegExp[]]> = [
  [
    "child.week",
    [
      re(`(?:how (?:was|is|has been) |what about )?${WHOS} week(?: been| going| so far)?`),
      re(`(?:give me |show me )?(?:the |a )?week(?:ly)? (?:summary|digest|report|update|round-?up)(?: (?:for|on|of) ${WHO})?`),
      re(`(?:what did ${WHO} do|what happened) this week`),
      re(`this week (?:for|with) ${WHO}`),
      re(`(?:bagaimana |macam mana )?minggu (?!ini$)${WHO}`),
      re(`ringkasan (?:minggu ini|mingguan)(?: (?:untuk|bagi) ${WHO})?`),
      re(`apa (?:yang )?${WHO} buat minggu ini`),
      re(`(?:كيف كان |كيف مر )?أسبوع ${WHO}`),
      re(`ملخص (?:هذا )?الأسبوع(?: (?:لـ ?|ل)${WHO})?`),
    ],
  ],
  [
    "child.risk",
    [
      re(`(?:is|are) ${WHO} (?:at risk|struggling|falling behind|behind|doing well|on track|ok|okay|alright|all right)`),
      re(`(?:did|has) ${WHO} (?:do|done) well`),
      re(`should i (?:be )?worr(?:y|ied) about ${WHO}`),
      re(`(?:are )?any of my (?:kids|children) (?:at risk|struggling|falling behind)`),
      re(`adakah ${WHO} (?:ketinggalan|berisiko|bermasalah|baik-baik sahaja|ok)`),
      re(`perlukah saya risau tentang ${WHO}`),
      re(`هل ${WHO} (?:متأخر|متأخرة|متعثر|متعثرة|بخير|في خطر)`),
      re(`هل يعاني ${WHO}`),
      re(`هل يجب أن أقلق (?:على|بشأن) ${WHO}`),
    ],
  ],
  [
    "child.progress",
    [
      re(`what (?:has|have) ${WHO} mastered`),
      re(`what (?:is|are) ${WHO} good at`),
      re(`what (?:does|do) ${WHO} need to (?:work on|practi[sc]e|improve)`),
      re(`(?:how is |show me )?${WHOS} (?:mastery|sk progress|progress in sk|learning progress|progress)`),
      re(`apa (?:yang )?${WHO} (?:sudah |telah )?kuasai`),
      re(`(?:bagaimana )?(?:kemajuan|penguasaan) ${WHO}`),
      re(`apa yang perlu ${WHO} perbaiki`),
      re(`(?:ما الذي|ماذا) أتقن(?:ه)? ${WHO}`),
      re(`(?:كيف )?تقدم ${WHO}`),
    ],
  ],
  [
    "child.diary",
    [
      re(`(?:are there )?(?:any )?(?:new )?diary notes`),
      re(`(?:what's|what is|anything) (?:new )?in ${WHOS} diary`),
      re(`(?:are there )?(?:any )?(?:new )?(?:diary )?notes (?:for|about|on) ${WHO}`),
      re(`(?:show me |read me |read )?${WHOS} diary notes`),
      re(`what did (?:the |his |her )?teachers? (?:write|say) about ${WHO}`),
      re(`(?:ada |apa )?catatan diari(?: (?:untuk|tentang))? ${WHO}`),
      re(`apa (?:yang )?(?:ada )?dalam diari ${WHO}`),
      re(`apa (?:cikgu|guru) tulis tentang ${WHO}`),
      re(`ملاحظات يوميات ${WHO}`),
      re(`ماذا كتب المعلم عن ${WHO}`),
      re(`ما الجديد في يوميات ${WHO}`),
    ],
  ],
  [
    "child.notices",
    [
      re(`(?:are there )?(?:any )?(?:new |upcoming )?(?:school )?(?:notices|announcements)(?: from (?:the school|${WHOS} school))?`),
      re(`(?:any|what) (?:school )?(?:notices|announcements) (?:for|from) ${WHO}`),
      re(`what(?:'s| is) on the (?:school )?notice ?board`),
      re(`(?:any )?notices from ${WHOS} school`),
      re(`(?:ada |apa )?notis(?: sekolah)?(?: (?:untuk|bagi) ${WHO})?`),
      re(`(?:ada )?pengumuman sekolah`),
      re(`(?:هل (?:هناك|توجد) )?(?:إشعارات|إعلانات)(?: المدرسة)?(?: (?:لـ ?|ل)${WHO})?`),
      re(`ما (?:هي )?إشعارات مدرسة ${WHO}`),
    ],
  ],
  [
    "child.status",
    [
      re(`how(?: is|'s| are) ${WHO} doing(?: at school| in school| with (?:the |their |his |her )?(?:work|homework))?`),
      re(`how(?: is|'s) ${WHO} getting on`),
      re(`what(?:'s| is) overdue(?: for ${WHO})?`),
      re(`what (?:has|have|does|do) ${WHO} (?:got to do|have to do|need to do|need to hand in)`),
      re(`(?:show me )?${WHOS} (?:homework|assignments|schoolwork|work|scores|marks|results|grades)`),
      re(`(?:any )?(?:teacher )?feedback (?:for|on) ${WHO}`),
      re(`what (?:did|has) ${WHO} (?:score|get|got)`),
      re(`bagaimana (?:dengan )?${WHO}`),
      re(`apa khabar ${WHO}`),
      re(`(?:kerja rumah|tugasan|markah|keputusan) ${WHO}`),
      re(`apa yang lewat(?: untuk ${WHO})?`),
      re(`كيف حال ${WHO}`),
      re(`(?:واجبات|درجات|نتائج) ${WHO}`),
      re(`ما المتأخر(?: (?:لـ ?|ل|عند )${WHO})?`),
      re(`كيف (?:أداء|مستوى) ${WHO}(?: في المدرسة)?`),
    ],
  ],
];

/** Words that are not a child: these phrasings belong to someone else then. */
const NOT_A_CHILD = new Set(["i", "me", "my", "you", "your", "it", "this", "that", "the", "class", "my class", "the class", "school", "everything", "things", "saya", "anda", "kelas", "sekolah"]);

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The id of the ONE linked child whose name is in the words, else null. */
function childNamed(text: string, ctx: SkContext): string | null {
  const words = ` ${fold(text)} `;
  const hits = new Set<string>();
  for (const c of ctx.children ?? []) {
    for (const n of [c.name, c.firstName]) {
      const f = fold(n);
      if (f && f.length >= 2 && words.includes(` ${f} `)) hits.add(c.id);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

export function routeParent(raw: string, ctx: SkContext): ParentRoute | null {
  if (ctx.user.role !== "parent") return null;
  const t = raw
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[?؟!.,;:]+$/u, "")
    .replace(/\s*[,،]\s*/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  for (const [capability, res] of PATTERNS) {
    for (const r of res) {
      const m = t.match(r);
      if (!m) continue;
      const who = m.groups?.who?.trim().replace(/['’]s?$/u, "") ?? "";
      if (who && NOT_A_CHILD.has(who)) continue;
      const named = childNamed(who || t, ctx);
      if (named) return { capability, args: { child: named } };
      return { capability, args: who ? { child: who } : {} };
    }
  }
  return null;
}

// `plan.review` — a recommended learning plan, approved through SK (SK student
// Board plan 2026-10-31, phase 4). Confirm tier, teacher + parent.
//
// "any plans to approve?", "show me Aisha's plan", "approve the plan",
// "ada pelan untuk diluluskan?", "هل هناك خطط للموافقة؟".
//
// This handler RESOLVES, it never writes: it reads, through the user's own
// session (0179 RLS: teaches_student / is_parent_of), the plans waiting for
// HER approval — a school student's plan is the class teacher's (her parent
// only reads it), a home student's plan is the parent's (canDecide, the same
// rule as sk_learn_plan_decide) — and returns the oldest one (or the named
// student's) as a CONFIRM card listing its items. The write happens only in
// /api/sk/act → act-plan.ts: consume the token, then sk_learn_plan_decide()
// AS THE APPROVER, which re-checks who she is and assigns the items
// (generation_shares → My lessons / student Board) and sets SK's focus.
// Approving for the whole class, declining and editing live on the
// Analytics / My Children cards.

import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { lineFor } from "@/sk/shell/lines";
import { canDecide, type PlanItem, type PlanRow } from "@/sk/practice/plan";

type Line = Record<string, string>;

export const PLAN_NONE: Line = {
  en: "No plans are waiting for your approval.",
  ms: "Tiada pelan yang menunggu kelulusan anda.",
  "ms-arab": "تيادا ڤلن يڠ منوڠݢو کلولوسن اندا.",
  ar: "لا توجد خطط بانتظار موافقتك.",
  fr: "Aucun plan n'attend votre approbation.",
  es: "No hay planes esperando tu aprobación.",
  pt: "Não há planos à espera da sua aprovação.",
  te: "మీ ఆమోదం కోసం ఏ ప్రణాళికలూ వేచి లేవు.",
  mr: "तुमच्या मंजुरीसाठी कोणतीही योजना प्रतीक्षेत नाही.",
  hi: "आपकी स्वीकृति के लिए कोई योजना प्रतीक्षा में नहीं है।",
};
export const PLAN_CARD_TITLE: Line = {
  en: "Approve the plan for {name}?",
  ms: "Luluskan pelan untuk {name}?",
  "ms-arab": "لولوسکن ڤلن اونتوق {name}؟",
  ar: "الموافقة على خطة {name}؟",
  fr: "Approuver le plan de {name} ?",
  es: "¿Aprobar el plan de {name}?",
  pt: "Aprovar o plano de {name}?",
  te: "{name} ప్రణాళికను ఆమోదించాలా?",
  mr: "{name} ची योजना मंजूर करायची?",
  hi: "{name} की योजना स्वीकृत करें?",
};
export const PLAN_MORE: Line = {
  en: "{n} more waiting on your Analytics page.",
  ms: "{n} lagi menunggu di halaman Analitik anda.",
  "ms-arab": "{n} لاݢي منوڠݢو د هلامن اناليتيک اندا.",
  ar: "{n} خطط أخرى بانتظارك في صفحة التحليلات.",
  fr: "{n} autres attendent sur votre page Analyses.",
  es: "{n} más esperan en tu página de Análisis.",
  pt: "Mais {n} à espera na sua página de Análises.",
  te: "మరో {n} మీ విశ్లేషణల పేజీలో వేచి ఉన్నాయి.",
  mr: "आणखी {n} तुमच्या विश्लेषण पानावर प्रतीक्षेत आहेत.",
  hi: "{n} और आपके एनालिटिक्स पेज पर प्रतीक्षा में हैं।",
};
export const PLAN_APPROVED: Line = {
  en: "Approved — {name}'s plan is now in their lessons.",
  ms: "Diluluskan — pelan {name} kini dalam pelajaran mereka.",
  "ms-arab": "دلولوسکن — ڤلن {name} کيني دالم ڤلاجرن مريک.",
  ar: "تمت الموافقة — أصبحت خطة {name} الآن ضمن دروسه.",
  fr: "Approuvé — le plan de {name} fait maintenant partie de ses leçons.",
  es: "Aprobado — el plan de {name} ya está en sus lecciones.",
  pt: "Aprovado — o plano de {name} já está nas lições.",
  te: "ఆమోదించబడింది — {name} ప్రణాళిక ఇప్పుడు వారి పాఠాల్లో ఉంది.",
  mr: "मंजूर — {name} ची योजना आता त्यांच्या पाठांमध्ये आहे.",
  hi: "स्वीकृत — {name} की योजना अब उनके पाठों में है।",
};
export const PLAN_NOT_APPROVER: Line = {
  en: "Only the plan's approver can approve it — nothing was changed.",
  ms: "Hanya pelulus pelan ini boleh meluluskannya — tiada apa yang diubah.",
  "ms-arab": "هاڽ ڤلولوس ڤلن اين بوليه ملولوسکنڽ — تيادا اڤ يڠ دأوبه.",
  ar: "لا يوافق على الخطة إلا المسؤول عن ذلك — لم يتغيّر شيء.",
  fr: "Seule la personne qui approuve ce plan peut le faire — rien n'a changé.",
  es: "Solo quien aprueba este plan puede hacerlo — no se cambió nada.",
  pt: "Só quem aprova este plano o pode fazer — nada foi alterado.",
  te: "ఈ ప్రణాళికను ఆమోదించే వ్యక్తి మాత్రమే ఆమోదించగలరు — ఏదీ మారలేదు.",
  mr: "ही योजना मंजूर करणारी व्यक्तीच ती मंजूर करू शकते — काहीही बदलले नाही.",
  hi: "इस योजना को केवल उसका अनुमोदक ही स्वीकृत कर सकता है — कुछ नहीं बदला।",
};
export const PLAN_LINES: Record<string, Line> = { none: PLAN_NONE, cardTitle: PLAN_CARD_TITLE, more: PLAN_MORE, approved: PLAN_APPROVED, notApprover: PLAN_NOT_APPROVER };

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => (((r as { data?: unknown })?.data ?? []) as Row[]) || [];
const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

/** "Re-teach Pigments; Practise again: Cells; Tissues" — the item titles, in order. */
export function itemsLine(items: readonly PlanItem[]): string {
  return items
    .map((i) => i.title)
    .filter(Boolean)
    .join("; ")
    .slice(0, 400);
}

async function resolvePlanReview(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const locale = ctx.user.locale;
  const db = deps.session;
  const [plansQ, classesQ, linksQ] = await Promise.all([
    db.from("sk_learn_plans").select("*").eq("status", "pending_approval").order("created_at", { ascending: true }).limit(50),
    db.from("classes").select("id").eq("teacher_id", ctx.user.id),
    db.from("parent_links").select("child_id").eq("parent_id", ctx.user.id),
  ]);
  const viewer = {
    id: ctx.user.id,
    role: ctx.user.role,
    teachesClasses: new Set(rowsOf(classesQ).map((r) => String(r.id))),
    children: new Set(rowsOf(linksQ).map((r) => String(r.child_id))),
  };
  const mine = (rowsOf(plansQ) as unknown as PlanRow[]).filter((p) => canDecide(p, viewer));
  const none = (): SkCapabilityResult => ({ ok: true, summary: lineFor(PLAN_NONE, locale), facts: [], entities: [] });
  if (!mine.length) return none();

  const ids = [...new Set(mine.map((p) => p.student_id))];
  const names = new Map(rowsOf(await db.from("profiles").select("id, full_name, username").in("id", ids)).map((r) => [String(r.id), String(r.full_name || r.username || "").trim()] as const));
  const want = typeof args.student === "string" ? norm(args.student) : "";
  const pick = want ? mine.find((p) => norm(names.get(p.student_id)).includes(want)) : mine[0];
  if (!pick) return none();
  const name = names.get(pick.student_id) || "Student";
  const items = Array.isArray(pick.items) ? pick.items : [];
  const more = mine.length - 1;
  const title = lineFor(PLAN_CARD_TITLE, locale, { name });
  const summary = [`${title} ${itemsLine(items)}.`, pick.summary ?? "", more > 0 ? lineFor(PLAN_MORE, locale, { n: more }) : ""].filter(Boolean).join(" ").slice(0, 700);
  return {
    ok: true,
    summary,
    facts: [{ kind: "plan", plan_id: pick.id, student: name, items: itemsLine(items), waiting: mine.length }],
    entities: [{ kind: "learner", id: pick.student_id, label: name, via: "plan.review" }],
    confirm: { action: "plan.review", title, params: { plan_id: pick.id, student_name: name, items: itemsLine(items), summary: pick.summary ?? null } },
  };
}

export const planReviewAction: SkCapability = {
  meta: {
    name: "plan.review",
    description:
      "Teacher or parent: the recommended learning plans SK drafted from a student's worksheet practice that are waiting for THEIR approval (a school student's plan is approved by the class teacher; a home student's by the parent). Shows the oldest waiting plan — or the named student's — as a confirmation card with its items (re-teach ideas, extra practice, next topic); nothing is assigned until they confirm. Use for 'any plans to approve?', 'show me Aisha's plan', 'approve the plan', 'ada pelan untuk diluluskan?', 'هل هناك خطط للموافقة؟'. To decline, edit or apply to the whole class, send them to the Analytics page.",
    parameters: {
      type: "object",
      properties: { student: { type: "string", description: "The student's name, when they named one." } },
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["teacher", "parent"],
    hats: ["teacher", "parent"],
    flags: ["sk"],
  },
  handler: resolvePlanReview,
};

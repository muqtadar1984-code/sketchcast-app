// SK S5 slice E — the claimed-action guard (§8.4 gate finding 2026-10-29:
// "I have deleted Amir's record." and "Done — I've emailed all parents."
// reached the user, the first because every token in it is in the QUESTION).
//
// A sentence in the MODEL's answer that says SK performed an action — deleted,
// removed, emailed, sent, posted, assigned, graded, notified, called,
// messaged, changed, updated, activated (EN), "telah dipadam / dihantar /
// disiarkan …" (MS), "حذفت / أرسلت / نشرت / تم الإرسال …" (AR) — is dropped
// unless an action of that kind actually COMPLETED this turn (outcome
// "done"). Grounding cannot catch these: the words of a claim are usually
// the user's own ("delete Amir's record"), and the question counts as
// support for names (prompt.ts). This guard runs on the claim itself and
// ignores the support set entirely, so the question never backs a claim.
//
// In /api/sk/shell/turn nothing of act tier executes — a confirm-tier tool
// only issues a card, which completes at /api/sk/act — so the turn route
// passes no completed actions and every claim there is dropped. SK then says
// the correct thing (claimCorrection): "I can't do that from here." when no
// capability of that kind is open to the user, or the confirm-card line when
// one is (the action happens only through a card she confirms).
//
// The fixed lines live in src/i18n/messages/*.json under
// `sk.shell.actionClaim.*` too; action-claims.test.ts holds the copies equal.
// PURE: no imports beyond lines.ts.

import { lineFor } from "./lines";

type Line = Record<string, string>;

export const CLAIM_CANT: Line = {
  en: "I can't do that from here.",
  ms: "Saya tidak dapat melakukannya dari sini.",
  "ms-arab": "ساي تيدق داڤت ملاکوکنڽ دري سيني.",
  ar: "لا أستطيع فعل ذلك من هنا.",
  fr: "Je ne peux pas faire cela d'ici.",
  es: "No puedo hacer eso desde aquí.",
  pt: "Não consigo fazer isso a partir daqui.",
  te: "నేను ఇక్కడి నుండి అది చేయలేను.",
  mr: "मी हे इथून करू शकत नाही.",
  hi: "मैं यह यहाँ से नहीं कर सकता।",
};

export const CLAIM_CARD: Line = {
  en: "Nothing has been done yet: I can prepare it as a card, and nothing happens until you confirm it.",
  ms: "Belum ada apa-apa yang dibuat: saya boleh menyediakannya sebagai kad, dan tiada apa-apa berlaku sehingga anda mengesahkannya.",
  "ms-arab": "بلوم اد اڤ-اڤ يڠ دبوات: ساي بوليه منيدياکنڽ سباݢاي کد، دان تيادا اڤ-اڤ برلاکو سهيڠݢ اندا مڠصحکنڽ.",
  ar: "لم يُنفَّذ شيء بعد: يمكنني تجهيزه في بطاقة، ولن يحدث شيء حتى تؤكّده.",
  fr: "Rien n'a encore été fait : je peux le préparer sous forme de carte, et rien ne se passe tant que vous ne l'avez pas confirmée.",
  es: "Todavía no se ha hecho nada: puedo prepararlo como una tarjeta, y no pasa nada hasta que la confirmes.",
  pt: "Ainda não foi feito nada: posso prepará-lo num cartão, e nada acontece até o confirmar.",
  te: "ఇంకా ఏమీ చేయలేదు: నేను దాన్ని ఒక కార్డుగా సిద్ధం చేయగలను, మీరు నిర్ధారించే వరకు ఏమీ జరగదు.",
  mr: "अजून काहीही केलेले नाही: मी ते एका कार्डच्या रूपात तयार करू शकतो, आणि तुम्ही पुष्टी करेपर्यंत काहीही होत नाही.",
  hi: "अभी कुछ नहीं किया गया है: मैं इसे एक कार्ड के रूप में तैयार कर सकता हूँ, और आपके पुष्टि करने तक कुछ नहीं होगा।",
};

/** Every line, keyed by its `sk.shell.actionClaim.*` dictionary key (the test walks this). */
export const ACTION_CLAIM_LINES: Record<string, Line> = { cant: CLAIM_CANT, card: CLAIM_CARD };

export type ClaimKind = "send" | "delete" | "change" | "assign" | "grade" | "activate";

/** The capabilities through which an action of each kind can really happen
 *  (each one a confirm-tier card). Delete and change have none. */
export const CLAIM_CAPABILITIES: Record<ClaimKind, string[]> = {
  send: ["notice.school", "parents.remind", "diary.note"],
  assign: ["assign"],
  grade: ["marking.grade"],
  activate: ["book.activate"],
  delete: [],
  change: [],
};

/** An action that ran to the end in this turn (the act route's outcome). */
export type CompletedAction = { action: string; outcome: string };

// ── The claim detectors ──────────────────────────────────────────────────────

const EN_VERBS: Array<[ClaimKind, string]> = [
  ["send", "sent|emailed|e-mailed|posted|published|notified|called|phoned|rang|messaged|texted|reminded|informed|contacted|forwarded"],
  ["delete", "deleted|removed|erased|cancell?ed|wiped"],
  ["change", "changed|updated|edited|modified|amended"],
  ["assign", "assigned"],
  ["grade", "graded|marked"],
  ["activate", "activated|unlocked|enabled|redeemed"],
];
const EN_ALL = EN_VERBS.map(([, v]) => v).join("|");
const EN_ADV = "(?:(?:just|now|already|also|successfully|gone ahead and|went ahead and)\\s+)*";
/** "I deleted", "I've sent", "SK has posted". Not "we": a leader's "we have
 *  posted 3 notices" is the school's own record read back, not SK's act. */
const EN_AGENT_RE = new RegExp(`\\b(?:i|sk)(?:'ve|’ve|'d|’d|\\s+have|\\s+has|\\s+had)?\\s+${EN_ADV}(${EN_ALL})\\b`, "iu");
/** "has been sent", "have now been removed". */
const EN_PERFECT_RE = new RegExp(`\\b(?:has|have|had)\\s+${EN_ADV}been\\s+${EN_ADV}(${EN_ALL})\\b`, "iu");
/** "is now posted", "were successfully sent" (an adverb makes it a report of SK's act, not a fact read back). */
const EN_NOW_RE = new RegExp(`\\b(?:is|are|was|were)\\s+(?:(?:now|just|already|successfully)\\s+)+(${EN_ALL})\\b`, "iu");
/** A sentence that opens with the deed: "Sent!", "Done — emailed all parents.", "Deleted." */
const EN_LEAD_RE = /^(?:(?:all\s+)?done[\s,.!:;—–-]*)?(?:(?:just|now|successfully)\s+)?(sent|emailed|e-mailed|posted|published|notified|messaged|texted|deleted|removed|activated)\b(?!\s+(?:by|to\s+be|for\s+you\s+to))/iu;
/** A negated or conditional sentence is not a claim: "Nothing has been sent", "it is posted once you confirm". */
const EN_NEG_RE = /\b(?:not|never|nothing|no one|nobody|none|until|unless|once|if|will|won't|would|can't|cannot|could)\b|n['’]t\b/iu;

const MS_VERBS: Array<[ClaimKind, string]> = [
  ["send", "dihantar|menghantar|hantar|diemel|mengemel|emel|di-e-mel|dimesej|mesej|dimaklumkan|memaklumkan|maklumkan|dihubungi|menghubungi|ditelefon|menelefon|disiarkan|menyiarkan|disiar|siarkan|diingatkan|mengingatkan"],
  ["delete", "dipadam|dipadamkan|memadam|memadamkan|padam|dibuang|membuang|dihapuskan|menghapuskan|dihapus|menghapus|dibatalkan|membatalkan"],
  ["change", "diubah|mengubah|ditukar|menukar|dikemas\\s?kini|mengemas\\s?kini|kemas\\s?kini|dikemaskini|mengemaskini"],
  ["assign", "ditugaskan|menugaskan|diberikan tugasan|memberi tugasan|ditetapkan|menetapkan"],
  ["grade", "ditanda|menanda|dinilai|menilai|digred|menggred"],
  ["activate", "diaktifkan|mengaktifkan|diaktifkannya|dibuka kunci"],
];
const MS_ALL = MS_VERBS.map(([, v]) => v).join("|");
const NOT_L = "(?<![\\p{L}\\p{M}])";
const END_L = "(?![\\p{L}\\p{M}])";
/** "telah dihantar", "sudah saya padam", "baru sahaja menyiarkan". */
const MS_RE = new RegExp(`${NOT_L}(?:telah|sudah|dah|baru\\s+sahaja|baru\\s+saja|siap)\\s+(?:(?:berjaya|pun|saya|kami)\\s+)*(${MS_ALL})(?:nya|kan)?${END_L}`, "iu");
const MS_NEG_RE = new RegExp(`${NOT_L}(?:belum|tidak|tiada|tak|bukan|sehingga|hingga|jika|kalau|akan|selepas)${END_L}`, "iu");

const AR_VERBS: Array<[ClaimKind, string]> = [
  ["send", "أرسلت|ارسلت|أرسلنا|ارسلنا|بعثت|نشرت|نشرنا|أبلغت|ابلغت|أبلغنا|أخطرت|راسلت|اتصلت|أعلنت|ذكّرت"],
  ["delete", "حذفت|حذفنا|أزلت|ازلت|أزلنا|ألغيت|الغيت|مسحت"],
  ["change", "غيّرت|غيرت|غيّرنا|عدّلت|حدّثت|حدّثنا"],
  ["assign", "عيّنت|عينت|أسندت|اسندت|كلّفت"],
  ["grade", "صحّحت|صححت|قيّمت|رصدت"],
  ["activate", "فعّلت|فعّلنا"],
];
const AR_NOUNS: Array<[ClaimKind, string]> = [
  ["send", "إرسال|ارسال|نشر|إبلاغ|ابلاغ|إخطار|إعلام|الاتصال|اتصال|تذكير"],
  ["delete", "حذف|إزالة|ازالة|إلغاء|الغاء|مسح"],
  ["change", "تغيير|تعديل|تحديث"],
  ["assign", "تعيين|إسناد|اسناد|تكليف"],
  ["grade", "تصحيح|تقييم|رصد"],
  ["activate", "تفعيل"],
];
const AR_VERB_ALL = AR_VERBS.map(([, v]) => v).join("|");
const AR_NOUN_ALL = AR_NOUNS.map(([, v]) => v).join("|");
/** "لقد حذفت سجله", "أرسلتُ الإشعار", "وأرسلنا". */
const AR_VERB_RE = new RegExp(`${NOT_L}(?:(?:لقد|وقد|قد)\\s+)?[وف]?(${AR_VERB_ALL})[\\u064B-\\u0652]*(?:ها|هم|هن|ه|كم|ك)?${END_L}`, "u");
/** "تم إرسال …", "تمّ الحذف", "قمت بإرسال", "قمنا بالنشر". */
const AR_NOUN_RE = new RegExp(`${NOT_L}(?:(?:لقد|وقد|قد)\\s+)?(?:تم|تمّ|تمت|قمت\\s+ب|قمنا\\s+ب)\\s*(?:ال)?(${AR_NOUN_ALL})${END_L}`, "u");
const AR_NEG_RE = new RegExp(`${NOT_L}(?:لم|لن|لا|حتى|عندما|إذا|اذا|بعد\\s+أن)${END_L}`, "u");

function kindFor(table: Array<[ClaimKind, string]>, word: string): ClaimKind {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  for (const [kind, alts] of table) if (new RegExp(`^(?:${alts})$`, "iu").test(w)) return kind;
  return "change";
}

/** The kinds of action this ONE sentence claims SK performed (empty when none). */
export function claimKinds(sentence: string): ClaimKind[] {
  const s = sentence.trim();
  const kinds = new Set<ClaimKind>();
  const en = s.match(EN_AGENT_RE);
  if (en) kinds.add(kindFor(EN_VERBS, en[1]));
  if (!EN_NEG_RE.test(s)) {
    for (const re of [EN_PERFECT_RE, EN_NOW_RE, EN_LEAD_RE]) {
      const m = s.match(re);
      if (m) kinds.add(kindFor(EN_VERBS, m[1]));
    }
  }
  if (!MS_NEG_RE.test(s)) {
    const m = s.match(MS_RE);
    if (m) kinds.add(kindFor(MS_VERBS, m[1]));
  }
  if (!AR_NEG_RE.test(s)) {
    const v = s.match(AR_VERB_RE);
    if (v) kinds.add(kindFor(AR_VERBS, v[1]));
    const n = s.match(AR_NOUN_RE);
    if (n) kinds.add(kindFor(AR_NOUNS, n[1]));
  }
  return [...kinds];
}

/** Does any sentence of `text` claim an action? */
export function claimsAnAction(text: string): boolean {
  return sentencesOf(text).some((s) => claimKinds(s).length > 0);
}

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?؟])\s+/u)
    .filter(Boolean);
}

export type ClaimVerdict = {
  /** The sentences that claim nothing unbacked, in order. */
  text: string;
  /** The sentences dropped (logged server-side only). */
  dropped: string[];
  /** The kinds of action those sentences claimed. */
  kinds: ClaimKind[];
};

/**
 * Drops every sentence of the model's `text` that claims SK performed an
 * action, unless an action of that kind completed this turn
 * (`completed` with outcome "done"). Ignores any support set: a claim is never
 * made true by the question's words.
 */
export function actionClaimGuard(text: string, completed: CompletedAction[] = []): ClaimVerdict {
  const done = new Set(completed.filter((c) => c.outcome === "done").map((c) => c.action));
  const backed = (k: ClaimKind) => CLAIM_CAPABILITIES[k].some((a) => done.has(a));
  const kept: string[] = [];
  const dropped: string[] = [];
  const kinds = new Set<ClaimKind>();
  for (const s of sentencesOf(text)) {
    const unbacked = claimKinds(s).filter((k) => !backed(k));
    if (unbacked.length) {
      dropped.push(s);
      unbacked.forEach((k) => kinds.add(k));
    } else kept.push(s);
  }
  return { text: kept.join(" "), dropped, kinds: [...kinds] };
}

/** What SK says instead of a dropped claim: the confirm-card line when one of
 *  the claimed kinds has a capability this user may use, else "I can't do
 *  that from here." */
export function claimCorrection(kinds: ClaimKind[], allowed: string[], locale: string | null | undefined): string {
  const open = new Set(allowed);
  const viaCard = kinds.some((k) => CLAIM_CAPABILITIES[k].some((a) => open.has(a)));
  return lineFor(viaCard ? CLAIM_CARD : CLAIM_CANT, locale);
}

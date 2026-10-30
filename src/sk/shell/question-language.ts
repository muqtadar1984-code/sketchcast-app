// SK — the language a QUESTION is written (or dictated) in (founder 2026-10-30):
//
//   "it should be as fast as the user asking a question in marathi
//    immediately gets a response in marathi"
//
// questionLanguage(text) is PURE and deterministic: no model call, no I/O, a
// few microseconds — the turn routes call it before anything else, so the
// language is decided in the same turn with no extra round trip. It returns
// an answer language only when it is CONFIDENT, and null otherwise; null
// means "keep the conversation's language" (shell/language.ts answerLanguage),
// so a wrong guess is far worse than no guess.
//
//   1. Quoted spans, code spans, URLs and e-mail addresses are dropped first:
//      "what does «bonjour» mean" is an English question.
//   2. SCRIPT decides when a supported non-Latin script carries the text
//      (≥ 40% of the words, two or more words, one script only):
//        Arabic script → ar; Jawi (Malay in Arabic script) → ms-arab, by its
//          own letters (ڠ ڽ ڤ ݢ ڬ) and common Malay words written in Jawi.
//          Urdu (ے ں ٹ ڈ ڑ ھ ہ, ہے / نہیں / میں …) is NOT an SK answer
//          language: it is answered in Arabic (ar) for now — the nearest
//          language SK has in that script. Persian likewise.
//        Devanagari → mr or hi by function words (आहे / काय / मला … vs है /
//          क्या / मुझे …); a tie with no marker at all → null under three
//          words, hi from three words up.
//        Telugu → te. Han → zh (two or more characters; any kana or hangul =
//          Japanese / Korean = not SK's, null).
//   3. LATIN script: en / ms / fr / es / pt by stopword scores (plus a few
//      unambiguous letters: ñ ¿ ¡ → es; ã õ "-ção" → pt; è ù œ ë î → fr).
//      Needs three or more words, a best score of 2+, and a clear margin
//      (best ≥ 2 × second and best − second ≥ 1.5 — or, between languages
//      that share most small words, the leader has words of its own and the
//      runner-up none, "no entiendo" vs "não entendo"). Romanised Hindi / Marathi
//      ("kya", "hai", "nahi", "mujhe" …) competes as its own non-language, so
//      Hinglish comes out null — never Malay or Portuguese by accident.
//      Manglish ("boleh explain tak") falls short of the margin → null;
//      mostly-English Manglish ("can you explain this one lah") → en.
//   4. Anything else — one or two words ("ok", "next", "ya", "हो"), only
//      numbers, names or maths, a mixture of scripts — → null.

import type { SkAnswerLang } from "./language";
import { answerLangOfTranscribe } from "@/sk/speech/stt";

// ── cleaning ────────────────────────────────────────────────────────────────

/** The question with everything that is not the user's own wording removed. */
export function stripQuoted(text: string): string {
  return String(text ?? "")
    .slice(0, 2000)
    .normalize("NFC")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/«[^»]*»/g, " ")
    .replace(/„[^“”]*[“”]/g, " ")
    .replace(/「[^」]*」/g, " ")
    .replace(/『[^』]*』/g, " ")
    .replace(/\$[^$]*\$/g, " ");
}

type Script = "latin" | "arabic" | "devanagari" | "telugu" | "han" | "kana" | "hangul" | "other";

function scriptOfChar(ch: string): Script | null {
  if (/\p{Script=Latin}/u.test(ch)) return "latin";
  if (/\p{Script=Arabic}/u.test(ch)) return "arabic";
  if (/\p{Script=Devanagari}/u.test(ch)) return "devanagari";
  if (/\p{Script=Telugu}/u.test(ch)) return "telugu";
  if (/\p{Script=Han}/u.test(ch)) return "han";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) return "kana";
  if (/\p{Script=Hangul}/u.test(ch)) return "hangul";
  if (/\p{L}/u.test(ch)) return "other";
  return null; // digits, marks, punctuation, symbols
}

/** A word's script: the script of most of its letters (marks ride along). */
function scriptOfWord(w: string): Script | null {
  const n = new Map<Script, number>();
  for (const ch of w) {
    const s = scriptOfChar(ch);
    if (s) n.set(s, (n.get(s) ?? 0) + 1);
  }
  let best: Script | null = null;
  let max = 0;
  for (const [s, c] of n) if (c > max) [best, max] = [s, c];
  return best;
}

/** Words: runs of letters and combining marks (Devanagari / Telugu vowel
 *  signs are marks), with an inner apostrophe or hyphen ("c'est", "qu'est-ce"). */
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)*/gu) ?? [];
}

// ── Arabic script: Arabic, Jawi, Urdu ───────────────────────────────────────

/** Letters Jawi has and Arabic does not (nga, nya, pa, ga, the Jawi ga). */
const JAWI_LETTERS = /[ڠڽڤݢڬ]/gu;
/** Malay function words as Jawi writes them (none is an Arabic word). */
const JAWI_WORDS = new Set(["يڠ", "دالم", "اداله", "ايت", "تيدق", "ساي", "اونتوق", "دڠن", "کامي", "كامي", "اڤ", "اڤاکه", "اڤاكه", "بوليه", "کيت", "كيت", "ترڠکن", "تراڠکن", "تراڠكن", "باڬايمان", "بڬايمان", "مڠاڤ", "کنڤ", "كنڤ", "سوده", "بلوم", "اکن", "اين"]);
/** Letters Urdu has and Arabic does not. */
const URDU_LETTERS = /[ےںٹڈڑھہۓ]/gu;
const URDU_WORDS = new Set(["ہے", "ہیں", "کیا", "میں", "نہیں", "مجھے", "آپ", "اور", "کے", "کی", "کا", "کو", "سے", "یہ", "وہ", "کیسے", "کیوں"]);

function arabicScriptLanguage(words: string[], text: string): SkAnswerLang {
  const jawi = (text.match(JAWI_LETTERS)?.length ?? 0) + words.filter((w) => JAWI_WORDS.has(w)).length;
  const urdu = (text.match(URDU_LETTERS)?.length ?? 0) + words.filter((w) => URDU_WORDS.has(w)).length;
  // "اين" alone is also Arabic ("where") — Jawi needs two signs.
  if (jawi >= 2 && jawi > urdu) return "ms-arab";
  // Urdu (and Persian): not an SK answer language — Arabic, the nearest SK
  // language in the same script, until ur is added (noted in the module head).
  return "ar";
}

// ── Devanagari: Marathi or Hindi ────────────────────────────────────────────

const MARATHI = new Set([
  "आहे", "आहेत", "आहेस", "आहोत", "काय", "मला", "तुला", "तुम्ही", "तुम्हाला", "आम्ही", "आम्हाला", "आपण", "आणि", "नाही", "नाहीत", "कसे", "कसा", "कशी", "कसं", "मध्ये", "हे", "ते", "ती", "तो",
  "म्हणजे", "होते", "होता", "होती", "सांगा", "सांग", "समजावून", "कोण", "कुठे", "केव्हा", "किती", "पण", "तर", "करा", "कर", "करू", "शकता", "शकतो", "शकते", "हवे", "पाहिजे", "याचा", "याची", "याचे", "त्याचा", "त्याची", "त्याचे", "कशाला", "का",
]);
const HINDI = new Set([
  "है", "हैं", "क्या", "मुझे", "आप", "और", "नहीं", "कैसे", "में", "यह", "वह", "का", "की", "के", "को", "से", "था", "थे", "थी", "हूँ", "हूं", "कौन", "कहाँ", "कहां", "कब", "कितना", "कितने", "लेकिन", "तो",
  "बताइए", "बताओ", "बताएं", "समझाइए", "समझाओ", "करें", "कीजिए", "सकते", "सकता", "सकती", "चाहिए", "इसका", "इसकी", "इसके", "उसका", "उसकी", "उसके", "हम", "मैं", "क्यों",
]);
/** Marathi genitive endings ("प्रकाशसंश्लेषणाच्या", "पेशीचा") — Hindi has none of them. */
const MARATHI_SUFFIX = /(?:च्या|ाचा|ाची|ाचे|ांचा|ांची|ांचे)$/u;

function devanagariLanguage(words: string[]): SkAnswerLang | null {
  let mr = 0;
  let hi = 0;
  for (const w of words) {
    // "का" is Hindi "of" and Marathi "why": it counts for both, deciding nothing.
    if (MARATHI.has(w)) mr++;
    if (HINDI.has(w)) hi++;
    if (!MARATHI.has(w) && w.length > 3 && MARATHI_SUFFIX.test(w)) mr++;
  }
  if (mr > hi) return "mr";
  if (hi > mr) return "hi";
  // A tie: with no marker at all, too short to say; otherwise Hindi.
  if (mr === 0 && words.length < 3) return null;
  return "hi";
}

// ── Latin script: en / ms / fr / es / pt ────────────────────────────────────

type Latin = "en" | "ms" | "fr" | "es" | "pt" | "hinglish";

const STOP: Record<Latin, string[]> = {
  en: [
    "the", "a", "an", "is", "are", "was", "were", "what", "what's", "whats", "how", "why", "when", "where", "which", "who", "do", "does", "did", "can", "could", "would", "should", "will", "of", "to", "in", "on", "for",
    "with", "and", "or", "not", "this", "that", "these", "those", "it", "it's", "i", "i'm", "you", "me", "my", "your", "please", "explain", "tell", "about", "from", "be", "have", "has", "we", "they", "there", "if",
    "so", "but", "give", "show", "between", "difference", "mean", "means", "meaning", "work", "works", "happen", "happens", "example", "help", "understand", "don't", "doesn't", "isn't", "am",
  ],
  ms: [
    "apa", "apakah", "ini", "itu", "yang", "dan", "di", "ke", "dari", "daripada", "dengan", "untuk", "tidak", "tak", "ialah", "adalah", "bagaimana", "macam", "mana", "kenapa", "mengapa", "saya", "awak", "anda", "kamu",
    "boleh", "tolong", "terangkan", "jelaskan", "beri", "berikan", "dalam", "pada", "ada", "akan", "sudah", "dah", "belum", "lagi", "juga", "atau", "tetapi", "tapi", "kita", "kami", "mereka", "nak", "berapa", "siapa",
    "bila", "sila", "perbezaan", "maksud", "contoh", "ni", "tu", "lah", "kah", "pun", "faham", "cikgu", "bahagian", "sebab", "bagi", "kepada", "seperti", "mahu", "hendak", "ingin", "beza",
  ],
  fr: [
    "le", "la", "les", "un", "une", "des", "du", "de", "est", "sont", "que", "qui", "quoi", "comment", "pourquoi", "quand", "où", "ce", "cette", "ces", "et", "ou", "pas", "ne", "je", "tu", "il", "elle", "nous",
    "vous", "ils", "mon", "ma", "mes", "pour", "dans", "sur", "avec", "au", "aux", "c'est", "qu'est-ce", "explique", "expliquer", "expliquez", "peux", "pouvez", "s'il", "plaît", "plait", "différence", "entre",
    "quelle", "quel", "quels", "quelles", "veut", "dire", "ça", "cela", "fait", "suis",
    "comprends", "comprendre", "merci", "bonjour", "aussi", "mais", "maintenant", "bien", "exemple", "aide", "aider",
  ],
  es: [
    "el", "a", "la", "los", "las", "un", "una", "unos", "unas", "es", "son", "que", "qué", "cómo", "como", "por", "porque", "cuál", "cual", "cuándo", "dónde", "de", "del", "y", "o", "no", "en", "con", "para", "yo", "tú",
    "usted", "mi", "me", "explica", "explícame", "explicame", "puedes", "diferencia", "entre", "esto", "esta", "este", "eso", "hay", "muy", "más", "significa", "funciona", "lo", "se", "su",
    "entiendo", "entender", "puedo", "quiero", "tengo", "también", "pero", "cuando", "ahora", "bien", "gracias", "hola", "estoy", "están", "está", "favor", "ayuda", "ejemplo",
  ],
  pt: [
    "o", "a", "os", "as", "um", "uma", "é", "são", "que", "quê", "como", "por", "porque", "qual", "quando", "onde", "de", "do", "da", "dos", "das", "e", "ou", "não", "em", "no", "na", "nos", "nas", "com", "para",
    "eu", "você", "voce", "meu", "minha", "explica", "explique", "pode", "diferença", "entre", "isso", "isto", "este", "esta", "há", "muito", "mais", "significa", "funciona", "se", "seu", "sua",
    "entendo", "entender", "posso", "quero", "tenho", "também", "mas", "agora", "bem", "obrigado", "obrigada", "olá", "estou", "estão", "está", "favor", "ajuda", "exemplo", "você",
  ],
  // Romanised Hindi / Marathi: not a language SK detects in Latin script, but
  // it competes so Hinglish never scores as Malay, Portuguese or English.
  hinglish: [
    "kya", "hai", "hain", "nahi", "nahin", "mujhe", "aap", "kaise", "kyun", "kyon", "karo", "kijiye", "batao", "bataiye", "samjhao", "samjhaiye", "yeh", "woh", "matlab", "accha", "acha", "theek", "thik", "haan",
    "bhai", "mera", "meri", "tum", "ko", "se", "aur", "kaun", "kab", "kitna", "wala", "wali", "mala", "kay", "aahe", "nahi", "sang", "sanga", "kasa", "kashi", "tumhi", "ahe", "ani", "bolo", "kuch",
  ],
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)])) as unknown as Record<Latin, ReadonlySet<string>>;
const LATIN_LANGS: Latin[] = ["en", "ms", "fr", "es", "pt", "hinglish"];

function latinLanguage(words: string[], text: string): SkAnswerLang | null {
  if (words.length < 3) return null;
  const score: Record<Latin, number> = { en: 0, ms: 0, fr: 0, es: 0, pt: 0, hinglish: 0 };
  /** Evidence only one language has (its own words, its own letters). */
  const own: Record<Latin, number> = { en: 0, ms: 0, fr: 0, es: 0, pt: 0, hinglish: 0 };
  for (const w of words) {
    const hits = LATIN_LANGS.filter((l) => STOP_SETS[l].has(w));
    // A word several languages share ("de", "que", "a") is split between them.
    for (const l of hits) score[l] += 1 / hits.length;
    if (hits.length === 1) own[hits[0]!] += 1;
  }
  // Letters (and endings) only one of these languages writes.
  const lower = text.toLowerCase();
  const bonus = (l: Latin, n: number) => {
    score[l] += n;
    own[l] += n;
  };
  if (/[ñ¿¡]/u.test(lower)) bonus("es", 2);
  if (/[ãõ]/u.test(lower) || /ções?(?!\p{L})/u.test(lower)) bonus("pt", 2);
  // "é" on its own is Portuguese's "is" (French and Spanish never write it alone).
  if (words.includes("é")) bonus("pt", 1);
  if (/[èùœëî]/u.test(lower)) bonus("fr", 1.5);
  if (/ci(?:ón|ones)(?!\p{L})/u.test(lower)) bonus("es", 1);
  const ranked = LATIN_LANGS.map((l) => [l, score[l]] as const).sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0]!;
  const [runner, second] = ranked[1]!;
  if (best === "hinglish" || top < 2) return null;
  // A clear lead…
  if (top >= 2 * second && top - second >= 1.5) return best;
  // …or, between two languages that share most small words (Spanish and
  // Portuguese, French and Spanish), the leader has words of its own and the
  // runner-up has none.
  if (runner !== "hinglish" && own[best] >= 1 && own[runner] === 0 && top - second >= 0.75) return best;
  return null;
}

// ── the detector ────────────────────────────────────────────────────────────

/**
 * The language `text` is written in, when that is clear — else null.
 * Pure and deterministic; see the module head for the rules.
 */
export function questionLanguage(text: string): SkAnswerLang | null {
  const clean = stripQuoted(text);
  const words = wordsOf(clean);
  if (!words.length) return null;
  const by = new Map<Script, string[]>();
  for (const w of words) {
    const s = scriptOfWord(w);
    if (!s) continue;
    const list = by.get(s) ?? [];
    list.push(w);
    by.set(s, list);
  }
  // Japanese / Korean (and any script SK has no language for) are not SK's.
  if (by.has("kana") || by.has("hangul")) return null;
  // Han is written without spaces: count its characters as words.
  const hanChars = (by.get("han") ?? []).reduce((n, w) => n + [...w].filter((c) => /\p{Script=Han}/u.test(c)).length, 0);
  const weight = (s: Script) => (s === "han" ? hanChars : (by.get(s)?.length ?? 0));
  const total = [...by.keys()].reduce((n, s) => n + weight(s), 0);
  if (!total) return null;
  const nonLatin = (["arabic", "devanagari", "telugu", "han"] as const).map((s) => [s, weight(s)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const otherShare = weight("other") / total;
  if (otherShare >= 0.3) return null; // Tamil, Cyrillic, Thai … — not SK's

  if (nonLatin.length) {
    const [script, n] = nonLatin[0]!;
    const share = n / total;
    // Two supported non-Latin scripts in one question: mixed, no guess.
    if (nonLatin.length > 1 && nonLatin[1]![1] >= 0.3 * n) return null;
    if (share >= 0.4) {
      if (n < 2) return null; // one word ("हो", "نعم", "好") says too little
      const own = by.get(script) ?? [];
      if (script === "arabic") return arabicScriptLanguage(own, clean);
      if (script === "devanagari") return devanagariLanguage(own);
      if (script === "telugu") return "te";
      return "zh";
    }
    // A little non-Latin inside a Latin sentence: mixed, unless it is a stray word.
    if (share >= 0.2) return null;
  }
  return latinLanguage(by.get("latin") ?? [], clean);
}

/**
 * A DICTATED question: its words decide when they can; otherwise the
 * language Amazon Transcribe identified the speech as (identify-language,
 * en / ms / ar / zh — stt.ts), for three words or more. Transcribe always
 * answers with one of the options it was given, so a one-word "next" is
 * never enough to switch on.
 */
export function spokenQuestionLanguage(text: string, identified: string | null | undefined): SkAnswerLang | null {
  const byText = questionLanguage(text);
  if (byText) return byText;
  const heard = answerLangOfTranscribe(identified);
  if (!heard) return null;
  return wordsOf(stripQuoted(text)).length >= 3 ? heard : null;
}

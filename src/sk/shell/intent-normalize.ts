// SK — the ONE normaliser every no-model intent rule reads through
// (founder 2026-10-30: "SK does not show me around when i use the phrase
// 'Hi SK, show me around?'").
//
// The rules (rules.ts, language.ts, the walkthrough's commands) are ANCHORED
// on purpose: "show me around the cell" is a question, "show me around" is
// the tour. Anchors break on the frame people put around a command — a
// greeting, SK's name, "please", "can you", a trailing "?" — so the frame is
// taken off FIRST and the same anchored patterns then match the core:
//
//   "Hi SK, show me around?"          → "show me around"
//   "Hey, could you please say that in Malay, thanks!" → "say that in malay"
//   "Assalamualaikum SK, tunjukkan sekeliling" → "tunjukkan sekeliling"
//
// Only the EDGES are touched: a leading greeting / address / filler run, and
// trailing politeness and punctuation. Nothing in the middle is removed, so
// "show me around the cell membrane" stays exactly that (and stays a
// question). Pure, no imports: the client (walkthrough.ts) uses it too.

/** Greetings and addresses that can open a message, any app language (and
 *  Chinese, an answer language). Matched whole-word, case-insensitively. */
export const INTENT_GREETINGS: readonly string[] = [
  // English
  "hi", "hii", "hiii", "hello", "hello there", "hey", "hey there", "heya", "hiya", "yo", "good morning", "good afternoon", "good evening",
  "ok", "okay", "okey", "okie", "so", "um", "umm", "uh", "er", "well", "alright", "all right", "right", "oh",
  // SK itself (on its own, or with a greeting: "hi sk" is "hi" then "sk")
  "sk", "dear sk",
  // Malay (Rumi + Jawi)
  "hai", "helo", "halo", "salam", "assalamualaikum", "assalamu alaikum", "assalamu'alaikum", "assalamualaikom", "selamat pagi", "selamat petang", "selamat tengah hari", "baik", "ok la", "okla",
  "هاي", "هلو", "سلام",
  // Arabic
  "مرحبا", "مرحباً", "مرحبًا", "اهلا", "أهلا", "أهلاً", "اهلاً", "السلام عليكم", "صباح الخير", "مساء الخير", "حسنا", "حسناً", "طيب",
  // French
  "bonjour", "bonsoir", "salut", "coucou", "bon",
  // Spanish
  "hola", "buenos días", "buenos dias", "buenas", "buenas tardes", "bueno", "vale",
  // Portuguese
  "olá", "ola", "oi", "bom dia", "boa tarde", "boa noite",
  // Hindi / Marathi
  "नमस्ते", "नमस्कार", "हैलो", "हेलो", "ठीक है",
  // Telugu
  "నమస్తే", "నమస్కారం", "హాయ్", "హలో", "సరే",
  // Chinese
  "你好", "您好", "嗨",
];

/** Fillers that can open a request after (or without) a greeting. */
export const INTENT_LEAD_FILLERS: readonly string[] = [
  // English
  "please", "pls", "plz", "kindly", "can you", "could you", "would you", "will you", "can u", "could u", "would u", "will u", "can you please", "could you please", "would you please",
  "i want to", "i wanna", "i want you to", "i want", "i'd like", "id like", "i would like", "i need", "can we", "could we", "shall we", "i'd like to", "id like to", "i would like to", "i'd like you to", "i would like you to", "i need you to", "i need to",
  "let's", "lets", "let us", "let me", "now", "just", "quickly", "go ahead and",
  // Malay
  "tolong", "sila", "boleh", "boleh tak", "bolehkah", "boleh tolong", "cuba", "saya nak", "saya mahu", "saya ingin", "mari", "jom", "ثولوڠ", "سيلا", "بوليه",
  // Arabic
  "من فضلك", "لو سمحت", "رجاء", "رجاءً", "ممكن", "هل يمكنك", "أريد أن", "اريد ان", "أريد", "اريد",
  // French
  "s'il te plaît", "s'il vous plaît", "stp", "svp", "peux-tu", "pouvez-vous", "tu peux", "vous pouvez", "je veux", "je voudrais",
  // Spanish
  "por favor", "puedes", "podrías", "podrias", "quiero", "me gustaría", "me gustaria",
  // Portuguese
  "pode", "podes", "você pode", "voce pode", "quero", "gostaria de",
  // Hindi / Marathi
  "कृपया", "प्लीज़", "प्लीज", "कृपया करून", "दया करून",
  // Telugu
  "దయచేసి", "ప్లీజ్",
];

/** Politeness that can close a message. */
export const INTENT_TAIL_FILLERS: readonly string[] = [
  "please", "pls", "plz", "thanks", "thank you", "thank u", "thx", "ty", "now", "again", "for me", "sk", "if you can", "if possible", "right now", "now please",
  "tolong", "ya", "terima kasih", "sila", "sekarang",
  "من فضلك", "لو سمحت", "رجاء", "رجاءً", "شكرا", "شكراً", "الآن",
  "s'il te plaît", "s'il vous plaît", "svp", "stp", "merci", "maintenant",
  "por favor", "gracias", "ahora",
  "obrigado", "obrigada", "agora",
  "कृपया", "प्लीज़", "धन्यवाद", "अभी", "आता",
  "దయచేసి", "ధన్యవాదాలు", "ఇప్పుడు",
];

/** Chinese politeness glues on without a space ("请用中文再说一遍"). */
const CJK_LEAD = ["请你", "请", "麻烦你", "麻烦"];
const CJK_TAIL = ["吧", "好吗", "谢谢", "谢谢你"];

/** Punctuation that may sit between the frame and the core, or end a message. */
const EDGE_PUNCT = "[\\s,.!?¿¡;:،؟।…，。！？、~\\-—–]";
/** What may END a frame word: a space or punctuation, never a hyphen or an
 *  apostrophe ("well-being", "so-called" keep their first word). */
const BOUND = "[\\s,.!?¿¡;:،؟।…，。！？、~—–]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One alternation, longest first so "hey sk" never stops at "hey". */
const alt = (words: readonly string[]) =>
  [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");

// A frame word must end at a boundary: the end, or punctuation / a space —
// so "hi" never eats "hindi" and "so" never eats "sort". `\b` is ASCII-only,
// hence the explicit class (Arabic, Devanagari and Telugu words need it).
const LEAD_RE = new RegExp(`^(?:${alt([...INTENT_GREETINGS, ...INTENT_LEAD_FILLERS])})(?=${BOUND}|$)${EDGE_PUNCT}*`, "iu");
const TAIL_RE = new RegExp(`(?:^|${BOUND})(?:${alt(INTENT_TAIL_FILLERS)})${EDGE_PUNCT}*$`, "iu");
const CJK_LEAD_RE = new RegExp(`^(?:${alt(CJK_LEAD)})(?=\\p{Script=Han})`, "u");
const CJK_TAIL_RE = new RegExp(`(?<=\\p{Script=Han})(?:${alt(CJK_TAIL)})${EDGE_PUNCT}*$`, "u");
const END_PUNCT_RE = new RegExp(`${EDGE_PUNCT}+$`, "u");
const LEAD_PUNCT_RE = new RegExp(`^${EDGE_PUNCT}+`, "u");

/** Curly quotes and guillemets off, apostrophes made plain, one space between words. */
export function plainQuotes(text: string): string {
  return String(text ?? "")
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”„"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type IntentFrame = {
  /** The core, original case kept (kit titles and names are looked up by it). */
  text: string;
  /** The core, lower-cased: what the anchored patterns test. */
  lowered: string;
  /** True when a WORD of frame was taken off (a greeting, "please", "SK" …);
   *  punctuation alone does not count. */
  framed: boolean;
  /** True when the message ended in a question mark (any script). */
  question: boolean;
};

/**
 * Take the frame off a message: quotes normalised, leading greetings /
 * addresses / fillers and trailing politeness / punctuation removed (as many
 * as there are, in any order), whitespace collapsed. The middle is never
 * touched.
 */
export function frameIntent(input: string): IntentFrame {
  let s = plainQuotes(input);
  const question = /[?؟？]\s*$/u.test(s);
  let framed = false;
  for (let guard = 0; guard < 12; guard++) {
    const before = s;
    s = s.replace(LEAD_PUNCT_RE, "").replace(END_PUNCT_RE, "");
    const lead = s.replace(LEAD_RE, "");
    if (lead !== s) framed = true;
    s = lead;
    const cjk = s.replace(CJK_LEAD_RE, "");
    if (cjk !== s) framed = true;
    s = cjk;
    // Never strip a tail that IS the whole message ("thanks", "now").
    const tail = s.replace(TAIL_RE, "");
    if (tail !== s && tail.trim()) {
      framed = true;
      s = tail;
    }
    const cjkTail = s.replace(CJK_TAIL_RE, "");
    if (cjkTail !== s && cjkTail.trim()) {
      framed = true;
      s = cjkTail;
    }
    s = s.replace(/\s+/g, " ").trim();
    if (s === before) break;
  }
  return { text: s, lowered: s.toLowerCase(), framed, question };
}

/** The lower-cased core of a message (see frameIntent). */
export function normalizeIntent(text: string): string {
  return frameIntent(text).lowered;
}

/** The core with its original case (see frameIntent). */
export function stripIntentFrame(text: string): string {
  return frameIntent(text).text;
}

// ── word-level helpers (the walkthrough's loose command match) ──────────────

/** Lower-case, quotes and punctuation to spaces, one space between words. */
export function intentWords(text: string): string {
  return plainQuotes(text)
    .toLowerCase()
    .replace(/[?!.,;:।؟،…()[\]{}，。！？、]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every frame word or phrase, for a match that strips them ANYWHERE in a
 *  short command ("skip this tour please", "go to the next one, thanks"). */
export const INTENT_FILLER_WORDS: readonly string[] = [...new Set([...INTENT_GREETINGS, ...INTENT_LEAD_FILLERS, ...INTENT_TAIL_FILLERS])];

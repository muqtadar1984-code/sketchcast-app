// SK — "play chapter 1 from the book" as a RULE (no model), 2026-10-30.
//
// The founder asked SK to play chapter 1 of a book; the model looked the book
// up and could only ask a question back. The common phrasings are decided
// here and handed to the start_lesson tool (capabilities/lesson.ts), which
// resolves the book and chapter and returns the Board / Tutor deep link:
//
//   play / start / teach / open / show / run / do  chapter N | the Nth chapter
//     [part P]  [of | from | in <book>]  [for <class>]  [on the board]
//
// in the app's languages (English, Malay, Arabic, French, Spanish,
// Portuguese; Hindi, Marathi and Telugu verb-last), numbers as digits or
// words (chapter-words.ts). ANCHORED like every rule: the frame comes off
// first (intent-normalize.ts — "Hi SK, can you play chapter 1?" → "play
// chapter 1"), and then the whole core must be the command, so "what is in
// chapter 1?" and "start chapter 1 worksheet" stay with the model. Pure.

import { frameIntent } from "./intent-normalize";
import { CHAPTER_NUMBER_ALT, asciiDigits, chapterNumberOf } from "./chapter-words";

export type PlayChapter = { book?: string; chapter: number; part?: number; class?: string };

const VERBS = [
  // English
  "play", "play me", "start", "start with", "start on", "begin", "begin with", "teach", "teach me", "go with", "open", "show me", "show", "run", "do", "load", "launch", "present", "put on", "go to", "take me to", "bring up", "pull up", "jump to",
  // Malay
  "mainkan", "main", "mulakan", "mula", "ajarkan", "ajar", "bukakan", "buka", "tunjukkan saya", "tunjukkan", "tunjuk", "paparkan", "papar", "jalankan", "buat", "pergi ke",
  // Arabic
  "شغّل", "شغل", "ابدأ", "ابدا", "إبدأ", "افتح", "اعرض", "أرني", "ارني", "درّس", "درس", "علّم",
  // French
  "joue", "jouer", "lance", "lancer", "commence", "commencer", "démarre", "démarrer", "demarre", "ouvre", "ouvrir", "montre-moi", "montre", "affiche", "enseigne", "fais", "faisons", "passe",
  // Spanish
  "reproduce", "pon", "empieza", "empezar", "comienza", "comenzar", "inicia", "iniciar", "abre", "abrir", "muéstrame", "muestra", "enseña", "haz", "hagamos",
  // Portuguese
  "reproduz", "toca", "tocar", "começa", "comece", "começar", "comecar", "inicie", "abra", "mostra", "mostre", "ensina", "ensine", "faz", "faça", "vamos fazer",
];
/** Hindi, Marathi, Telugu: the verb comes last. */
const VERBS_LAST = [
  "चलाओ", "चलाइए", "चलाएं", "चलाएँ", "शुरू करो", "शुरू करें", "शुरू कीजिए", "खोलो", "खोलें", "खोलिए", "दिखाओ", "दिखाइए", "पढ़ाओ", "पढ़ाइए",
  "सुरू करा", "सुरू कर", "उघडा", "उघड", "दाखवा", "शिकवा", "चालू करा",
  "ప్రారంభించు", "ప్రారంభించండి", "తెరువు", "తెరవండి", "చూపించు", "చూపించండి", "ప్లే చేయి", "ప్లే చేయండి",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (words: readonly string[]) => [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join("|");

const CH_NOUN = "chapter|chap\\.?|ch\\.?|bab|الفصل|فصل|chapitre|cap[ií]tulo|अध्याय|धडा|प्रकरण|అధ్యాయం|పాఠం";
const NUM = `(?:${CHAPTER_NUMBER_ALT})`;
const ART = "(?:(?:the|le|la|el|o|al)\\s+)?";
/** "chapter 1", "chapter one", "bab ke-2", "bab yang pertama", "الفصل الأول" | "the first chapter", "le premier chapitre", "पहला अध्याय". */
const CHAPTER = `(?:(?:${CH_NOUN})\\s*(?:no\\.?\\s*|number\\s+|nombor\\s+|nombre\\s+|número\\s+|رقم\\s+|yang\\s+|ke-?\\s*)?(?<n1>${NUM})|(?<n2>${NUM})\\s+(?:${CH_NOUN}))`;
const PART = `(?:\\s*,?\\s*(?:part|bahagian|الجزء|جزء|partie|parte|भाग|భాగం)\\s*(?<part>${NUM}))?`;

const FRONT_RE = new RegExp(`^(?:${alt(VERBS)})\\s+${ART}${CHAPTER}${PART}(?<rest>(?:\\s.*)?)$`, "u");
const LAST_RE = new RegExp(`^(?:(?<book>.+?)\\s+(?:का|की|के|चा|ची|चे|లోని)\\s+)?${CHAPTER}${PART}\\s+(?:को\\s+|ला\\s+|ను\\s+)?(?:${alt(VERBS_LAST)})$`, "u");

/** "… on the board" / "di papan" / "على اللوحة": where, not which book. */
const WHERE_RE = /(?:^|\s)(?:on|in|onto|to|at|di|ke|على|في|sur|au|en|na|no)\s+(?:the\s+|le\s+|la\s+|el\s+|o\s+|a\s+)?(?:classroom\s+)?(?:board|whiteboard|papan(?:\s+putih)?|اللوحة|السبورة|tableau|pizarra|quadro)(?=\s|$)/u;
/** "for 7B", "untuk 5 Amanah", "pour la 6A". */
const CLASS_RE = /(?:^|\s)(?:for|with|to|untuk|dengan|kepada|bagi|pour|avec|para|com|لـ|ل|مع)\s+(?:(?:the|la|le|el|a)\s+)?(?:(?:class|kelas|year|grade|form|tingkatan|darjah|tahun|classe|clase|turma|الصف|صف|الفصل)\s+)?([0-9]{1,2}\s?[a-z؀-ۿ]{1,3})(?=\s|$)/u;
/** What introduces the book after the chapter. */
const BOOK_RE = /^(?:of|from|in|on|dari(?:pada)?|dalam|من|في|de|du|des|del|da|do|d')\s+(.+)$|^((?:buku|book|kitab|كتاب|livre|libro|livro)\s+.+)$/u;

/** The words as she typed them (case kept), found back in the original. */
function original(text: string, lowered: string): string {
  const i = text.toLowerCase().lastIndexOf(lowered);
  return (i >= 0 ? text.slice(i, i + lowered.length) : lowered).trim();
}

/** The play-a-chapter command in a message, or null when it is not one. */
export function playChapterOf(raw: string): PlayChapter | null {
  const f = frameIntent(asciiDigits(raw ?? ""));
  const t = f.lowered.replace(/\s*[,،]\s*/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(FRONT_RE) ?? t.match(LAST_RE);
  if (!m?.groups) return null;
  const g = m.groups;
  const chapter = chapterNumberOf(g.n1 ?? g.n2);
  if (chapter === null) return null;
  const out: PlayChapter = { chapter };
  const part = g.part ? chapterNumberOf(g.part) : null;
  if (part) out.part = part;

  if (g.book !== undefined) {
    // verb-last (hi/mr/te): the book came before the chapter.
    out.book = original(f.text, g.book.trim());
    return out;
  }
  let rest = (g.rest ?? "").trim();
  rest = rest.replace(WHERE_RE, " ").replace(/\s+/g, " ").trim();
  const cls = rest.match(CLASS_RE);
  if (cls) {
    out.class = cls[1].replace(/\s+/g, "").toUpperCase();
    rest = rest.replace(cls[0], " ").replace(/\s+/g, " ").trim();
  }
  rest = rest.replace(WHERE_RE, " ").replace(/\s+/g, " ").trim();
  if (!rest) return out;
  const b = rest.match(BOOK_RE);
  // Anything else after the chapter ("… worksheet", "… questions") is not this command.
  if (!b) return null;
  const book = (b[1] ?? b[2] ?? "").trim();
  if (!book) return null;
  out.book = original(f.text, book);
  return out;
}

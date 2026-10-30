// END-OF-TURN detection for dictation (founder 2026-10-30: "it feels as if the
// speech recognition is either too sharp or is incomplete").
//
// Both recognisers used to end her turn at the FIRST pause: Amazon Transcribe
// on its first final result (it emits one after any short pause), and Web
// Speech with continuous=false. A mid-sentence hesitation sent half a
// sentence. Here the turn ends only after a stretch of silence with no new
// words — longer when what she has said so far sounds unfinished (it ends on
// "and", "because", "um", a comma… or it is a couple of words with no full
// stop).
//
// PURE: the clock is injected, so the tests run with a fake one. The
// recognisers feed it "the words so far" (every final + the current partial)
// and it calls `onEndOfTurn` once. The hard cap (MAX_DICTATION_MS) and the
// no-speech timeout stay with the recognisers, unchanged.

/** Silence after her last new word that ends the turn. */
export const END_SILENCE_MS = 1_500;
/** The longer grace when the words so far sound unfinished. */
export const HESITANT_SILENCE_MS = 2_500;
/** Fewer words than this, with no terminal punctuation, is "unfinished". */
export const SHORT_UTTERANCE_WORDS = 3;

// Sentence-final marks across the app's scripts (Latin, Arabic ؟, Devanagari
// danda, CJK full-width). An ellipsis is NOT terminal: it trails off.
const TERMINAL = /[.!?؟।॥。！？]["'”’)\]]*$/u;
const TRAILING = /(?:[,;:，、；：،؛\-–—]|\.\.\.|…)["'”’)\]]*$/u;

// Hesitation sounds: unfinished wherever they come, even before a full stop
// (Transcribe writes "Um." as a sentence of its own).
const FILLERS = new Set([
  // en
  "um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "mm", "ah",
  // ms
  "em", "emm", "eh", "aa",
  // fr
  "euh", "heu", "bah", "ben",
  // es / pt
  "eh", "ehm", "este", "hum", "tipo", "né",
  // ar
  "اه", "آه", "امم", "إمم", "يعني",
  // hi / mr
  "उम्म", "अं", "हम्म", "मतलब", "म्हणजे",
  // te
  "అంటే", "ఊ",
]);

// Words a sentence does not end on: connectives, plus the articles and
// prepositions that always want a noun after them. Unfinished unless a full
// stop follows. One list for every language: dictation can identify the
// spoken language mid-session, and a false "unfinished" costs only a second.
const CONNECTIVES = new Set([
  // en
  "and", "but", "so", "because", "cause", "'cause", "or", "then", "if", "which",
  "the", "a", "an", "of", "to", "with", "for", "about", "is", "are",
  // ms
  "dan", "tapi", "tetapi", "jadi", "sebab", "kerana", "karena", "atau", "lepas", "kemudian", "yang", "untuk", "dengan", "macam",
  // fr
  "et", "mais", "donc", "parce", "car", "ou", "alors", "puis", "que", "le", "la", "les", "de", "du", "des", "un", "une",
  // es / pt
  "y", "e", "pero", "entonces", "porque", "o", "u", "pues", "el", "los", "las", "del", "mas", "então", "ou", "os", "as", "do", "da",
  // ar
  "و", "لكن", "ثم", "لأن", "أو", "او", "إذن", "اذن", "بس", "في", "من", "على",
  // hi
  "और", "लेकिन", "पर", "तो", "क्योंकि", "या", "कि", "का", "की", "के",
  // mr
  "आणि", "पण", "म्हणून", "कारण", "किंवा", "की", "तर",
  // te
  "మరియు", "కానీ", "అందుకే", "ఎందుకంటే", "లేదా", "అయితే",
]);

// Chinese has no spaces between words: these are matched as the text's end.
const CJK_TAILS = ["嗯", "呃", "额", "那个", "就是", "和", "跟", "但是", "可是", "所以", "因为", "然后", "还有", "而且", "或者", "的"];

const lastWord = (text: string): string =>
  (text.trim().split(/\s+/).pop() ?? "")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
    .toLowerCase();

/** Does the text so far sound unfinished (she is likely to go on)? */
export function soundsUnfinished(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (TRAILING.test(t)) return true;
  const word = lastWord(t);
  if (FILLERS.has(word)) return true;
  const bare = t.replace(/[\p{P}\p{S}\s]+$/gu, "");
  if (CJK_TAILS.some((w) => bare.endsWith(w))) return true;
  if (TERMINAL.test(t)) return false;
  if (CONNECTIVES.has(word)) return true;
  // A complete short reply ("yes", "next", "stop the tour") answers a card or
  // steers the tour: it ends at the normal wait, not the hesitant one.
  if (COMPLETE_SHORT.has(t.toLowerCase().replace(/[\p{P}\p{S}]+/gu, "").replace(/\s+/g, " ").trim())) return false;
  return t.split(/\s+/).length < SHORT_UTTERANCE_WORDS && !/[㐀-鿿]{4,}/u.test(t);
}

/** Short replies that are complete as they stand (all app languages). */
const COMPLETE_SHORT: ReadonlySet<string> = new Set([
  "yes", "no", "yeah", "yep", "nope", "ok", "okay", "sure", "next", "back", "stop", "pause", "skip", "continue", "cancel", "confirm", "thanks", "thank you", "go on", "next one", "go back",
  "ya", "tak", "boleh", "seterusnya", "kembali", "berhenti", "teruskan", "terima kasih",
  "نعم", "لا", "حسنا", "التالي", "توقف", "شكرا",
  "oui", "non", "suivant", "merci", "sí", "si", "siguiente", "gracias", "sim", "não", "nao", "próximo", "obrigado", "obrigada",
  "हाँ", "हां", "नहीं", "अगला", "रुको", "धन्यवाद", "होय", "नाही", "पुढे", "అవును", "కాదు", "తదుపరి",
]);

export type EndpointTimings = { silenceMs?: number; hesitantMs?: number };

/** How long to wait, after the last new word, before her turn ends. */
export function endSilenceFor(text: string, t: EndpointTimings = {}): number {
  return soundsUnfinished(text) ? (t.hesitantMs ?? HESITANT_SILENCE_MS) : (t.silenceMs ?? END_SILENCE_MS);
}

export type EndpointerOptions = EndpointTimings & {
  /** Her turn is over. Called at most once. */
  onEndOfTurn: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
};

export type Endpointer = {
  /** The words so far (every final + the current partial). New words re-arm
   *  the silence timer; the same words again (a repeated partial, a partial
   *  becoming final unchanged) do not. */
  heard(text: string): void;
  /** The last words fed in. */
  readonly text: string;
  /** Whether onEndOfTurn has fired. */
  readonly ended: boolean;
  /** Cancel (the dictation ended another way). Nothing fires afterwards. */
  cancel(): void;
};

const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

export function createEndpointer(o: EndpointerOptions): Endpointer {
  let text = "";
  let handle: unknown = null;
  let ended = false;
  let dead = false;
  const clear = () => {
    if (handle != null) o.clearTimeout(handle);
    handle = null;
  };
  return {
    heard(raw) {
      if (dead || ended) return;
      const t = norm(raw);
      if (!t || t === text) return; // nothing new: the silence clock keeps running
      text = t;
      clear();
      handle = o.setTimeout(() => {
        handle = null;
        if (dead || ended) return;
        ended = true;
        o.onEndOfTurn();
      }, endSilenceFor(t, o));
    },
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    cancel() {
      dead = true;
      clear();
    },
  };
}

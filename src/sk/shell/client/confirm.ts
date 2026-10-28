// Confirmation cards on the client (Final Plan §2.5, §9.2) — the pure rules
// the panel applies before it posts a token to /api/sk/act.
//
// A SPOKEN YES counts only when (a) exactly one card is active, (b) the mic
// was intentionally on for the utterance (push-to-talk press, or hands-free
// with its indicator on — both are the only ways a "voice" turn exists), and
// (c) the dictated text is a short affirmative in the active locale with
// nothing else in it. A short negative dismisses the card. Anything else is
// an ordinary turn. The server re-checks the token, so this gate is about
// never confirming by accident, not about security.

export type SpokenAnswer = "yes" | "no" | null;

/** Per-locale affirmatives and negatives (lower-case, no punctuation). The
 *  English set applies everywhere: "ok" and "yes" are said in every classroom. */
const YES: Record<string, string[]> = {
  en: ["yes", "yeah", "yep", "yup", "ok", "okay", "confirm", "go ahead", "do it", "sure", "please do", "yes please"],
  ms: ["ya", "baik", "boleh", "setuju", "teruskan", "ya boleh", "sahkan"],
  "ms-arab": ["يا", "باءيق", "بوليه", "ستوجو", "تروسکن", "سهکن"],
  ar: ["نعم", "أجل", "اجل", "حسنا", "حسناً", "تمام", "موافق", "أكد", "اكد", "نعم تمام"],
  fr: ["oui", "d'accord", "daccord", "ok", "confirmer", "confirme", "vas-y", "allez-y", "oui s'il vous plaît"],
  es: ["sí", "si", "vale", "de acuerdo", "confirmar", "confirma", "adelante", "claro"],
  pt: ["sim", "ok", "está bem", "esta bem", "confirmar", "confirma", "pode ser", "avança", "avance"],
  te: ["అవును", "సరే", "ఓకే", "కానివ్వు", "నిర్ధారించు"],
  mr: ["हो", "होय", "ठीक आहे", "चालेल", "पुढे जा", "निश्चित करा"],
  hi: ["हाँ", "हां", "जी", "जी हाँ", "ठीक है", "ठीक", "कर दो", "पुष्टि करें", "हां ठीक है"],
};

const NO: Record<string, string[]> = {
  en: ["no", "nope", "cancel", "stop", "don't", "dont", "no thanks", "not now", "never mind", "nevermind"],
  ms: ["tidak", "tak", "batal", "jangan", "tidak perlu", "bukan"],
  "ms-arab": ["تيدق", "تق", "باتل", "جاڠن"],
  ar: ["لا", "كلا", "إلغاء", "الغاء", "ألغ", "الغ", "توقف", "ليس الآن"],
  fr: ["non", "annuler", "annule", "pas maintenant", "stop"],
  es: ["no", "cancelar", "cancela", "ahora no", "para"],
  pt: ["não", "nao", "cancelar", "cancela", "agora não", "agora nao"],
  te: ["కాదు", "లేదు", "రద్దు", "వద్దు"],
  mr: ["नाही", "रद्द करा", "नको", "थांबा"],
  hi: ["नहीं", "नही", "रद्द", "रद्द करें", "मत करो", "अभी नहीं"],
};

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?؟।…'’"“”]+/gu, (m) => (m === "'" || m === "’" ? m : " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Three words at most: "yes, assign it to 7B for Friday" is NOT a bare yes. */
const MAX_WORDS = 3;

/** Classify a dictated utterance. `locale` is the dictionary code ("ms-arab"). */
export function spokenAnswer(text: string, locale: string | null | undefined): SpokenAnswer {
  const t = normalise(text ?? "");
  if (!t) return null;
  if (t.split(" ").length > MAX_WORDS) return null;
  const loc = (locale ?? "en").toLowerCase();
  const yes = new Set([...(YES[loc] ?? []), ...YES.en]);
  const no = new Set([...(NO[loc] ?? []), ...NO.en]);
  // A negative wins over a stray "ok" inside it ("ok, cancel").
  if (no.has(t)) return "no";
  if (yes.has(t)) return "yes";
  return null;
}

export type VoiceConfirmInput = {
  /** Cards currently shown and not expired. */
  activeCards: number;
  /** "voice" turns exist only when the user pressed the mic (push-to-talk) or
   *  turned hands-free on; a typed turn is never a spoken yes. */
  modality: "text" | "voice";
  text: string;
  locale: string | null | undefined;
};

export type VoiceConfirmDecision = { kind: "confirm" } | { kind: "dismiss" } | { kind: "turn" };

/** §9.2 (a)+(b)+(c) in one place: what the panel does with an utterance
 *  while a card is on screen. A typed "yes" is treated as a click (it is one
 *  deliberate act on the card) and reported as such by the caller. */
export function decideWithCards(input: VoiceConfirmInput): VoiceConfirmDecision {
  if (input.activeCards !== 1) return { kind: "turn" };
  const a = spokenAnswer(input.text, input.locale);
  if (a === "yes") return { kind: "confirm" };
  if (a === "no") return { kind: "dismiss" };
  return { kind: "turn" };
}

/** Whole seconds left on a card, never negative. */
export function secondsLeft(expiresAt: string, now: number): number {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

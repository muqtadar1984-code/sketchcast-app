// SK never shows tool-call markup (2026-10-31). PURE.
//
// Production 2026-10-30: the bubble showed, word for word,
//   <invoke name="board.explain_selection"> </invoke>
// The model had spent its three tool rounds; on the last pass the
// orchestrator offers no tools (so the pass must narrate), and the model,
// still wanting a tool, wrote the call out as text. Nothing between the
// model and the bubble removed it — the soft grounding check passes text
// with no names and no numbers. This strips any such pseudo-XML before a
// word is sent, spoken or stored: whole blocks (with their parameters), then
// stray opening / closing tags, then an unterminated tag cut off at the end.

/** The tags a model writes when it writes a tool call as text. */
const TAGS = "(?:antml:)?(?:function_calls|function_call|function_results|invoke|parameter|tool_use|tool_call|tool_calls|tool_result|tool_results|tool_code)";

const BLOCK_RE = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, "giu");
const TAG_RE = new RegExp(`</?${TAGS}\\b[^>]*/?>`, "giu");
const OPEN_TAIL_RE = new RegExp(`</?${TAGS}\\b[^>]*$`, "iu");

/** The text without tool-call markup; `stripped` when any was there. */
export function stripToolMarkup(text: string): { text: string; stripped: boolean } {
  const raw = text ?? "";
  let out = raw;
  // Nested blocks (<function_calls><invoke>…</invoke></function_calls>) come
  // out from the inside: repeat while a pass still removes something.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(BLOCK_RE, " ");
    if (next === out) break;
    out = next;
  }
  out = out.replace(TAG_RE, " ").replace(OPEN_TAIL_RE, " ");
  if (out === raw) return { text: raw, stripped: false };
  const tidy = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return { text: tidy, stripped: true };
}

/** SK's honest line when nothing is left of a reply once its markup is gone. */
export const COULD_NOT_DO: Record<string, string> = {
  en: "I couldn't do that just now — try again or rephrase.",
  ms: "Saya tidak dapat melakukannya sekarang — cuba lagi atau ubah ayat anda.",
  "ms-arab": "ساي تيدق داڤت ملاکوکنڽ سکارڠ — چوبا لاݢي اتاو اوبه ايات اندا.",
  ar: "لم أستطع فعل ذلك الآن — حاول مرة أخرى أو أعد الصياغة.",
  fr: "Je n'ai pas pu le faire pour l'instant — réessayez ou reformulez.",
  es: "No pude hacerlo ahora mismo; inténtalo de nuevo o dilo de otra manera.",
  pt: "Não consegui fazer isso agora — tente de novo ou diga de outra forma.",
  te: "ప్రస్తుతం అది చేయలేకపోయాను — మళ్లీ ప్రయత్నించండి లేదా వేరే మాటల్లో చెప్పండి.",
  mr: "आत्ता ते करता आले नाही — पुन्हा प्रयत्न करा किंवा वेगळ्या शब्दांत सांगा.",
  hi: "अभी मैं यह नहीं कर पाया — फिर से कोशिश करें या दूसरे शब्दों में कहें।",
};

/**
 * A reply as it may reach her: the markup gone and, when nothing is left of
 * a reply that had some, COULD_NOT_DO in her language. `warn` is told once
 * when anything was removed (the route logs it with the turn id).
 */
export function cleanReply(text: string, locale: string | null | undefined, warn?: () => void): string {
  const r = stripToolMarkup(text);
  if (!r.stripped) return text;
  warn?.();
  return r.text || (COULD_NOT_DO[(locale ?? "en").toLowerCase()] ?? COULD_NOT_DO.en);
}

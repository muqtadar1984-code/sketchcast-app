// SK gap tracker — signal D, the "phrase net" (design: Edtech/"SK - Gap
// tracker design 2026-10-31.md" §1). A cheap check of SK's FINAL reply for
// first-person "I can't / I cannot / I don't have / I'm not able to / not
// available / I'm unable" phrasing, in the app's ten UI languages (plus
// Chinese, which SK also answers in). It catches the misses signals A–C did
// not; the turn route records it only when no other signal fired that turn.
//
// CONSERVATIVE by design: first-person inability or "not available" only —
// never "you can't", never "I don't know which class" (a clarifying question
// is not a gap). A false negative costs one row; a false positive costs the
// founder's review time every week.
//
// PURE: no imports.

export type CantPhrase = { lang: string; match: string };

/** Lower-cased, NFC, curly apostrophes straightened; Arabic-script hamza and
 *  alef-maqsura forms folded and diacritics dropped, so one spelling matches. */
export function normalizeReply(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ");
}

// Latin-script patterns may use \b at an ASCII edge only (JS \b is ASCII-based
// even with the u flag); the other scripts match as substrings.
const PATTERNS: ReadonlyArray<[string, RegExp]> = [
  // English
  ["en", /\bi (?:can't|cannot|can not|couldn't|could not)\b/],
  ["en", /\bi(?:'m| am) (?:unable|not able)\b/],
  ["en", /\bi (?:don't|do not) have (?:access|any|anything|that|this|the|a way|information|enough|permission)\b/],
  ["en", /\bi have nothing on\b/],
  ["en", /\b(?:isn't|is not|aren't|are not|not) (?:yet |currently )?available\b/],
  ["en", /\b(?:that|this|it)(?:'s| is) not something i can\b/],
  // Malay (Rumi)
  ["ms", /\bsaya (?:tidak|tak|belum) (?:dapat|boleh|mampu|ada|mempunyai|menemui|jumpa|dapati)\b/],
  ["ms", /\bsaya tiada\b/],
  ["ms", /\btidak (?:tersedia|disediakan)\b/],
  // Malay (Jawi)
  ["ms-arab", /ساي (?:تيدق|تق) (?:داڤت|بوليه|مامڤو|اد|منموءي|جومڤ)/],
  ["ms-arab", /ساي تيادا?(?: |$)/],
  ["ms-arab", /تيدق ترسديا/],
  // Arabic (normalised: hamza forms → ا, ى → ي, no diacritics)
  ["ar", /(?:لا|لن) (?:استطيع|اتمكن|يمكنني|اقدر)/],
  ["ar", /لم (?:اتمكن|استطع|اجد|اعثر)/],
  ["ar", /(?:ليس لدي|لا املك|لا يتوفر لدي|لا تتوفر لدي)/],
  ["ar", /غير (?:متاح|متاحة|متوفر|متوفرة)/],
  // French
  ["fr", /\bje ne (?:peux|pourrai|parviens|trouve) pas\b/],
  ["fr", /\bje ne suis pas (?:en mesure|capable)\b/],
  ["fr", /\bje n'(?:ai pas (?:acc|d'info|de moyen|pu|trouv)|arrive pas)/],
  ["fr", /\b(?:n'est|ne sont) pas (?:encore )?disponible/],
  ["fr", /\bindisponible/],
  // Spanish
  ["es", /\bno (?:puedo|pude|he podido|soy capaz)\b/],
  ["es", /\bno tengo (?:acceso|informaci|forma|manera|datos|nada sobre)/],
  ["es", /\bno (?:he encontrado|encontré|encuentro)/],
  ["es", /\bno (?:está|es) (?:disponible|posible)/],
  ["es", /\bno están disponibles/],
  // Portuguese
  ["pt", /\bn(?:ã|a)o (?:consigo|posso|pude|sou capaz|encontrei)/],
  ["pt", /\bn(?:ã|a)o tenho (?:acesso|informa|dados|nada sobre|como)/],
  ["pt", /\bn(?:ã|a)o (?:est(?:á|a)|est(?:ã|a)o) dispon(?:í|i)ve/],
  ["pt", /\bn(?:ã|a)o me (?:é|e) poss(?:í|i)vel/],
  // Hindi
  ["hi", /(?:मैं|मुझसे)[^।.!?]{0,40}(?:नहीं कर सकत|नहीं कर पा|नहीं दे सकत|नहीं खोल सकत|नहीं बता सकत)/],
  ["hi", /मेरे पास[^।.!?]{0,30}नहीं (?:है|हैं)/],
  ["hi", /मुझे[^।.!?]{0,30}नहीं मिल/],
  ["hi", /उपलब्ध नहीं/],
  // Marathi
  ["mr", /मी[^।.!?]{0,40}शकत नाही/],
  ["mr", /माझ्याकडे[^।.!?]{0,30}नाही/],
  ["mr", /उपलब्ध नाही/],
  // Telugu
  ["te", /నేను[^.!?]{0,40}లేను/],
  ["te", /చేయలేను/],
  ["te", /నా (?:దగ్గర|వద్ద)[^.!?]{0,30}లేదు/],
  ["te", /అందుబాటులో లేదు/],
  // Chinese (SK answers in it; not a UI locale)
  ["zh", /我(?:无法|不能|做不到|找不到|没办法|没有办法|没有权限)/],
  ["zh", /(?:暂不可用|不可用|无法提供)/],
];

/** The first "I can't …" style phrase in SK's reply, or null. */
export function cantPhrase(reply: string | null | undefined): CantPhrase | null {
  const t = normalizeReply(reply ?? "");
  if (!t.trim()) return null;
  for (const [lang, re] of PATTERNS) {
    const m = re.exec(t);
    if (m) return { lang, match: m[0].trim().slice(0, 80) };
  }
  return null;
}

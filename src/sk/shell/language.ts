// SK — the language SK answers in (founder 2026-10-30).
//
//   "if i tell SK to repeat the explanation in another language it can
//    seamlessly shift to one of the other available languages"
//   "if SK has … an arabic book or article as the underlying knowledge, then
//    the language, by default to be followed should be arabic"
//
// Three things live here, all PURE (no I/O, no server imports — the panel and
// the kit player may import it):
//
//   1. The answer languages: the ten app locales plus zh (Simplified Chinese).
//      zh is an ANSWER language only — there is no zh UI locale; SK's own
//      language lines carry zh, every other fixed line falls back to English
//      (linesLocale), and the model answers in Chinese.
//   2. answerLanguage(): the one precedence rule —
//        the user's explicit override in this conversation
//        > the single language of the knowledge source the answer rests on
//        > the UI locale.
//      Mixed sources, or a source language SK cannot answer in (Tamil), fall
//      back to the UI locale.
//   3. parseLanguageCommand(): "say that in Malay" / "ulang dalam bahasa Arab"
//      / "أعد ذلك بالعربية" / "用中文再说一遍" / "en français" → repeat; "back to
//      English" / "use my language" / "kembali ke bahasa saya" → back. The
//      phrasings are anchored: "explain photosynthesis in Malay" is a new
//      question, not a repeat.

/** Every language SK can answer in. The first ten are the app's locales. */
export const SK_ANSWER_LANGS = ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "hi", "te", "mr", "zh"] as const;
export type SkAnswerLang = (typeof SK_ANSWER_LANGS)[number];

type LangInfo = {
  /** The language's name in English, for the model's instructions. */
  english: string;
  /** The language's own name, for "I can speak …". */
  own: string;
  rtl: boolean;
  /** BCP-47 tag for read-aloud and dictation (voice-client.ts SPEECH_LANG). */
  speech: string;
};

export const LANG_INFO: Readonly<Record<SkAnswerLang, LangInfo>> = {
  en: { english: "English", own: "English", rtl: false, speech: "en-US" },
  ms: { english: "Bahasa Melayu (Malay)", own: "Bahasa Melayu", rtl: false, speech: "ms-MY" },
  "ms-arab": { english: "Malay written in Jawi (the Arabic script)", own: "بهاس ملايو (جاوي)", rtl: true, speech: "ms-MY" },
  ar: { english: "Arabic", own: "العربية", rtl: true, speech: "ar-SA" },
  fr: { english: "French", own: "Français", rtl: false, speech: "fr-FR" },
  es: { english: "Spanish", own: "Español", rtl: false, speech: "es-ES" },
  pt: { english: "Portuguese", own: "Português", rtl: false, speech: "pt-BR" },
  hi: { english: "Hindi", own: "हिन्दी", rtl: false, speech: "hi-IN" },
  te: { english: "Telugu", own: "తెలుగు", rtl: false, speech: "te-IN" },
  mr: { english: "Marathi", own: "मराठी", rtl: false, speech: "mr-IN" },
  zh: { english: "Simplified Chinese (zh-CN)", own: "中文", rtl: false, speech: "zh-CN" },
};

const CODES: ReadonlySet<string> = new Set(SK_ANSWER_LANGS);

export function isAnswerLang(v: unknown): v is SkAnswerLang {
  return typeof v === "string" && CODES.has(v);
}

/** The locale the fixed (i18n) lines are looked up in: the answer language,
 *  except zh, which has no dictionary — English (SK's own language lines
 *  carry zh and are looked up with the answer language itself). */
export function linesLocale(lang: SkAnswerLang): string {
  return lang === "zh" ? "en" : lang;
}

export function languageName(lang: string | null | undefined): string {
  return isAnswerLang(lang) ? LANG_INFO[lang].english : "English";
}

export function ownName(lang: SkAnswerLang): string {
  return LANG_INFO[lang].own;
}

/** "English, Bahasa Melayu, … 中文" — the list in "I can speak …". */
export function canSpeakList(): string {
  return SK_ANSWER_LANGS.map((l) => LANG_INFO[l].own).join(", ");
}

/** What the client needs to render and voice an answer in `lang`. */
export function langMeta(lang: SkAnswerLang): { lang: SkAnswerLang; dir: "rtl" | "ltr"; speech: string } {
  return { lang, dir: LANG_INFO[lang].rtl ? "rtl" : "ltr", speech: LANG_INFO[lang].speech };
}

// ── names → codes ───────────────────────────────────────────────────────────

/** Every way a supported language is named (lower-cased): codes, English,
 *  Malay (Rumi and Jawi), Arabic, Chinese and each language's own name. The
 *  "bahasa …" / "باللغة …" / "… language" wrappers are stripped first. */
const NAMES: Record<SkAnswerLang, string[]> = {
  en: ["en", "english", "inggeris", "inggris", "الإنجليزية", "الانجليزية", "الإنكليزية", "الانكليزية", "إنجليزي", "انجليزي", "ايڠڬريس", "اڠݢريس", "اڠڬريس", "英语", "英文", "anglais", "inglés", "ingles", "inglês", "अंग्रेज़ी", "अंग्रेजी", "इंग्रजी", "ఇంగ్లీష్", "ఇంగ్లీషు", "ఆంగ్లం"],
  ms: ["ms", "malay", "melayu", "malaysia", "bm", "الملايوية", "الماليزية", "ملايو", "马来语", "马来文", "malais", "malaisien", "malayo", "malaio", "मलय", "मलयी", "మలయ్", "మలయా"],
  "ms-arab": ["ms-arab", "jawi", "malay in jawi", "melayu jawi", "jawi script", "tulisan jawi", "الجاوية", "جاوي", "جاوية", "爪夷文"],
  ar: ["ar", "arabic", "arab", "العربية", "عربي", "عربية", "عرب", "阿拉伯语", "阿拉伯文", "arabe", "árabe", "अरबी", "అరబిక్", "అరబ్బీ"],
  fr: ["fr", "french", "perancis", "الفرنسية", "فرنسي", "ڤرنچيس", "法语", "法文", "français", "francais", "francés", "frances", "francês", "फ़्रेंच", "फ्रेंच", "ఫ్రెంచ్"],
  es: ["es", "spanish", "sepanyol", "الإسبانية", "الاسبانية", "إسباني", "سڤاڽول", "西班牙语", "西班牙文", "espagnol", "español", "espanol", "espanhol", "स्पेनिश", "स्पॅनिश", "స్పానిష్"],
  pt: ["pt", "portuguese", "portugis", "البرتغالية", "برتغالي", "ڤورتوݢيس", "葡萄牙语", "葡萄牙文", "portugais", "portugués", "portugues", "português", "पुर्तगाली", "पोर्तुगीज", "పోర్చుగీస్"],
  hi: ["hi", "hindi", "الهندية", "هندي", "هيندي", "印地语", "印地文", "hindî", "हिंदी", "हिन्दी", "హిందీ"],
  te: ["te", "telugu", "التيلوغوية", "التيلجو", "التيلوجو", "تيلوݢو", "泰卢固语", "télougou", "తెలుగు", "तेलुगु", "तेलगू"],
  mr: ["mr", "marathi", "الماراثية", "مراتي", "马拉地语", "मराठी", "మరాఠీ", "మరాఠి"],
  zh: ["zh", "zh-cn", "zh-hans", "cmn", "chinese", "mandarin", "cina", "china", "الصينية", "صيني", "چينا", "中文", "汉语", "漢語", "华语", "華語", "普通话", "普通話", "中国话", "chinois", "chino", "chinês", "chines", "चीनी", "మాండరిన్", "చైనీస్"],
};

const NAME_TO_CODE: ReadonlyMap<string, SkAnswerLang> = new Map(SK_ANSWER_LANGS.flatMap((code) => NAMES[code].map((n) => [n, code] as const)));

/** Languages people ask for that SK cannot answer in. Named so "say that in
 *  Tamil" gets "I can speak …" rather than a model answer. */
const UNSUPPORTED = new Set([
  "tamil", "japanese", "jepun", "korean", "korea", "german", "jerman", "italian", "itali", "russian", "rusia", "urdu", "bengali", "bangla", "indonesian", "indonesia",
  "thai", "siam", "vietnamese", "turkish", "turki", "dutch", "belanda", "persian", "farsi", "punjabi", "gujarati", "kannada", "malayalam", "greek", "hebrew", "swahili",
  "tagalog", "filipino", "cantonese", "kantonis", "iban", "kadazan", "javanese",
  "التاميلية", "اليابانية", "الكورية", "الألمانية", "الالمانية", "الإيطالية", "الروسية", "الأردية", "التركية", "الفارسية", "الإندونيسية",
  "泰米尔语", "日语", "日文", "韩语", "德语", "意大利语", "俄语", "粤语",
]);

/** Words after "bahasa …" / "باللغة …" that describe the wording, not a language. */
const NOT_LANGUAGES = new Set(["mudah", "senang", "ringkas", "biasa", "budak", "kanak", "baku", "formal", "pasar", "harian", "البسيطة", "السهلة", "بسيطة", "سهلة", "مبسطة", "سنڠ", "موده"]);

const MINE = new Set(["saya", "my", "my own", "mine", "لغتي", "我的语言", "ma langue", "mi idioma", "minha língua", "minha lingua", "मेरी भाषा", "माझी भाषा", "నా భాష"]);

export type LangTarget = { code: SkAnswerLang } | { mine: true } | { unsupported: string };

/** A phrase that names a language → the target, or null when it names none. */
export function resolveLanguagePhrase(phrase: string): LangTarget | null {
  let s = (phrase ?? "")
    .toLowerCase()
    .replace(/[“”"'’]/g, (c) => (c === "'" || c === "’" ? c : ""))
    .replace(/[.!?؟。！？,，]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > 40) return null;
  if (MINE.has(s)) return { mine: true };
  let wrapped = false;
  const strip = (re: RegExp) => {
    const t = s.replace(re, "");
    if (t !== s) {
      s = t.trim();
      wrapped = true;
    }
  };
  strip(/^the /u);
  strip(/^(?:إلى|الى) /u);
  strip(/ language$/u);
  strip(/^langue /u);
  strip(/^(?:idioma|língua|lingua) /u);
  // Only the Malay / Arabic / Jawi wrappers make an unknown word a language
  // ("dalam bahasa Tamil"); "in simple language" names none.
  wrapped = false;
  strip(/^(?:bahasa|bhs\.?|b\.) /u);
  strip(/^باللغة /u);
  strip(/^اللغة /u);
  strip(/^بهاس /u);
  // Arabic prepositions glued to the article: "بالعربية", "للإنجليزية".
  if (/^بال/u.test(s)) s = s.slice(1);
  else if (/^لل/u.test(s)) s = `ا${s.slice(1)}`;
  if (MINE.has(s)) return { mine: true };
  const code = NAME_TO_CODE.get(s);
  if (code) return { code };
  if (UNSUPPORTED.has(s)) return { unsupported: s };
  // "bahasa Tamil", "Tamil language", "باللغة التاميلية": a language, by its wrapper.
  if (wrapped && /^[\p{L}\p{M}]{3,20}$/u.test(s) && !NOT_LANGUAGES.has(s)) return { unsupported: s };
  return null;
}

/** A stored or reported language (a code like "ar", "ms-Arab", "zh-CN", or a
 *  name like "Arabic") → an answer language, `{unsupported}` for a real
 *  language SK cannot answer in, null for nothing. */
export function normalizeLanguage(raw: unknown): SkAnswerLang | { unsupported: string } | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/_/g, "-");
  if (!s || s.length > 40) return null;
  if (CODES.has(s)) return s as SkAnswerLang;
  if (s === "ms-arab" || /^ms-arab(?:-|$)/.test(s)) return "ms-arab";
  if (/^(?:zh|cmn)(?:-|$)/.test(s)) return "zh";
  const named = NAME_TO_CODE.get(s);
  if (named) return named;
  const base = s.split("-")[0]!;
  if (/^[a-z]{2,3}$/.test(base)) return CODES.has(base) ? (base as SkAnswerLang) : { unsupported: s };
  return UNSUPPORTED.has(s) ? { unsupported: s } : null;
}

// ── the precedence ──────────────────────────────────────────────────────────

export type AnswerLanguage = {
  lang: SkAnswerLang;
  from: "override" | "source" | "ui";
  /** The single source's language when SK cannot answer in it (say so once). */
  unsupportedSource?: string;
};

/**
 * The language SK answers in:
 *   1. `override` — the user's explicit choice in this conversation;
 *   2. the ONE language of the knowledge the answer rests on (a kit, an
 *      article, a book) — mixed sources skip to 3;
 *   3. the UI locale.
 * A source language SK cannot answer in falls back to the UI locale and is
 * reported in `unsupportedSource`.
 */
export function answerLanguage(input: { override?: string | null; sourceLanguages?: ReadonlyArray<string | null | undefined>; uiLocale: string | null | undefined }): AnswerLanguage {
  const uiNorm = normalizeLanguage(input.uiLocale ?? "en");
  const ui: SkAnswerLang = typeof uiNorm === "string" ? uiNorm : "en";
  if (isAnswerLang(input.override)) return { lang: input.override, from: "override" };
  const seen = new Map<string, SkAnswerLang | { unsupported: string }>();
  for (const raw of input.sourceLanguages ?? []) {
    const n = normalizeLanguage(raw);
    if (n === null) continue;
    seen.set(typeof n === "string" ? n : `?${n.unsupported}`, n);
  }
  if (seen.size === 1) {
    const only = [...seen.values()][0]!;
    if (typeof only === "string") return { lang: only, from: "source" };
    return { lang: ui, from: "ui", unsupportedSource: only.unsupported };
  }
  return { lang: ui, from: "ui" };
}

/** "back to X": the override that leaves SK answering in X. When X is what SK
 *  would answer in anyway (source, else UI), the override is CLEARED (null);
 *  otherwise X becomes the explicit override — so "back to English" over an
 *  Arabic kit still means English. */
export function overrideForBack(target: SkAnswerLang, input: { sourceLanguages?: ReadonlyArray<string | null | undefined>; uiLocale: string | null | undefined }): SkAnswerLang | null {
  const natural = answerLanguage({ override: null, sourceLanguages: input.sourceLanguages, uiLocale: input.uiLocale });
  return natural.lang === target ? null : target;
}

/** The UI locale as an answer language (the "mine" target). */
export function uiAnswerLang(uiLocale: string | null | undefined): SkAnswerLang {
  const n = normalizeLanguage(uiLocale ?? "en");
  return typeof n === "string" ? n : "en";
}

// ── the phrasings ───────────────────────────────────────────────────────────

export type LangCommand = { kind: "repeat"; target: LangTarget } | { kind: "back"; target: LangTarget };

const LEAD_FILLERS = /^(?:(?:please|pls|can you|could you|would you|will you|hey sk|sk|okay|ok|now|tolong|boleh|cuba|sila|من فضلك|رجاء|رجاءً|ممكن|لو سمحت|s'il te plaît|s'il vous plaît|por favor|कृपया)[ ,،]+|请你|请|麻烦你|麻烦)+/u;
const TAIL_FILLERS = /(?:[ ,،]+(?:please|pls|thanks|thank you|tolong|ya|من فضلك|رجاء|رجاءً|لو سمحت|s'il te plaît|s'il vous plaît|svp|stp|por favor|कृपया|प्लीज़)|吧|好吗|谢谢)+$/u;

/** Anchored phrasings that REPEAT the last explanation in `lang`. */
const REPEAT_RES: RegExp[] = [
  // English: "say that in Malay", "explain that again in English", "in Chinese", "translate it into Arabic".
  /^(?:(?:say|repeat|explain|tell|read|give|translate|put|answer|write)(?: (?:me|us))?(?: (?:that|it|this|the explanation|the answer|your answer|what you said|that explanation|that answer|that one|this one))?(?: (?:again|once more|one more time))? )?(?:(?:and|now|again) )?(?:in|into) (.+?)(?: (?:again|too|instead|now))?$/u,
  // Malay: "ulang dalam bahasa Arab", "terangkan dalam bahasa Inggeris", "dalam bahasa Cina".
  /^(?:(?:ulang(?:i|kan)?|terang(?:kan)?|jelas(?:kan)?|cakap(?:kan)?|sebut(?:kan)?|kata(?:kan)?|terjemah(?:kan)?|baca(?:kan)?|beritahu|tulis(?:kan)?)(?: (?:itu|ini|semula|lagi|balik|sekali lagi|penerangan (?:itu|tadi)|jawapan (?:itu|tadi)))* )?(?:dalam|dlm|ke dalam|ke) (.+?)(?: (?:pula|semula|lagi))?$/u,
  // Arabic: "أعد ذلك بالعربية", "بالإنجليزية", "اشرح ذلك مرة أخرى باللغة الفرنسية".
  /^(?:(?:أعد|اعد|أعِد|كرر|كرّر|قل|قلها|قله|اشرح|إشرح|ترجم|اكتب)(?: (?:ذلك|هذا|ذاك|الشرح|الإجابة|الاجابة|كلامك|ما قلته|ما قلت))?(?: (?:مرة أخرى|مرة ثانية|مجددا|مجدداً|ثانية))? )?((?:باللغة |إلى |الى |ب)\S.*?)(?: (?:مرة أخرى|مجددا|مجدداً))?$/u,
  // Chinese: "用中文再说一遍", "用英文说", "中文".
  /^(?:你)?(?:再)?(?:用|以|说|讲)?(\p{Script=Han}{2,6}?)(?:再)?(?:说|讲|解释|重复|翻译|写)?(?:一遍|一次|一下)?$/u,
  // French / Spanish: "en français", "répète-le en anglais", "dilo en árabe".
  /^(?:(?:répète|repete|répétez|repetez|redis|redites|dis|dites|explique|expliquez|traduis|traduisez|repite|repítelo|repitelo|dilo|di|explícalo|explicalo|explica|tradúcelo|traducelo)(?:-le|-la|-moi ça|-moi cela| le| la| ça| cela| ceci| eso| esto)?(?: encore| de nouveau| otra vez| de nuevo)? )?en (.+?)$/u,
  // Portuguese: "em português", "repete isso em inglês".
  /^(?:(?:repete|repita|diz|diga|explica|explique|traduz|traduza)(?: isso| isto)?(?: outra vez| de novo)? )?em (.+?)$/u,
  // Hindi: "हिंदी में", "अंग्रेज़ी में दोहराओ", "इसे हिंदी में फिर से बताओ".
  /^(?:(?:इसे|यह|ये|इसको|वह) )?(\S+?) में(?: (?:फिर से|दोबारा))?(?: (?:दोहराओ|दोहराइए|दोहराएँ|दोहराएं|बताओ|बताइए|बताएँ|बताएं|समझाओ|समझाइए|कहो|कहिए|बोलो|बोलिए))?$/u,
  // Marathi: "मराठीत", "इंग्रजीत पुन्हा सांगा".
  /^(?:(?:हे|ते) )?(\S+?)(?:त| मध्ये)(?: पुन्हा)?(?: (?:सांग|सांगा|समजावून सांगा|बोल|बोला))?$/u,
  // Telugu: "తెలుగులో", "ఇంగ్లీష్‌లో మళ్ళీ చెప్పండి".
  /^(\S+?)‌?లో(?: (?:మళ్ళీ|మళ్లీ))?(?: (?:చెప్పు|చెప్పండి|వివరించు|వివరించండి))?$/u,
  // Jawi: "اولڠ دالم بهاس عرب", "دالم بهاس ايڠڬريس".
  /^(?:(?:اولڠ|اولڠي|اولڠکن|اولڠكن|تراڠکن|تراڠكن|جلسکن|جلسكن|چاکڤ|سبوت)(?: (?:ايت|اين|سکالي لاݢي))? )?دالم (.+?)$/u,
];

/** "back to English", "kembali ke bahasa Melayu", "عد إلى العربية", "换回中文". */
const BACK_RES: RegExp[] = [
  /^(?:(?:go|switch|change|come|move) )?back (?:to|into) (.+?)$/u,
  /^(?:use|speak|answer in|reply in|talk in|switch to|return to) (my(?: own)? language)$/u,
  /^(?:kembali|balik|tukar balik|tukar semula|tukar) (?:ke|kepada) (.+?)$/u,
  /^(?:guna(?:kan)?|cakap dalam|jawab dalam) (bahasa saya)(?: sendiri)?$/u,
  /^(?:عد|ارجع|عودة|العودة|رجوع|ارجعي|عودي) (?:إلى |الى )?(.+?)$/u,
  /^(?:استخدم|استعمل|تكلم|تحدث) ((?:ب)?لغتي)$/u,
  /^(?:换回|改回|切换回|回到|用回)(\p{Script=Han}{2,6})$/u,
  /^(?:用)(我的语言)$/u,
  /^(?:reviens|revenons|retourne|retour) (?:à l'|au |à |en )(.+?)$/u,
  /^(?:utilise|parle) (ma langue)$/u,
  /^(?:vuelve|volvamos|regresa) (?:al |a |en )(.+?)$/u,
  /^(?:usa|habla) (mi idioma)$/u,
  /^(?:volta|volte|voltemos) (?:ao |para o |para |em )(.+?)$/u,
  /^(?:usa|use|fala|fale) (?:a )?(minha l[íi]ngua)$/u,
  /^वापस (\S+?) में(?: बोलो| बोलिए)?$/u,
  /^(मेरी भाषा) में(?: बोलो| बोलिए)?$/u,
  /^(నా భాష)లో(?: మాట్లాడండి)?$/u,
];

/** Lower-cased, end punctuation off, politeness off; `polite` = a filler was there. */
function normCommand(text: string): { s: string; polite: boolean } {
  const base = (text ?? "")
    .toLowerCase()
    .replace(/[“”"«»]/g, "")
    .replace(/[?!.;:。！？؟]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const s = base.replace(LEAD_FILLERS, "").replace(TAIL_FILLERS, "").replace(/[,،]+$/u, "").trim();
  return { s, polite: s !== base };
}

/**
 * A language command, or null. Repeat phrasings re-say SK's LAST explanation
 * in the named language; back phrasings return to a language (or "mine", the
 * UI locale). An unknown language ("say that in Tamil") is `{unsupported}`.
 * Words that only LOOK like a frame but name no language ("explain that in
 * detail", "in 7B") are not commands.
 */
export function parseLanguageCommand(text: string): LangCommand | null {
  const { s, polite } = normCommand(text);
  if (!s || s.length > 80) return null;
  for (const re of BACK_RES) {
    const m = re.exec(s);
    const target = m?.[1] ? resolveLanguagePhrase(m[1]) : null;
    if (target) return { kind: "back", target };
  }
  for (const re of REPEAT_RES) {
    const m = re.exec(s);
    const target = m?.[1] ? resolveLanguagePhrase(m[1]) : null;
    if (target) return { kind: "repeat", target };
  }
  // A bare language name with "please" ("Malay please", "中文") is a repeat too.
  const bare = resolveLanguagePhrase(s);
  if (bare && "code" in bare && polite) return { kind: "repeat", target: bare };
  return null;
}

/** The target as a code (the UI locale for "mine"); null for an unsupported one. */
export function targetCode(target: LangTarget, uiLocale: string | null | undefined): SkAnswerLang | null {
  if ("code" in target) return target.code;
  if ("mine" in target) return uiAnswerLang(uiLocale);
  return null;
}

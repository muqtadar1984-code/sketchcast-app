// SK's fixed lines for the answer-language commands (founder 2026-10-30:
// "repeat that in X" and the source language default). The routes emit these
// themselves — NO model writes them. The ten app locales match
// src/i18n/messages/*.json `sk.shell.lang.*` (language-lines.test.ts holds the
// copies equal); `zh` is here too because Chinese is an ANSWER language with
// no UI dictionary (language.ts) — these four lines are the only fixed lines
// SK says in Chinese; every other fixed line falls back to English.

import { lineFor } from "./lines";
import type { SkAnswerLang } from "./language";

type Line = Record<SkAnswerLang, string>;

export const LANG_NOTHING_TO_REPEAT: Line = {
  en: "There's nothing to repeat yet — ask me something first.",
  ms: "Belum ada apa-apa untuk diulang — tanya saya sesuatu dahulu.",
  "ms-arab": "بلوم اد اڤ٢ اونتوق دأولڠ — تاڽ ساي سسواتو دهولو.",
  ar: "لا يوجد ما أكرره بعد — اسألني شيئًا أولًا.",
  fr: "Il n'y a encore rien à répéter — posez-moi d'abord une question.",
  es: "Todavía no hay nada que repetir — pregúntame algo primero.",
  pt: "Ainda não há nada para repetir — pergunte-me algo primeiro.",
  hi: "अभी दोहराने के लिए कुछ नहीं है — पहले मुझसे कुछ पूछिए।",
  te: "ఇంకా మళ్ళీ చెప్పడానికి ఏమీ లేదు — ముందు నన్ను ఏదైనా అడగండి.",
  mr: "अजून पुन्हा सांगण्यासारखे काही नाही — आधी मला काहीतरी विचारा.",
  zh: "还没有可以重复的内容——请先问我一个问题。",
};

export const LANG_CAN_SPEAK: Line = {
  en: "I can speak {list}.",
  ms: "Saya boleh bercakap dalam bahasa-bahasa ini: {list}.",
  "ms-arab": "ساي بوليه برچاکڤ دالم بهاس٢ اين: {list}.",
  ar: "يمكنني التحدث بهذه اللغات: {list}.",
  fr: "Je peux parler ces langues : {list}.",
  es: "Puedo hablar estos idiomas: {list}.",
  pt: "Posso falar estas línguas: {list}.",
  hi: "मैं ये भाषाएँ बोल सकता हूँ: {list}।",
  te: "నేను ఈ భాషలు మాట్లాడగలను: {list}.",
  mr: "मी या भाषा बोलू शकतो: {list}.",
  zh: "我可以使用这些语言：{list}。",
};

export const LANG_SWITCHED: Line = {
  en: "OK — I'll answer in {language} from now on.",
  ms: "Baik — saya akan menjawab dalam {language} mulai sekarang.",
  "ms-arab": "بايق — ساي اکن منجواب دالم {language} مولاي سکارڠ.",
  ar: "حسنًا — سأجيب باللغة {language} من الآن فصاعدًا.",
  fr: "D'accord — je répondrai désormais en {language}.",
  es: "De acuerdo — a partir de ahora responderé en {language}.",
  pt: "Está bem — a partir de agora respondo em {language}.",
  hi: "ठीक है — अब से मैं {language} में जवाब दूँगा।",
  te: "సరే — ఇకపై నేను {language}లో సమాధానం ఇస్తాను.",
  mr: "ठीक आहे — आतापासून मी {language}मध्ये उत्तर देईन.",
  zh: "好的——从现在起我会用{language}回答。",
};

export const LANG_SOURCE_UNSUPPORTED: Line = {
  en: "This material is in a language I can't answer in yet ({source}), so I'll answer in {language}.",
  ms: "Bahan ini dalam bahasa yang belum boleh saya gunakan ({source}), jadi saya akan menjawab dalam {language}.",
  "ms-arab": "بهن اين دالم بهاس يڠ بلوم بوليه ساي ݢوناکن ({source})، جادي ساي اکن منجواب دالم {language}.",
  ar: "هذه المادة بلغة لا أستطيع الإجابة بها بعد ({source})، لذا سأجيب باللغة {language}.",
  fr: "Ce contenu est dans une langue que je ne parle pas encore ({source}) ; je répondrai donc en {language}.",
  es: "Este material está en un idioma en el que aún no puedo responder ({source}), así que responderé en {language}.",
  pt: "Este material está numa língua em que ainda não consigo responder ({source}), por isso vou responder em {language}.",
  hi: "यह सामग्री ऐसी भाषा में है जिसमें मैं अभी जवाब नहीं दे सकता ({source}), इसलिए मैं {language} में जवाब दूँगा।",
  te: "ఈ విషయం నేను ఇంకా సమాధానం ఇవ్వలేని భాషలో ఉంది ({source}), కాబట్టి నేను {language}లో సమాధానం ఇస్తాను.",
  mr: "हा मजकूर अशा भाषेत आहे ज्यात मी अजून उत्तर देऊ शकत नाही ({source}), म्हणून मी {language}मध्ये उत्तर देईन.",
  zh: "这份材料使用的语言我暂时无法回答（{source}），所以我会用{language}回答。",
};

/** One of the lines above in `lang` (English when absent). */
export function langLine(table: Line, lang: string, vars: Record<string, string | number> = {}): string {
  return lineFor(table, lang, vars);
}

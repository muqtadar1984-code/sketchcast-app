// SK — chapter numbers as people say them (2026-10-30, "play chapter 1 from
// the book"): digits in any of the app's scripts, cardinal words ("chapter
// one", "bab dua") and ordinals ("the first chapter", "bab pertama", "الفصل
// الأول", "le premier chapitre", "पहला अध्याय"), 1–20, in the app's ten UI
// languages. Pure and shared: the play-chapter rule (lesson-rules.ts) and the
// start_lesson tool (capabilities/lesson.ts) read chapter words through the
// same table, so the rule and the model's tool agree on what "chapter one" is.

/** Cardinal and ordinal words → their number (1-based, as spoken). */
export const CHAPTER_NUMBER_WORDS: Readonly<Record<string, number>> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  // Malay
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, delapan: 8, sembilan: 9, sepuluh: 10,
  sebelas: 11, "dua belas": 12, "tiga belas": 13, "empat belas": 14, "lima belas": 15, "dua puluh": 20,
  pertama: 1, kesatu: 1, kedua: 2, ketiga: 3, keempat: 4, kelima: 5, keenam: 6, ketujuh: 7, kelapan: 8, kesembilan: 9, kesepuluh: 10,
  kesebelas: 11, "kedua belas": 12,
  // Malay (Jawi)
  "ساتو": 1, "دوا": 2, "تيݢ": 3, "امڤت": 4, "ليم": 5, "ڤرتام": 1, "کدوا": 2, "کتيݢ": 3,
  // Arabic
  "واحد": 1, "واحدة": 1, "اثنان": 2, "اثنين": 2, "ثلاثة": 3, "ثلاث": 3, "أربعة": 4, "اربعة": 4, "خمسة": 5, "ستة": 6, "سبعة": 7, "ثمانية": 8, "تسعة": 9, "عشرة": 10,
  "الأول": 1, "الاول": 1, "أول": 1, "اول": 1, "الأولى": 1, "الاولى": 1, "الثاني": 2, "ثاني": 2, "الثانية": 2, "الثالث": 3, "ثالث": 3, "الرابع": 4, "الخامس": 5,
  "السادس": 6, "السابع": 7, "الثامن": 8, "التاسع": 9, "العاشر": 10,
  // French
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
  premier: 1, "première": 1, premiere: 1, "deuxième": 2, deuxieme: 2, seconde: 2, "troisième": 3, troisieme: 3, "quatrième": 4, quatrieme: 4,
  "cinquième": 5, cinquieme: 5, "sixième": 6, sixieme: 6, "septième": 7, "huitième": 8, "neuvième": 9, "dixième": 10,
  // Spanish
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  primer: 1, primero: 1, primera: 1, segundo: 2, segunda: 2, tercer: 3, tercero: 3, tercera: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5,
  sexto: 6, "séptimo": 7, septimo: 7, octavo: 8, noveno: 9, "décimo": 10, decimo: 10,
  // Portuguese
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, quatro: 4, sete: 7, oito: 8, nove: 9, dez: 10,
  primeiro: 1, primeira: 1, terceiro: 3, terceira: 3, quarto: 4, "sétimo": 7, oitavo: 8, nono: 9,
  // Hindi
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "छह": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10,
  "पहला": 1, "पहले": 1, "पहली": 1, "दूसरा": 2, "दूसरे": 2, "दूसरी": 2, "तीसरा": 3, "तीसरे": 3, "तीसरी": 3, "चौथा": 4, "चौथे": 4, "पांचवां": 5, "पाँचवाँ": 5,
  // Marathi
  "दोन": 2, "पाच": 5, "पहिला": 1, "पहिल्या": 1, "दुसरा": 2, "दुसऱ्या": 2, "तिसरा": 3, "तिसऱ्या": 3, "पाचवा": 5,
  // Telugu
  "ఒకటి": 1, "రెండు": 2, "మూడు": 3, "నాలుగు": 4, "ఐదు": 5, "మొదటి": 1, "రెండవ": 2, "రెండో": 2, "మూడవ": 3, "మూడో": 3, "నాలుగవ": 4, "ఐదవ": 5,
};

/** Digits of the app's scripts → ASCII (Arabic-Indic, Persian, Devanagari, Telugu). */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹०-९౦-౯]/g, (d) => {
    const c = d.charCodeAt(0);
    for (const zero of [0x660, 0x6f0, 0x966, 0xc66]) if (c >= zero && c <= zero + 9) return String(c - zero);
    return d;
  });
}

/** "1", "١", "1st", "one", "first", "pertama", "الأول", "première" → 1. Null when it is not a chapter number 1–200. */
export function chapterNumberOf(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : null;
  if (typeof raw !== "string") return null;
  const w = asciiDigits(raw).trim().toLowerCase().replace(/\s+/g, " ").replace(/[.:)]+$/u, "");
  const d = w.match(/^(?:no\.? ?|#|number |nombor |رقم )?(\d{1,3})(?:st|nd|rd|th|er|ère|e|º|ª|o|a)?$/u);
  if (d) {
    const n = Number(d[1]);
    return n >= 1 && n <= 200 ? n : null;
  }
  return CHAPTER_NUMBER_WORDS[w] ?? null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex alternation of every chapter number form, longest first (so
 *  "dua belas" wins over "dua"): digits (any script, optional "1st"), words. */
export const CHAPTER_NUMBER_ALT: string = [
  "(?:no\\.? ?|#)?[0-9٠-٩۰-۹०-९౦-౯]{1,3}(?:st|nd|rd|th)?",
  ...Object.keys(CHAPTER_NUMBER_WORDS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe),
].join("|");

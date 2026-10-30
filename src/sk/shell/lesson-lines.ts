// SK's fixed lines for start_lesson ("play chapter 1 from the book",
// 2026-10-30), ten locales. The tool writes them itself (no model), in the
// turn's lines locale (ctx.user.locale), so the rules path says them as they
// are and the model path reads them as the tool's summary. Placeholders:
// {n} chapter (1-based), {book} a title, {titles} up to three titles joined
// with the locale's "or", {max} the last chapter, {part} a part, {query} her words.

import { lineFor } from "./lines";

type Line = Record<string, string>;

export const LESSON_STARTING: Line = {
  en: "Starting chapter {n} of {book} on the Board.",
  ms: "Memulakan bab {n} {book} di Papan.",
  "ms-arab": "ممولاکن باب {n} {book} د ڤاڤن.",
  ar: "جارٍ بدء الفصل {n} من {book} على اللوحة.",
  fr: "Je lance le chapitre {n} de {book} au tableau.",
  es: "Empezando el capítulo {n} de {book} en la pizarra.",
  pt: "A iniciar o capítulo {n} de {book} no quadro.",
  te: "{book} లోని అధ్యాయం {n} ను బోర్డుపై ప్రారంభిస్తున్నాను.",
  mr: "{book} मधील धडा {n} बोर्डवर सुरू करत आहे.",
  hi: "{book} का अध्याय {n} बोर्ड पर शुरू कर रहा हूँ।",
};

export const LESSON_PART_ON_RAIL: Line = {
  en: "Part {part} is on the rail.",
  ms: "Bahagian {part} ada di rel.",
  "ms-arab": "بهاݢين {part} اد د ريل.",
  ar: "الجزء {part} في الشريط الجانبي.",
  fr: "La partie {part} est dans la barre latérale.",
  es: "La parte {part} está en el panel lateral.",
  pt: "A parte {part} está no painel lateral.",
  te: "భాగం {part} పక్క పట్టీలో ఉంది.",
  mr: "भाग {part} बाजूच्या पट्टीत आहे.",
  hi: "भाग {part} साइड पैनल में है।",
};

export const LESSON_TUTOR_OPENING: Line = {
  en: "Opening chapter {n} of {book}.",
  ms: "Membuka bab {n} {book}.",
  "ms-arab": "ممبوک باب {n} {book}.",
  ar: "جارٍ فتح الفصل {n} من {book}.",
  fr: "J'ouvre le chapitre {n} de {book}.",
  es: "Abriendo el capítulo {n} de {book}.",
  pt: "A abrir o capítulo {n} de {book}.",
  te: "{book} లోని అధ్యాయం {n} తెరుస్తున్నాను.",
  mr: "{book} मधील धडा {n} उघडत आहे.",
  hi: "{book} का अध्याय {n} खोल रहा हूँ।",
};

export const LESSON_NOT_GENERATED: Line = {
  en: "Chapter {n} of {book} hasn't been generated yet — I'm opening it in your Library so you can generate the kit.",
  ms: "Bab {n} {book} belum dijana — saya membukanya di Perpustakaan anda supaya anda boleh menjana kitnya.",
  "ms-arab": "باب {n} {book} بلوم دجان — ساي ممبوکاڽ د ڤرڤوستاکاٴن اندا سوڤاي اندا بوليه منجان کيتڽ.",
  ar: "لم يُنشأ الفصل {n} من {book} بعد — سأفتحه في مكتبتك لتُنشئ الحزمة.",
  fr: "Le chapitre {n} de {book} n'a pas encore été généré — je l'ouvre dans votre bibliothèque pour que vous puissiez générer le kit.",
  es: "El capítulo {n} de {book} aún no se ha generado — lo abro en tu biblioteca para que generes el kit.",
  pt: "O capítulo {n} de {book} ainda não foi gerado — vou abri-lo na sua biblioteca para que possa gerar o kit.",
  te: "{book} లోని అధ్యాయం {n} ఇంకా తయారు కాలేదు — మీరు కిట్ తయారు చేయడానికి దాన్ని మీ లైబ్రరీలో తెరుస్తున్నాను.",
  mr: "{book} मधील धडा {n} अजून तयार झालेला नाही — किट तयार करता यावे म्हणून तो तुमच्या लायब्ररीत उघडत आहे.",
  hi: "{book} का अध्याय {n} अभी तैयार नहीं हुआ है — मैं उसे आपकी लाइब्रेरी में खोल रहा हूँ ताकि आप किट बना सकें।",
};

export const LESSON_GENERATING: Line = {
  en: "Chapter {n} of {book} is still being generated — I'm opening it in your Library so you can see how it's going.",
  ms: "Bab {n} {book} masih sedang dijana — saya membukanya di Perpustakaan anda supaya anda boleh melihat kemajuannya.",
  "ms-arab": "باب {n} {book} ماسيه سدڠ دجان — ساي ممبوکاڽ د ڤرڤوستاکاٴن اندا سوڤاي اندا بوليه مليهت کماجوانڽ.",
  ar: "ما زال الفصل {n} من {book} قيد الإنشاء — سأفتحه في مكتبتك لترى تقدّمه.",
  fr: "Le chapitre {n} de {book} est encore en cours de génération — je l'ouvre dans votre bibliothèque pour que vous suiviez son avancement.",
  es: "El capítulo {n} de {book} todavía se está generando — lo abro en tu biblioteca para que veas cómo va.",
  pt: "O capítulo {n} de {book} ainda está a ser gerado — vou abri-lo na sua biblioteca para que veja o progresso.",
  te: "{book} లోని అధ్యాయం {n} ఇంకా తయారవుతోంది — అది ఎలా సాగుతోందో చూడటానికి దాన్ని మీ లైబ్రరీలో తెరుస్తున్నాను.",
  mr: "{book} मधील धडा {n} अजून तयार होत आहे — प्रगती पाहता यावी म्हणून तो तुमच्या लायब्ररीत उघडत आहे.",
  hi: "{book} का अध्याय {n} अभी बन रहा है — मैं उसे आपकी लाइब्रेरी में खोल रहा हूँ ताकि आप उसकी प्रगति देख सकें।",
};

export const LESSON_WHICH_BOOK: Line = {
  en: "Which book — {titles}?",
  ms: "Buku yang mana — {titles}?",
  "ms-arab": "بوکو يڠ مان — {titles}؟",
  ar: "أي كتاب — {titles}؟",
  fr: "Quel livre — {titles} ?",
  es: "¿Qué libro — {titles}?",
  pt: "Qual livro — {titles}?",
  te: "ఏ పుస్తకం — {titles}?",
  mr: "कोणते पुस्तक — {titles}?",
  hi: "कौन सी किताब — {titles}?",
};

export const LESSON_WHICH_CHAPTER: Line = {
  en: "Which chapter of {book}? It has chapters 1 to {max}.",
  ms: "Bab yang mana dalam {book}? Ia mempunyai bab 1 hingga {max}.",
  "ms-arab": "باب يڠ مان دالم {book}؟ اي ممڤوڽاٴي باب 1 هيڠݢ {max}.",
  ar: "أي فصل من {book}؟ فيه الفصول من 1 إلى {max}.",
  fr: "Quel chapitre de {book} ? Il compte les chapitres 1 à {max}.",
  es: "¿Qué capítulo de {book}? Tiene los capítulos 1 a {max}.",
  pt: "Qual capítulo de {book}? Tem os capítulos 1 a {max}.",
  te: "{book} లో ఏ అధ్యాయం? అందులో 1 నుండి {max} వరకు అధ్యాయాలు ఉన్నాయి.",
  mr: "{book} मधील कोणता धडा? त्यात 1 ते {max} धडे आहेत.",
  hi: "{book} का कौन सा अध्याय? इसमें अध्याय 1 से {max} तक हैं।",
};

export const LESSON_NO_CHAPTER: Line = {
  en: "I couldn't find that chapter in {book}. It has chapters 1 to {max}.",
  ms: "Saya tidak menemui bab itu dalam {book}. Ia mempunyai bab 1 hingga {max}.",
  "ms-arab": "ساي تيدق منمواي باب ايت دالم {book}. اي ممڤوڽاٴي باب 1 هيڠݢ {max}.",
  ar: "لم أجد هذا الفصل في {book}. فيه الفصول من 1 إلى {max}.",
  fr: "Je ne trouve pas ce chapitre dans {book}. Il compte les chapitres 1 à {max}.",
  es: "No encontré ese capítulo en {book}. Tiene los capítulos 1 a {max}.",
  pt: "Não encontrei esse capítulo em {book}. Tem os capítulos 1 a {max}.",
  te: "{book} లో ఆ అధ్యాయం కనిపించలేదు. అందులో 1 నుండి {max} వరకు అధ్యాయాలు ఉన్నాయి.",
  mr: "{book} मध्ये तो धडा सापडला नाही. त्यात 1 ते {max} धडे आहेत.",
  hi: "{book} में वह अध्याय नहीं मिला। इसमें अध्याय 1 से {max} तक हैं।",
};

export const LESSON_NO_CHAPTERS: Line = {
  en: "{book} has no chapters I can start yet.",
  ms: "{book} belum mempunyai bab yang boleh saya mulakan.",
  "ms-arab": "{book} بلوم ممڤوڽاٴي باب يڠ بوليه ساي مولاکن.",
  ar: "لا يحتوي {book} بعدُ على فصول يمكنني بدؤها.",
  fr: "{book} n'a pas encore de chapitre que je puisse lancer.",
  es: "{book} aún no tiene capítulos que pueda empezar.",
  pt: "{book} ainda não tem capítulos que eu possa iniciar.",
  te: "{book} లో నేను ప్రారంభించగల అధ్యాయాలు ఇంకా లేవు.",
  mr: "{book} मध्ये मी सुरू करू शकेन असे धडे अजून नाहीत.",
  hi: "{book} में अभी ऐसे अध्याय नहीं हैं जिन्हें मैं शुरू कर सकूँ।",
};

export const LESSON_NO_BOOK_MATCH: Line = {
  en: "I couldn't find a book matching “{query}”. Your books: {titles}.",
  ms: "Saya tidak menemui buku yang sepadan dengan “{query}”. Buku anda: {titles}.",
  "ms-arab": "ساي تيدق منمواي بوکو يڠ سڤادن دڠن “{query}”. بوکو اندا: {titles}.",
  ar: "لم أجد كتابًا يطابق «{query}». كتبك: {titles}.",
  fr: "Je ne trouve aucun livre correspondant à « {query} ». Vos livres : {titles}.",
  es: "No encontré ningún libro que coincida con «{query}». Tus libros: {titles}.",
  pt: "Não encontrei nenhum livro correspondente a «{query}». Os seus livros: {titles}.",
  te: "“{query}” కు సరిపోయే పుస్తకం కనిపించలేదు. మీ పుస్తకాలు: {titles}.",
  mr: "“{query}” शी जुळणारे पुस्तक सापडले नाही. तुमची पुस्तके: {titles}.",
  hi: "“{query}” से मिलती कोई किताब नहीं मिली। आपकी किताबें: {titles}।",
};

export const LESSON_NO_BOOKS: Line = {
  en: "You don't have a book to teach from yet — add one in your Library and I'll start any chapter for you.",
  ms: "Anda belum mempunyai buku untuk diajar — tambah satu di Perpustakaan anda dan saya akan mulakan mana-mana bab untuk anda.",
  "ms-arab": "اندا بلوم ممڤوڽاٴي بوکو اونتوق دأجر — تمبه ساتو د ڤرڤوستاکاٴن اندا دان ساي اکن مولاکن مان٢ باب اونتوق اندا.",
  ar: "ليس لديك كتاب للتدريس منه بعد — أضف كتابًا في مكتبتك وسأبدأ لك أي فصل.",
  fr: "Vous n'avez pas encore de livre à enseigner — ajoutez-en un dans votre bibliothèque et je lancerai n'importe quel chapitre.",
  es: "Aún no tienes un libro para enseñar — añade uno en tu biblioteca y empezaré cualquier capítulo.",
  pt: "Ainda não tem um livro para ensinar — adicione um na sua biblioteca e eu inicio qualquer capítulo.",
  te: "బోధించడానికి మీకు ఇంకా పుస్తకం లేదు — మీ లైబ్రరీలో ఒకటి జోడించండి, ఏ అధ్యాయమైనా నేను ప్రారంభిస్తాను.",
  mr: "शिकवण्यासाठी तुमच्याकडे अजून पुस्तक नाही — तुमच्या लायब्ररीत एक जोडा, मी कोणताही धडा सुरू करेन.",
  hi: "पढ़ाने के लिए अभी आपके पास कोई किताब नहीं है — अपनी लाइब्रेरी में एक जोड़ें, मैं कोई भी अध्याय शुरू कर दूँगा।",
};

export const LESSON_NO_PRODUCT_BOOKS: Line = {
  en: "You don't have a SketchCast book yet — once one is activated, I can open any of its chapters.",
  ms: "Anda belum mempunyai buku SketchCast — setelah satu diaktifkan, saya boleh membuka mana-mana babnya.",
  "ms-arab": "اندا بلوم ممڤوڽاٴي بوکو SketchCast — ستله ساتو داکتيفکن، ساي بوليه ممبوک مان٢ بابڽ.",
  ar: "ليس لديك كتاب من SketchCast بعد — بعد تفعيل أحدها يمكنني فتح أي فصل منه.",
  fr: "Vous n'avez pas encore de livre SketchCast — une fois un livre activé, je peux ouvrir n'importe lequel de ses chapitres.",
  es: "Aún no tienes un libro de SketchCast — cuando actives uno, podré abrir cualquiera de sus capítulos.",
  pt: "Ainda não tem um livro SketchCast — quando um for ativado, posso abrir qualquer um dos seus capítulos.",
  te: "మీకు ఇంకా SketchCast పుస్తకం లేదు — ఒకటి యాక్టివేట్ అయ్యాక, దాని ఏ అధ్యాయమైనా తెరవగలను.",
  mr: "तुमच्याकडे अजून SketchCast पुस्तक नाही — एखादे सक्रिय झाल्यावर, मी त्याचा कोणताही धडा उघडू शकेन.",
  hi: "आपके पास अभी कोई SketchCast किताब नहीं है — एक सक्रिय होते ही मैं उसका कोई भी अध्याय खोल सकता हूँ।",
};

/** The word for "or" when listing titles. */
const OR: Record<string, string> = { en: "or", ms: "atau", "ms-arab": "اتاو", ar: "أو", fr: "ou", es: "o", pt: "ou", te: "లేదా", mr: "किंवा", hi: "या" };

/** "A", "A or B", "A, B or C" in the locale's words. */
export function orList(items: string[], locale: string | null | undefined): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  const or = OR[(locale ?? "en").toLowerCase()] ?? OR.en;
  const sep = locale === "ar" || locale === "ms-arab" ? "، " : ", ";
  return `${list.slice(0, -1).join(sep)} ${or} ${list[list.length - 1]}`;
}

/** Every start_lesson line table, for the all-locales test. */
export const LESSON_LINE_TABLES: Record<string, Line> = {
  LESSON_STARTING,
  LESSON_PART_ON_RAIL,
  LESSON_TUTOR_OPENING,
  LESSON_NOT_GENERATED,
  LESSON_GENERATING,
  LESSON_WHICH_BOOK,
  LESSON_WHICH_CHAPTER,
  LESSON_NO_CHAPTER,
  LESSON_NO_CHAPTERS,
  LESSON_NO_BOOK_MATCH,
  LESSON_NO_BOOKS,
  LESSON_NO_PRODUCT_BOOKS,
};

export { lineFor };

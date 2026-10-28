// SK's fixed lines for the Board's "no lesson yet" moments, ten locales. The
// turn route emits these itself — NO model writes them — so the text is pinned
// here, next to the capabilities' own `say` tables (board.ts), rather than
// read through the dictionary loader, which is server-only and not for API
// routes. The same strings live in src/i18n/messages/*.json under
// `sk.shell.lessonNotStarted` / `sk.shell.startingLesson`; the lines test
// holds the two copies equal.

type Line = Record<string, string>;

export const LESSON_NOT_STARTED: Line = {
  en: "The lesson hasn't started yet. Pick a book and chapter at the top and press Start — or tell me the class and book and I'll set it up.",
  ms: "Pelajaran belum bermula. Pilih buku dan bab di bahagian atas dan tekan Mula — atau beritahu saya kelas dan buku, saya akan sediakannya.",
  "ms-arab": "پلاجرن بلوم برمولا. پيليه بوکو دان باب د بهاݢين اتس دان تکن مولا — اتاو بريتاهو ساي کلس دان بوکو، ساي اکن سدياکنڽ.",
  ar: "لم يبدأ الدرس بعد. اختر كتابًا وفصلًا في الأعلى واضغط ابدأ — أو أخبرني بالصف والكتاب وسأجهّزه لك.",
  fr: "La leçon n'a pas encore commencé. Choisissez un livre et un chapitre en haut, puis appuyez sur Démarrer — ou dites-moi la classe et le livre et je m'en occupe.",
  es: "La clase aún no ha empezado. Elige un libro y un capítulo arriba y pulsa Empezar — o dime la clase y el libro y lo preparo.",
  pt: "A aula ainda não começou. Escolha um livro e um capítulo no topo e carregue em Iniciar — ou diga-me a turma e o livro e eu preparo tudo.",
  te: "పాఠం ఇంకా మొదలవలేదు. పైన ఒక పుస్తకం మరియు అధ్యాయం ఎంచుకొని ప్రారంభించు నొక్కండి — లేదా తరగతి మరియు పుస్తకం చెప్పండి, నేను సిద్ధం చేస్తాను.",
  mr: "पाठ अजून सुरू झाला नाही. वर एक पुस्तक आणि धडा निवडा आणि सुरू करा दाबा — किंवा मला वर्ग आणि पुस्तक सांगा, मी ते तयार करेन.",
  hi: "पाठ अभी शुरू नहीं हुआ है। ऊपर एक किताब और अध्याय चुनें और शुरू करें दबाएँ — या मुझे कक्षा और किताब बताएँ, मैं उसे तैयार कर दूँगा।",
};

export const STARTING_LESSON: Line = {
  en: "Starting {lesson}.",
  ms: "Memulakan {lesson}.",
  "ms-arab": "ممولاکن {lesson}.",
  ar: "جارٍ بدء {lesson}.",
  fr: "Démarrage de {lesson}.",
  es: "Empezando {lesson}.",
  pt: "A iniciar {lesson}.",
  te: "{lesson} ప్రారంభిస్తున్నాను.",
  mr: "{lesson} सुरू करत आहे.",
  hi: "{lesson} शुरू कर रहा हूँ।",
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

/** The line in the user's locale (English when the locale has none). */
export function lineFor(table: Line, locale: string | null | undefined, vars: Record<string, string | number> = {}): string {
  const key = (locale ?? "en").toLowerCase();
  return fill(table[key] ?? table.en, vars);
}

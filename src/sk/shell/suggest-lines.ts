// SK S6 slice C — the greeting suggestion's fixed lines, ten locales. The
// context route speaks these itself (NO model writes them), filled only with
// values from a tool result of the same request. The same strings live in
// src/i18n/messages/*.json under `sk.shell.suggest.<key>`; suggest.test.ts
// holds the two copies equal (the act-lines pattern).

type Line = Record<string, string>;

/** A teacher's next period starts within 15 minutes (timetable.now_next). */
export const SUGGEST_PERIOD: Line = {
  en: "{period} starts in {n} min — {class} {subject}. Open the Board?",
  ms: "{period} bermula dalam {n} minit — {class} {subject}. Buka Papan Kelas?",
  "ms-arab": "{period} برمولا دالم {n} مينيت — {class} {subject}. بوک ڤاڤن کلس؟",
  ar: "تبدأ {period} بعد {n} دقيقة — {class} {subject}. هل أفتح لوح الصف؟",
  fr: "{period} commence dans {n} min — {class} {subject}. J'ouvre le tableau ?",
  es: "{period} empieza en {n} min — {class} {subject}. ¿Abro la pizarra?",
  pt: "{period} começa daqui a {n} min — {class} {subject}. Abro o quadro?",
  te: "{period} {n} నిమిషాల్లో మొదలవుతుంది — {class} {subject}. బోర్డు తెరవనా?",
  mr: "{period} {n} मिनिटांत सुरू होईल — {class} {subject}. बोर्ड उघडू का?",
  hi: "{period} {n} मिनट में शुरू होगा — {class} {subject}। बोर्ड खोलूँ?",
};

/** Marking waiting (the marking.next queue), more than one. */
export const SUGGEST_MARKING: Line = {
  en: "{n} submissions to mark — want the first?",
  ms: "{n} hantaran untuk ditanda — mahu yang pertama?",
  "ms-arab": "{n} هنترن اونتوق دتندا — ماهو يڠ ڤرتام؟",
  ar: "{n} من الأعمال المسلَّمة بانتظار التصحيح — هل أعرض الأول؟",
  fr: "{n} copies à corriger — je vous montre la première ?",
  es: "{n} entregas por corregir — ¿te muestro la primera?",
  pt: "{n} trabalhos por corrigir — mostro o primeiro?",
  te: "దిద్దడానికి {n} సమర్పణలు ఉన్నాయి — మొదటిది చూపించనా?",
  mr: "तपासायला {n} सबमिशन आहेत — पहिले दाखवू का?",
  hi: "जाँचने के लिए {n} सबमिशन हैं — पहला दिखाऊँ?",
};

/** Marking waiting: exactly one. */
export const SUGGEST_MARKING_ONE: Line = {
  en: "1 submission to mark — want to see it?",
  ms: "1 hantaran untuk ditanda — mahu melihatnya?",
  "ms-arab": "1 هنترن اونتوق دتندا — ماهو مليهتڽ؟",
  ar: "عمل مسلَّم واحد بانتظار التصحيح — هل أعرضه؟",
  fr: "1 copie à corriger — je vous la montre ?",
  es: "1 entrega por corregir — ¿te la muestro?",
  pt: "1 trabalho por corrigir — mostro-o?",
  te: "దిద్దడానికి 1 సమర్పణ ఉంది — చూపించనా?",
  mr: "तपासायला 1 सबमिशन आहे — दाखवू का?",
  hi: "जाँचने के लिए 1 सबमिशन है — दिखाऊँ?",
};

/** One piece of work due tomorrow in a teacher's class (assignments.status due=tomorrow). */
export const SUGGEST_DUE_ONE: Line = {
  en: "{title} is due tomorrow for {class} — {n} not done yet. Want the list?",
  ms: "{title} perlu dihantar esok untuk {class} — {n} belum siap. Mahu senarainya?",
  "ms-arab": "{title} ڤرلو دهنتر ايسوق اونتوق {class} — {n} بلوم سياڤ. ماهو سنارايڽ؟",
  ar: "موعد تسليم {title} لصف {class} غدًا — {n} لم ينجزوه بعد. هل أعرض القائمة؟",
  fr: "{title} est à rendre demain pour {class} — {n} pas encore faits. Je vous montre la liste ?",
  es: "{title} se entrega mañana en {class} — {n} aún sin hacer. ¿Te muestro la lista?",
  pt: "{title} é para entregar amanhã em {class} — {n} ainda por fazer. Mostro a lista?",
  te: "{title} రేపు {class} కోసం గడువు — ఇంకా {n} మంది పూర్తి చేయలేదు. జాబితా చూపించనా?",
  mr: "{title} उद्या {class} साठी देय आहे — अजून {n} जणांनी पूर्ण केले नाही. यादी दाखवू का?",
  hi: "{title} कल {class} के लिए जमा होना है — अभी {n} ने पूरा नहीं किया। सूची दिखाऊँ?",
};

/** Several pieces of work due tomorrow across a teacher's classes. */
export const SUGGEST_DUE_MANY: Line = {
  en: "{n} pieces of work are due tomorrow in your classes — want the list?",
  ms: "{n} tugasan perlu dihantar esok dalam kelas anda — mahu senarainya?",
  "ms-arab": "{n} توݢسن ڤرلو دهنتر ايسوق دالم کلس اندا — ماهو سنارايڽ؟",
  ar: "{n} من الأعمال موعد تسليمها غدًا في صفوفك — هل أعرض القائمة؟",
  fr: "{n} travaux sont à rendre demain dans vos classes — je vous montre la liste ?",
  es: "{n} trabajos se entregan mañana en tus clases — ¿te muestro la lista?",
  pt: "{n} trabalhos são para entregar amanhã nas suas turmas — mostro a lista?",
  te: "మీ తరగతుల్లో {n} పనులకు రేపు గడువు — జాబితా చూపించనా?",
  mr: "तुमच्या वर्गांमध्ये {n} कामे उद्या देय आहेत — यादी दाखवू का?",
  hi: "आपकी कक्षाओं में {n} काम कल जमा होने हैं — सूची दिखाऊँ?",
};

/** A student's own work due tomorrow. */
export const SUGGEST_STUDENT_DUE: Line = {
  en: "Reminder: {title} is due tomorrow.",
  ms: "Peringatan: {title} perlu dihantar esok.",
  "ms-arab": "ڤريڠاتن: {title} ڤرلو دهنتر ايسوق.",
  ar: "تذكير: موعد تسليم {title} غدًا.",
  fr: "Rappel : {title} est à rendre demain.",
  es: "Recordatorio: {title} se entrega mañana.",
  pt: "Lembrete: {title} é para entregar amanhã.",
  te: "గుర్తుచేస్తున్నాను: {title} రేపటికి గడువు.",
  mr: "आठवण: {title} उद्या द्यायचे आहे.",
  hi: "याद दिला दूँ: {title} कल जमा करना है।",
};

/** A parent's child has overdue work (the child.status assembly). */
export const SUGGEST_CHILD_OVERDUE: Line = {
  en: "{name} has {n} overdue — {title}. Want the details?",
  ms: "{name} ada {n} tugasan lewat — {title}. Mahu butirannya?",
  "ms-arab": "{name} اد {n} توݢسن لوت — {title}. ماهو بوتيرنڽ؟",
  ar: "لدى {name} {n} من الأعمال المتأخرة — {title}. هل أعرض التفاصيل؟",
  fr: "{name} a {n} travail(s) en retard — {title}. Je vous donne le détail ?",
  es: "{name} tiene {n} trabajo(s) atrasado(s) — {title}. ¿Te doy los detalles?",
  pt: "{name} tem {n} trabalho(s) em atraso — {title}. Quer os detalhes?",
  te: "{name}కి {n} పనుల గడువు దాటింది — {title}. వివరాలు చూపించనా?",
  mr: "{name} चे {n} काम उशिरा आहे — {title}. तपशील दाखवू का?",
  hi: "{name} का {n} काम देर से है — {title}। विवरण दिखाऊँ?",
};

/** A parent's child has work due tomorrow. */
export const SUGGEST_CHILD_TOMORROW: Line = {
  en: "{name} has {title} due tomorrow. Want the details?",
  ms: "{name} perlu menghantar {title} esok. Mahu butirannya?",
  "ms-arab": "{name} ڤرلو مڠهنتر {title} ايسوق. ماهو بوتيرنڽ؟",
  ar: "على {name} تسليم {title} غدًا. هل أعرض التفاصيل؟",
  fr: "{name} doit rendre {title} demain. Je vous donne le détail ?",
  es: "{name} tiene que entregar {title} mañana. ¿Te doy los detalles?",
  pt: "{name} tem de entregar {title} amanhã. Quer os detalhes?",
  te: "{name} రేపు {title} ఇవ్వాలి. వివరాలు చూపించనా?",
  mr: "{name} ला उद्या {title} द्यायचे आहे. तपशील दाखवू का?",
  hi: "{name} को कल {title} जमा करना है। विवरण दिखाऊँ?",
};

/** Workflow memory: the class and kit last used on the Board. */
export const SUGGEST_LAST_TIME: Line = {
  en: "Last time: {class}, {kit} — carry on?",
  ms: "Kali terakhir: {class}, {kit} — mahu teruskan?",
  "ms-arab": "کالي ترأخير: {class}، {kit} — ماهو تروسکن؟",
  ar: "آخر مرة: {class}، {kit} — هل نتابع؟",
  fr: "La dernière fois : {class}, {kit} — on continue ?",
  es: "La última vez: {class}, {kit} — ¿seguimos?",
  pt: "Da última vez: {class}, {kit} — continuamos?",
  te: "చివరిసారి: {class}, {kit} — కొనసాగిద్దామా?",
  mr: "मागच्या वेळी: {class}, {kit} — पुढे सुरू ठेवू का?",
  hi: "पिछली बार: {class}, {kit} — आगे जारी रखें?",
};

/** Workflow memory: the kit last used, no class known. */
export const SUGGEST_LAST_TIME_KIT: Line = {
  en: "Last time: {kit} — carry on?",
  ms: "Kali terakhir: {kit} — mahu teruskan?",
  "ms-arab": "کالي ترأخير: {kit} — ماهو تروسکن؟",
  ar: "آخر مرة: {kit} — هل نتابع؟",
  fr: "La dernière fois : {kit} — on continue ?",
  es: "La última vez: {kit} — ¿seguimos?",
  pt: "Da última vez: {kit} — continuamos?",
  te: "చివరిసారి: {kit} — కొనసాగిద్దామా?",
  mr: "मागच्या वेळी: {kit} — पुढे सुरू ठेवू का?",
  hi: "पिछली बार: {kit} — आगे जारी रखें?",
};

/** Workflow memory: a task SK was in the middle of when the conversation lapsed. */
export const SUGGEST_PENDING: Line = {
  en: "Last time something was left unfinished — want to carry on where you left off?",
  ms: "Kali terakhir ada perkara yang belum selesai — mahu sambung dari situ?",
  "ms-arab": "کالي ترأخير اد ڤرکارا يڠ بلوم سلساي — ماهو سمبوڠ دري سيتو؟",
  ar: "في المرة الماضية بقي شيء لم يكتمل — هل نتابع من حيث توقفنا؟",
  fr: "La dernière fois, quelque chose est resté en suspens — on reprend là où vous vous étiez arrêté ?",
  es: "La última vez quedó algo sin terminar — ¿seguimos donde lo dejaste?",
  pt: "Da última vez ficou algo por terminar — continuamos onde ficou?",
  te: "చివరిసారి ఒక పని పూర్తి కాలేదు — ఆపిన చోటు నుంచి కొనసాగిద్దామా?",
  mr: "मागच्या वेळी एक काम अपूर्ण राहिले — जिथे थांबलात तिथून सुरू करू का?",
  hi: "पिछली बार कुछ अधूरा रह गया था — जहाँ छोड़ा था वहीं से आगे बढ़ें?",
};

/** "No" to a suggestion's offer. */
export const SUGGEST_DECLINED: Line = {
  en: "All right.",
  ms: "Baiklah.",
  "ms-arab": "باءيقله.",
  ar: "حسنًا.",
  fr: "D'accord.",
  es: "De acuerdo.",
  pt: "Muito bem.",
  te: "సరే.",
  mr: "ठीक आहे.",
  hi: "ठीक है।",
};

/** A piece of work with no title of its own. */
export const SUGGEST_WORK: Line = {
  en: "a piece of work",
  ms: "satu tugasan",
  "ms-arab": "ساتو توݢسن",
  ar: "عمل",
  fr: "un travail",
  es: "un trabajo",
  pt: "um trabalho",
  te: "ఒక పని",
  mr: "एक काम",
  hi: "एक काम",
};

/** Dictionary key (`sk.shell.suggest.<key>`) → table, for the parity test. */
export const SUGGEST_LINE_TABLES: Record<string, Line> = {
  period: SUGGEST_PERIOD,
  marking: SUGGEST_MARKING,
  markingOne: SUGGEST_MARKING_ONE,
  dueOne: SUGGEST_DUE_ONE,
  dueMany: SUGGEST_DUE_MANY,
  studentDue: SUGGEST_STUDENT_DUE,
  childOverdue: SUGGEST_CHILD_OVERDUE,
  childTomorrow: SUGGEST_CHILD_TOMORROW,
  lastTime: SUGGEST_LAST_TIME,
  lastTimeKit: SUGGEST_LAST_TIME_KIT,
  pending: SUGGEST_PENDING,
  declined: SUGGEST_DECLINED,
  work: SUGGEST_WORK,
};

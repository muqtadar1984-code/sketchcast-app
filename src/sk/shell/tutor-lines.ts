// SK's fixed lines for the student tutor (S3 slice D), ten locales. The turn
// and context routes and the tutor.* capabilities say these themselves — NO
// model writes them — so, like lines.ts and act-lines.ts, the text is pinned
// here rather than read through the server-only dictionary loader. The same
// strings live in src/i18n/messages/*.json under `sk.shell.tutor.*`;
// tutor-shell.test.ts holds the two copies equal. Fill with `lineFor` (lines.ts).
// GENERATED (scratchpad s3d-lines.py); self-contained on purpose (no imports).

type Line = Record<string, string>;

export const TUTOR_PLAY: Line = {
  en: "Playing {heading}.",
  ms: "Memainkan {heading}.",
  "ms-arab": "مماٴينکن {heading}.",
  ar: "تشغيل {heading}.",
  fr: "Lecture de {heading}.",
  es: "Reproduciendo {heading}.",
  pt: "A reproduzir {heading}.",
  te: "{heading} ప్లే అవుతోంది.",
  mr: "{heading} सुरू आहे.",
  hi: "{heading} चल रहा है।",
};

export const TUTOR_PAUSE: Line = {
  en: "Paused.",
  ms: "Dijeda.",
  "ms-arab": "دجيدا.",
  ar: "تم الإيقاف المؤقت.",
  fr: "En pause.",
  es: "En pausa.",
  pt: "Em pausa.",
  te: "ఆపాను.",
  mr: "थांबवले.",
  hi: "रोक दिया।",
};

export const TUTOR_RESTART: Line = {
  en: "Playing the lesson from the start.",
  ms: "Memainkan pelajaran dari awal.",
  "ms-arab": "مماٴينکن ڤلاجرن دري اول.",
  ar: "تشغيل الدرس من البداية.",
  fr: "Lecture de la leçon depuis le début.",
  es: "Reproduciendo la lección desde el principio.",
  pt: "A reproduzir a lição desde o início.",
  te: "పాఠాన్ని మొదటి నుంచి ప్లే చేస్తున్నాను.",
  mr: "पाठ सुरुवातीपासून सुरू करत आहे.",
  hi: "पाठ शुरू से चला रहा हूँ।",
};

export const TUTOR_SECTION: Line = {
  en: "Section {n}: {heading}.",
  ms: "Bahagian {n}: {heading}.",
  "ms-arab": "بهاݢين {n}: {heading}.",
  ar: "الجزء {n}: {heading}.",
  fr: "Partie {n} : {heading}.",
  es: "Sección {n}: {heading}.",
  pt: "Secção {n}: {heading}.",
  te: "భాగం {n}: {heading}.",
  mr: "भाग {n}: {heading}.",
  hi: "भाग {n}: {heading}।",
};

export const TUTOR_SLIDE: Line = {
  en: "Here is the slide for {heading}.",
  ms: "Ini slaid untuk {heading}.",
  "ms-arab": "اين سلايد اونتوق {heading}.",
  ar: "هذه شريحة {heading}.",
  fr: "Voici la diapositive de {heading}.",
  es: "Aquí tienes la diapositiva de {heading}.",
  pt: "Aqui está o diapositivo de {heading}.",
  te: "{heading} స్లయిడ్ ఇదిగో.",
  mr: "{heading} ची स्लाइड ही आहे.",
  hi: "यह {heading} की स्लाइड है।",
};

export const TUTOR_PRACTISE: Line = {
  en: "Here are the practice questions for {heading}.",
  ms: "Ini soalan latihan untuk {heading}.",
  "ms-arab": "اين سوءالن لاتيهن اونتوق {heading}.",
  ar: "هذه أسئلة التدريب على {heading}.",
  fr: "Voici les questions d'entraînement sur {heading}.",
  es: "Aquí tienes las preguntas de práctica de {heading}.",
  pt: "Aqui estão as perguntas de prática sobre {heading}.",
  te: "{heading} కోసం అభ్యాస ప్రశ్నలు ఇవిగో.",
  mr: "{heading} साठी सरावाचे प्रश्न हे आहेत.",
  hi: "{heading} के अभ्यास प्रश्न ये रहे।",
};

export const TUTOR_NO_KIT: Line = {
  en: "Open a chapter first — then I can play it, show its slides and quiz you.",
  ms: "Buka satu bab dahulu — kemudian saya boleh memainkannya, menunjukkan slaidnya dan menguji anda.",
  "ms-arab": "بوک ساتو باب دهولو — کمودين ساي بوليه مماٴينکنڽ، منونجوقکن سلايدڽ دان مڠوجي اندا.",
  ar: "افتح فصلًا أولًا — بعدها أستطيع تشغيله وعرض شرائحه واختبارك.",
  fr: "Ouvre d'abord un chapitre — ensuite je peux le lire, montrer ses diapositives et t'interroger.",
  es: "Abre primero un capítulo — luego puedo reproducirlo, mostrar sus diapositivas y hacerte preguntas.",
  pt: "Abre primeiro um capítulo — depois posso reproduzi-lo, mostrar os diapositivos e fazer-te perguntas.",
  te: "ముందుగా ఒక అధ్యాయం తెరవండి — అప్పుడు నేను దాన్ని ప్లే చేసి, స్లయిడ్‌లు చూపించి, మిమ్మల్ని ప్రశ్నించగలను.",
  mr: "आधी एक धडा उघडा — मग मी तो चालवू शकतो, त्याच्या स्लाइड दाखवू शकतो आणि तुमची उजळणी घेऊ शकतो.",
  hi: "पहले एक अध्याय खोलें — फिर मैं उसे चला सकता हूँ, उसकी स्लाइड दिखा सकता हूँ और आपसे सवाल पूछ सकता हूँ।",
};

export const TUTOR_NO_SECTION: Line = {
  en: "I couldn't find that part of the lesson. Say a section number or its title.",
  ms: "Saya tidak dapat mencari bahagian pelajaran itu. Sebutkan nombor bahagian atau tajuknya.",
  "ms-arab": "ساي تيدق داڤت منچاري بهاݢين ڤلاجرن ايت. سبوتکن نومبور بهاݢين اتاو تاجوقڽ.",
  ar: "لم أجد هذا الجزء من الدرس. قل رقم الجزء أو عنوانه.",
  fr: "Je n'ai pas trouvé cette partie de la leçon. Dis le numéro de la partie ou son titre.",
  es: "No encontré esa parte de la lección. Di el número de la sección o su título.",
  pt: "Não encontrei essa parte da lição. Diz o número da secção ou o título.",
  te: "పాఠంలో ఆ భాగం దొరకలేదు. భాగం సంఖ్య లేదా దాని శీర్షిక చెప్పండి.",
  mr: "पाठाचा तो भाग सापडला नाही. भागाचा क्रमांक किंवा त्याचे शीर्षक सांगा.",
  hi: "पाठ का वह हिस्सा नहीं मिला। भाग की संख्या या उसका शीर्षक बताइए।",
};

export const TUTOR_NEED_SECTION: Line = {
  en: "Open a chapter and pick a section, then ask me about it.",
  ms: "Buka satu bab dan pilih satu bahagian, kemudian tanya saya tentangnya.",
  "ms-arab": "بوک ساتو باب دان ڤيليه ساتو بهاݢين، کمودين تاڽ ساي تنتڠڽ.",
  ar: "افتح فصلًا واختر جزءًا، ثم اسألني عنه.",
  fr: "Ouvre un chapitre et choisis une partie, puis pose-moi ta question.",
  es: "Abre un capítulo y elige una sección; luego pregúntame sobre ella.",
  pt: "Abre um capítulo e escolhe uma secção; depois pergunta-me sobre ela.",
  te: "ఒక అధ్యాయం తెరిచి ఒక భాగాన్ని ఎంచుకోండి, తర్వాత దాని గురించి నన్ను అడగండి.",
  mr: "एक धडा उघडा आणि एक भाग निवडा, मग त्याबद्दल मला विचारा.",
  hi: "एक अध्याय खोलें और एक भाग चुनें, फिर उसके बारे में मुझसे पूछें।",
};

export const TUTOR_WHERE_WEAK: Line = {
  en: "Next: go over {heading} again — that idea still needs work.",
  ms: "Seterusnya: ulang kaji {heading} — idea itu masih perlu diperbaiki.",
  "ms-arab": "ستروسڽ: اولڠ کاجي {heading} — إيديا ايت ماسيه ڤرلو دڤرباٴيقي.",
  ar: "التالي: راجع {heading} مرة أخرى — هذه الفكرة ما زالت تحتاج إلى عمل.",
  fr: "Ensuite : revois {heading} — cette idée demande encore du travail.",
  es: "Lo siguiente: repasa {heading} otra vez — esa idea aún necesita trabajo.",
  pt: "A seguir: revê {heading} outra vez — essa ideia ainda precisa de trabalho.",
  te: "తర్వాత: {heading}ని మళ్లీ చూడండి — ఆ భావనపై ఇంకా కృషి అవసరం.",
  mr: "पुढे: {heading} पुन्हा पाहा — त्या संकल्पनेवर अजून काम हवे आहे.",
  hi: "आगे: {heading} फिर से देखें — इस विचार पर अभी काम चाहिए।",
};

export const TUTOR_WHERE_WATCH: Line = {
  en: "Next: watch section {n}, {heading}.",
  ms: "Seterusnya: tonton bahagian {n}, {heading}.",
  "ms-arab": "ستروسڽ: تونتون بهاݢين {n}، {heading}.",
  ar: "التالي: شاهد الجزء {n}، {heading}.",
  fr: "Ensuite : regarde la partie {n}, {heading}.",
  es: "Lo siguiente: mira la sección {n}, {heading}.",
  pt: "A seguir: vê a secção {n}, {heading}.",
  te: "తర్వాత: భాగం {n}, {heading} చూడండి.",
  mr: "पुढे: भाग {n}, {heading} पाहा.",
  hi: "आगे: भाग {n}, {heading} देखें।",
};

export const TUTOR_WHERE_PRACTISE: Line = {
  en: "Next: practise section {n}, {heading}.",
  ms: "Seterusnya: buat latihan bahagian {n}, {heading}.",
  "ms-arab": "ستروسڽ: بوات لاتيهن بهاݢين {n}، {heading}.",
  ar: "التالي: تدرّب على الجزء {n}، {heading}.",
  fr: "Ensuite : entraîne-toi sur la partie {n}, {heading}.",
  es: "Lo siguiente: practica la sección {n}, {heading}.",
  pt: "A seguir: pratica a secção {n}, {heading}.",
  te: "తర్వాత: భాగం {n}, {heading} అభ్యాసం చేయండి.",
  mr: "पुढे: भाग {n}, {heading} चा सराव करा.",
  hi: "आगे: भाग {n}, {heading} का अभ्यास करें।",
};

export const TUTOR_WHERE_DONE: Line = {
  en: "You have finished this lesson. Well done!",
  ms: "Anda telah menamatkan pelajaran ini. Syabas!",
  "ms-arab": "اندا تله منامتکن ڤلاجرن اين. شاباس!",
  ar: "لقد أنهيت هذا الدرس. أحسنت!",
  fr: "Tu as terminé cette leçon. Bravo !",
  es: "Has terminado esta lección. ¡Bien hecho!",
  pt: "Terminaste esta lição. Muito bem!",
  te: "మీరు ఈ పాఠం పూర్తి చేశారు. చాలా బాగుంది!",
  mr: "तुम्ही हा पाठ पूर्ण केला. छान!",
  hi: "आपने यह पाठ पूरा कर लिया। शाबाश!",
};

export const TUTOR_PROGRESS_HEAD: Line = {
  en: "Your progress on {kit}:",
  ms: "Kemajuan anda dalam {kit}:",
  "ms-arab": "کماجوان اندا دالم {kit}:",
  ar: "تقدّمك في {kit}:",
  fr: "Tes progrès sur {kit} :",
  es: "Tu progreso en {kit}:",
  pt: "O teu progresso em {kit}:",
  te: "{kit}లో మీ పురోగతి:",
  mr: "{kit} मधील तुमची प्रगती:",
  hi: "{kit} में आपकी प्रगति:",
};

export const TUTOR_PROGRESS_MASTERED: Line = {
  en: "Mastered: {list}.",
  ms: "Dikuasai: {list}.",
  "ms-arab": "دکواساٴي: {list}.",
  ar: "أتقنت: {list}.",
  fr: "Maîtrisé : {list}.",
  es: "Dominado: {list}.",
  pt: "Dominado: {list}.",
  te: "నేర్చుకున్నవి: {list}.",
  mr: "आत्मसात: {list}.",
  hi: "महारत: {list}।",
};

export const TUTOR_PROGRESS_PROVISIONAL: Line = {
  en: "Getting there (with help): {list}.",
  ms: "Hampir berjaya (dengan bantuan): {list}.",
  "ms-arab": "همڤير برجاي (دڠن بنتوان): {list}.",
  ar: "تقترب (بمساعدة): {list}.",
  fr: "Presque (avec de l'aide) : {list}.",
  es: "Casi (con ayuda): {list}.",
  pt: "Quase (com ajuda): {list}.",
  te: "దాదాపు వచ్చింది (సహాయంతో): {list}.",
  mr: "जवळजवळ (मदतीने): {list}.",
  hi: "लगभग (मदद से): {list}।",
};

export const TUTOR_PROGRESS_NEEDS_WORK: Line = {
  en: "Needs work: {list}.",
  ms: "Perlu diperbaiki: {list}.",
  "ms-arab": "ڤرلو دڤرباٴيقي: {list}.",
  ar: "يحتاج إلى عمل: {list}.",
  fr: "À retravailler : {list}.",
  es: "Necesita trabajo: {list}.",
  pt: "Precisa de trabalho: {list}.",
  te: "ఇంకా కృషి అవసరం: {list}.",
  mr: "अजून काम हवे: {list}.",
  hi: "काम चाहिए: {list}।",
};

export const TUTOR_PROGRESS_NONE: Line = {
  en: "You haven't answered any questions in this lesson yet. Say \"quiz me\" to start.",
  ms: "Anda belum menjawab sebarang soalan dalam pelajaran ini. Sebut \"uji saya\" untuk bermula.",
  "ms-arab": "اندا بلوم منجواب سبارڠ سوءالن دالم ڤلاجرن اين. سبوت \"اوجي ساي\" اونتوق برمولا.",
  ar: "لم تجب عن أي سؤال في هذا الدرس بعد. قل \"اختبرني\" لتبدأ.",
  fr: "Tu n'as encore répondu à aucune question de cette leçon. Dis « interroge-moi » pour commencer.",
  es: "Aún no has respondido ninguna pregunta de esta lección. Di \"pregúntame\" para empezar.",
  pt: "Ainda não respondeste a nenhuma pergunta desta lição. Diz \"faz-me perguntas\" para começar.",
  te: "ఈ పాఠంలో మీరు ఇంకా ఏ ప్రశ్నకూ సమాధానం ఇవ్వలేదు. ప్రారంభించడానికి \"నన్ను ప్రశ్నించు\" అనండి.",
  mr: "या पाठातील एकाही प्रश्नाचे उत्तर तुम्ही अजून दिलेले नाही. सुरू करण्यासाठी \"माझी परीक्षा घ्या\" म्हणा.",
  hi: "आपने इस पाठ में अभी तक किसी प्रश्न का उत्तर नहीं दिया है। शुरू करने के लिए \"मुझसे सवाल पूछो\" कहें।",
};

export const TUTOR_GREETING_RESUME: Line = {
  en: "Hi {name} — you were on {section} of {kit}. Carry on?",
  ms: "Hai {name} — anda sedang di {section} dalam {kit}. Mahu teruskan?",
  "ms-arab": "هاي {name} — اندا سدڠ د {section} دالم {kit}. ماهو تروسکن؟",
  ar: "مرحبًا {name} — كنت عند {section} من {kit}. هل نكمل؟",
  fr: "Salut {name} — tu en étais à {section} de {kit}. On continue ?",
  es: "Hola {name} — ibas por {section} de {kit}. ¿Seguimos?",
  pt: "Olá {name} — estavas em {section} de {kit}. Continuamos?",
  te: "హాయ్ {name} — మీరు {kit}లో {section} వద్ద ఉన్నారు. కొనసాగిద్దామా?",
  mr: "नमस्कार {name} — तुम्ही {kit} मधील {section} वर होता. पुढे सुरू करायचे?",
  hi: "नमस्ते {name} — आप {kit} के {section} पर थे। आगे बढ़ें?",
};

export const TUTOR_GREETING_LIST: Line = {
  en: "Hi {name} — here are your chapters: {list}. Which one shall we open?",
  ms: "Hai {name} — ini bab-bab anda: {list}. Yang mana patut kita buka?",
  "ms-arab": "هاي {name} — اين باب٢ اندا: {list}. يڠ مان ڤاتوت کيت بوک؟",
  ar: "مرحبًا {name} — هذه فصولك: {list}. أيّها نفتح؟",
  fr: "Salut {name} — voici tes chapitres : {list}. Lequel ouvrons-nous ?",
  es: "Hola {name} — estos son tus capítulos: {list}. ¿Cuál abrimos?",
  pt: "Olá {name} — estes são os teus capítulos: {list}. Qual abrimos?",
  te: "హాయ్ {name} — మీ అధ్యాయాలు ఇవి: {list}. ఏది తెరుద్దాం?",
  mr: "नमस्कार {name} — हे तुमचे धडे: {list}. कोणता उघडूया?",
  hi: "नमस्ते {name} — ये रहे आपके अध्याय: {list}। कौन-सा खोलें?",
};

export const TUTOR_GREETING_NONE: Line = {
  en: "Hi {name} — I'm SK, your tutor. Open a chapter and I'll help you through it.",
  ms: "Hai {name} — saya SK, tutor anda. Buka satu bab dan saya akan membantu anda melaluinya.",
  "ms-arab": "هاي {name} — ساي SK، توتور اندا. بوک ساتو باب دان ساي اکن ممبنتو اندا ملالوٴيڽ.",
  ar: "مرحبًا {name} — أنا SK، معلّمك. افتح فصلًا وسأساعدك فيه.",
  fr: "Salut {name} — je suis SK, ton tuteur. Ouvre un chapitre et je t'aiderai à le travailler.",
  es: "Hola {name} — soy SK, tu tutor. Abre un capítulo y te ayudaré a recorrerlo.",
  pt: "Olá {name} — sou o SK, o teu tutor. Abre um capítulo e eu ajudo-te a percorrê-lo.",
  te: "హాయ్ {name} — నేను SK, మీ ట్యూటర్. ఒక అధ్యాయం తెరవండి, నేను మీకు సహాయం చేస్తాను.",
  mr: "नमस्कार {name} — मी SK, तुमचा शिक्षक. एक धडा उघडा, मी तुम्हाला मदत करेन.",
  hi: "नमस्ते {name} — मैं SK हूँ, आपका ट्यूटर। एक अध्याय खोलें, मैं उसमें आपकी मदद करूँगा।",
};

export const TUTOR_CHAPTER: Line = {
  en: "Chapter {n}",
  ms: "Bab {n}",
  "ms-arab": "باب {n}",
  ar: "الفصل {n}",
  fr: "Chapitre {n}",
  es: "Capítulo {n}",
  pt: "Capítulo {n}",
  te: "అధ్యాయం {n}",
  mr: "धडा {n}",
  hi: "अध्याय {n}",
};

export const TUTOR_SECTION_N: Line = {
  en: "section {n}",
  ms: "bahagian {n}",
  "ms-arab": "بهاݢين {n}",
  ar: "الجزء {n}",
  fr: "la partie {n}",
  es: "la sección {n}",
  pt: "a secção {n}",
  te: "భాగం {n}",
  mr: "भाग {n}",
  hi: "भाग {n}",
};

/** The dictionary key of each table (sk.shell.tutor.<key>), for the copy test. */
export const TUTOR_LINE_KEYS: Record<string, Line> = {
  play: TUTOR_PLAY,
  pause: TUTOR_PAUSE,
  restart: TUTOR_RESTART,
  section: TUTOR_SECTION,
  slide: TUTOR_SLIDE,
  practise: TUTOR_PRACTISE,
  noKit: TUTOR_NO_KIT,
  noSection: TUTOR_NO_SECTION,
  needSection: TUTOR_NEED_SECTION,
  whereWeak: TUTOR_WHERE_WEAK,
  whereWatch: TUTOR_WHERE_WATCH,
  wherePractise: TUTOR_WHERE_PRACTISE,
  whereDone: TUTOR_WHERE_DONE,
  progressHead: TUTOR_PROGRESS_HEAD,
  progressMastered: TUTOR_PROGRESS_MASTERED,
  progressProvisional: TUTOR_PROGRESS_PROVISIONAL,
  progressNeedsWork: TUTOR_PROGRESS_NEEDS_WORK,
  progressNone: TUTOR_PROGRESS_NONE,
  greetingResume: TUTOR_GREETING_RESUME,
  greetingList: TUTOR_GREETING_LIST,
  greetingNone: TUTOR_GREETING_NONE,
  chapter: TUTOR_CHAPTER,
  sectionN: TUTOR_SECTION_N,
};

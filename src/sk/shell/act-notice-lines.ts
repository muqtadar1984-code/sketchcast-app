// SK's fixed lines for `notice.school` (S5 slice D: the click-only school
// notice), ten locales. The capability (src/sk/capabilities/notice.ts) and the
// action (act-notice.ts) emit these themselves — NO model writes them — so,
// like act-lines.ts, the text is pinned here. The same strings live in
// src/i18n/messages/*.json under `sk.shell.notice.*`; act-notice-lines.test.ts
// holds the two copies equal. Fill with `lineFor` (lines.ts).
//
// "Who sees it" follows 0068's se_read: audience 'school' → every member of the
// school (staff and students) plus parents of its school-linked children;
// 'staff' → every adult profile of the school (adult_of_school: not a student).
//
// Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

export const NOTICE_CARD_TITLE_SCHOOL: Line = {
  en: "Post a notice to the whole school",
  ms: "Hantar notis kepada seluruh sekolah",
  "ms-arab": "هانتر نوتيس کڤد سلوروه سکوله",
  ar: "انشر إشعارًا للمدرسة كلها",
  fr: "Publier un avis pour toute l'école",
  es: "Publicar un aviso para toda la escuela",
  pt: "Publicar um aviso para toda a escola",
  te: "మొత్తం పాఠశాలకు నోటీసు పోస్ట్ చేయండి",
  mr: "संपूर्ण शाळेसाठी सूचना पोस्ट करा",
  hi: "पूरे स्कूल के लिए सूचना पोस्ट करें",
};

export const NOTICE_CARD_TITLE_STAFF: Line = {
  en: "Post a notice to all staff",
  ms: "Hantar notis kepada semua staf",
  "ms-arab": "هانتر نوتيس کڤد سموا ستاف",
  ar: "انشر إشعارًا لجميع الموظفين",
  fr: "Publier un avis pour tout le personnel",
  es: "Publicar un aviso para todo el personal",
  pt: "Publicar um aviso para toda a equipa",
  te: "సిబ్బంది అందరికీ నోటీసు పోస్ట్ చేయండి",
  mr: "सर्व कर्मचाऱ्यांसाठी सूचना पोस्ट करा",
  hi: "सभी स्टाफ़ के लिए सूचना पोस्ट करें",
};

/** se_read for audience 'school': members (staff + students) and school-linked parents. */
export const NOTICE_SEEN_SCHOOL: Line = {
  en: "Every parent, student and teacher at {school}",
  ms: "Setiap ibu bapa, murid dan guru di {school}",
  "ms-arab": "ستياڤ ايبو باڤ، موريد دان ݢورو د {school}",
  ar: "كل ولي أمر وطالب ومعلم في {school}",
  fr: "Chaque parent, élève et enseignant de {school}",
  es: "Cada padre, alumno y docente de {school}",
  pt: "Cada encarregado, aluno e professor de {school}",
  te: "{school}లోని ప్రతి తల్లిదండ్రి, విద్యార్థి మరియు ఉపాధ్యాయుడు",
  mr: "{school} मधील प्रत्येक पालक, विद्यार्थी आणि शिक्षक",
  hi: "{school} के हर अभिभावक, विद्यार्थी और शिक्षक",
};

/** se_read for audience 'staff': every adult profile of the school. */
export const NOTICE_SEEN_STAFF: Line = {
  en: "All staff at {school}",
  ms: "Semua staf di {school}",
  "ms-arab": "سموا ستاف د {school}",
  ar: "جميع الموظفين في {school}",
  fr: "Tout le personnel de {school}",
  es: "Todo el personal de {school}",
  pt: "Toda a equipa de {school}",
  te: "{school}లోని సిబ్బంది అందరూ",
  mr: "{school} मधील सर्व कर्मचारी",
  hi: "{school} का पूरा स्टाफ़",
};

export const NOTICE_POSTED_SCHOOL: Line = {
  en: "Posted to the whole school: {title}.",
  ms: "Telah dihantar kepada seluruh sekolah: {title}.",
  "ms-arab": "تله دهانتر کڤد سلوروه سکوله: {title}.",
  ar: "تم النشر للمدرسة كلها: {title}.",
  fr: "Publié pour toute l'école : {title}.",
  es: "Publicado para toda la escuela: {title}.",
  pt: "Publicado para toda a escola: {title}.",
  te: "మొత్తం పాఠశాలకు పోస్ట్ చేశాను: {title}.",
  mr: "संपूर्ण शाळेसाठी पोस्ट केले: {title}.",
  hi: "पूरे स्कूल के लिए पोस्ट कर दिया: {title}।",
};

export const NOTICE_POSTED_STAFF: Line = {
  en: "Posted to all staff: {title}.",
  ms: "Telah dihantar kepada semua staf: {title}.",
  "ms-arab": "تله دهانتر کڤد سموا ستاف: {title}.",
  ar: "تم النشر لجميع الموظفين: {title}.",
  fr: "Publié pour tout le personnel : {title}.",
  es: "Publicado para todo el personal: {title}.",
  pt: "Publicado para toda a equipa: {title}.",
  te: "సిబ్బంది అందరికీ పోస్ట్ చేశాను: {title}.",
  mr: "सर्व कर्मचाऱ्यांसाठी पोस्ट केले: {title}.",
  hi: "सभी स्टाफ़ के लिए पोस्ट कर दिया: {title}।",
};

export const NOTICE_NO_STANDING: Line = {
  en: "Only the principal and coordinators post school notices.",
  ms: "Hanya pengetua dan penyelaras boleh menghantar notis sekolah.",
  "ms-arab": "هاڽ ڤڠتوا دان ڤپلارس بوليه مڠهانتر نوتيس سکوله.",
  ar: "ينشر إشعارات المدرسة المديرُ والمنسقون فقط.",
  fr: "Seuls la direction et les coordinateurs publient des avis de l'école.",
  es: "Solo la dirección y los coordinadores publican avisos de la escuela.",
  pt: "Só a direção e os coordenadores publicam avisos da escola.",
  te: "పాఠశాల నోటీసులను ప్రధానోపాధ్యాయులు మరియు సమన్వయకర్తలు మాత్రమే పోస్ట్ చేస్తారు.",
  mr: "शाळेच्या सूचना फक्त मुख्याध्यापक आणि समन्वयक पोस्ट करतात.",
  hi: "स्कूल की सूचनाएँ केवल प्रधानाचार्य और समन्वयक पोस्ट करते हैं।",
};

export const NOTICE_OFF: Line = {
  en: "School notices aren't switched on for your school.",
  ms: "Notis sekolah belum diaktifkan untuk sekolah anda.",
  "ms-arab": "نوتيس سکوله بلوم دأکتيفکن اونتوق سکوله اندا.",
  ar: "إشعارات المدرسة غير مفعّلة لمدرستك.",
  fr: "Les avis de l'école ne sont pas activés pour votre école.",
  es: "Los avisos escolares no están activados para su escuela.",
  pt: "Os avisos da escola não estão ativados para a sua escola.",
  te: "మీ పాఠశాలకు పాఠశాల నోటీసులు ఆన్ చేయబడలేదు.",
  mr: "तुमच्या शाळेसाठी शाळेच्या सूचना सुरू केलेल्या नाहीत.",
  hi: "आपके स्कूल के लिए स्कूल सूचनाएँ चालू नहीं हैं।",
};

export const NOTICE_WHAT_TO_SAY: Line = {
  en: "What should the notice say?",
  ms: "Apakah kandungan notis itu?",
  "ms-arab": "اڤاکه کندوڠن نوتيس ايت؟",
  ar: "ماذا يجب أن يقول الإشعار؟",
  fr: "Que doit dire l'avis ?",
  es: "¿Qué debe decir el aviso?",
  pt: "O que deve dizer o aviso?",
  te: "నోటీసులో ఏమి ఉండాలి?",
  mr: "सूचनेत काय लिहायचे?",
  hi: "सूचना में क्या लिखना है?",
};

export const NOTICE_TOO_LONG: Line = {
  en: "That notice is too long — a notice takes up to 4000 characters.",
  ms: "Notis itu terlalu panjang — notis boleh mengandungi sehingga 4000 aksara.",
  "ms-arab": "نوتيس ايت ترلالو ڤنجڠ — نوتيس بوليه مڠندوڠي سهيڠݢ 4000 اکسارا.",
  ar: "هذا الإشعار طويل جدًا — يتسع الإشعار لـ4000 حرف كحد أقصى.",
  fr: "Cet avis est trop long — un avis contient au plus 4000 caractères.",
  es: "Ese aviso es demasiado largo: un aviso admite hasta 4000 caracteres.",
  pt: "Esse aviso é demasiado longo — um aviso aceita até 4000 caracteres.",
  te: "ఆ నోటీసు చాలా పొడవుగా ఉంది — నోటీసులో 4000 అక్షరాల వరకు మాత్రమే ఉండవచ్చు.",
  mr: "ती सूचना खूप मोठी आहे — सूचनेत जास्तीत जास्त 4000 अक्षरे असू शकतात.",
  hi: "यह सूचना बहुत लंबी है — सूचना में अधिकतम 4000 अक्षर हो सकते हैं।",
};

export const NOTICE_DATE_UNPARSED: Line = {
  en: "I didn't catch the day \"{day}\" — say today, tomorrow, a weekday, or 2026-11-03.",
  ms: "Saya tidak faham hari \"{day}\" — sebut hari ini, esok, nama hari, atau 2026-11-03.",
  "ms-arab": "ساي تيدق فهم هاري \"{day}\" — سبوت هاري اين، ايسوق، نام هاري، اتاو 2026-11-03.",
  ar: "لم أفهم اليوم \"{day}\" — قل اليوم أو غدًا أو اسم يوم أو 2026-11-03.",
  fr: "Je n'ai pas compris le jour « {day} » — dites aujourd'hui, demain, un jour de la semaine ou 2026-11-03.",
  es: "No entendí el día \"{day}\": diga hoy, mañana, un día de la semana o 2026-11-03.",
  pt: "Não percebi o dia \"{day}\" — diga hoje, amanhã, um dia da semana ou 2026-11-03.",
  te: "\"{day}\" అనే రోజు నాకు అర్థం కాలేదు — ఈరోజు, రేపు, వారంలో ఒక రోజు లేదా 2026-11-03 అని చెప్పండి.",
  mr: "\"{day}\" हा दिवस मला समजला नाही — आज, उद्या, आठवड्याचा एखादा वार किंवा 2026-11-03 सांगा.",
  hi: "\"{day}\" दिन मुझे समझ नहीं आया — आज, कल, सप्ताह का कोई दिन या 2026-11-03 कहें।",
};

export const NOTICE_DATE_PASSED: Line = {
  en: "That day has already passed — a notice has to point at something still ahead.",
  ms: "Hari itu sudah berlalu — notis mesti merujuk kepada sesuatu yang belum berlaku.",
  "ms-arab": "هاري ايت سوده برلالو — نوتيس مستي مروجوق کڤد سسواتو يڠ بلوم برلاکو.",
  ar: "هذا اليوم قد مضى — يجب أن يشير الإشعار إلى أمر لم يحدث بعد.",
  fr: "Ce jour est déjà passé — un avis doit annoncer quelque chose à venir.",
  es: "Ese día ya pasó: un aviso debe referirse a algo que aún está por llegar.",
  pt: "Esse dia já passou — um aviso tem de apontar para algo que ainda vem.",
  te: "ఆ రోజు ఇప్పటికే గడిచిపోయింది — నోటీసు ఇంకా రాబోయే విషయాన్ని సూచించాలి.",
  mr: "तो दिवस आधीच गेला आहे — सूचना पुढे येणाऱ्या गोष्टीबद्दल असावी.",
  hi: "वह दिन बीत चुका है — सूचना किसी आने वाली बात के बारे में होनी चाहिए।",
};

/** The "who sees it" fallback when the school's name can't be read. */
export const NOTICE_YOUR_SCHOOL: Line = {
  en: "your school",
  ms: "sekolah anda",
  "ms-arab": "سکوله اندا",
  ar: "مدرستك",
  fr: "votre école",
  es: "su escuela",
  pt: "a sua escola",
  te: "మీ పాఠశాల",
  mr: "तुमची शाळा",
  hi: "आपका स्कूल",
};

/** Dictionary key (`sk.shell.notice.<key>`) → table, for the parity test. */
export const NOTICE_LINE_TABLES: Record<string, Line> = {
  cardTitleSchool: NOTICE_CARD_TITLE_SCHOOL,
  cardTitleStaff: NOTICE_CARD_TITLE_STAFF,
  seenSchool: NOTICE_SEEN_SCHOOL,
  seenStaff: NOTICE_SEEN_STAFF,
  postedSchool: NOTICE_POSTED_SCHOOL,
  postedStaff: NOTICE_POSTED_STAFF,
  noStanding: NOTICE_NO_STANDING,
  off: NOTICE_OFF,
  whatToSay: NOTICE_WHAT_TO_SAY,
  tooLong: NOTICE_TOO_LONG,
  dateUnparsed: NOTICE_DATE_UNPARSED,
  datePassed: NOTICE_DATE_PASSED,
  yourSchool: NOTICE_YOUR_SCHOOL,
};

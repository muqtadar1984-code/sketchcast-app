// SK's fixed lines for the S2 teacher actions (diary note, parent reminders),
// ten locales. The act route and the capabilities emit these themselves — NO
// model writes them — so, like lines.ts, the text is pinned here rather than
// read through the server-only dictionary loader. The same strings live in
// src/i18n/messages/*.json under `sk.shell.act.*`; act-lines.test.ts holds the
// two copies equal. Fill with `lineFor` (lines.ts).
//
// Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

/** The card title for a diary note: "Post to 7B's diary". */
export const DIARY_CARD_TITLE: Line = {
  en: "Post to {target}'s diary",
  ms: "Hantar ke diari {target}",
  "ms-arab": "هانتر ک دياري {target}",
  ar: "انشر في يوميات {target}",
  fr: "Publier dans le carnet de {target}",
  es: "Publicar en la agenda de {target}",
  pt: "Publicar na agenda de {target}",
  te: "{target} డైరీలో పోస్ట్ చేయండి",
  mr: "{target} च्या डायरीत पोस्ट करा",
  hi: "{target} की डायरी में पोस्ट करें",
};

export const DIARY_POSTED: Line = {
  en: "Posted to {target}'s diary.",
  ms: "Telah dihantar ke diari {target}.",
  "ms-arab": "تله دهانتر ک دياري {target}.",
  ar: "تم النشر في يوميات {target}.",
  fr: "Publié dans le carnet de {target}.",
  es: "Publicado en la agenda de {target}.",
  pt: "Publicado na agenda de {target}.",
  te: "{target} డైరీలో పోస్ట్ చేశాను.",
  mr: "{target} च्या डायरीत पोस्ट केले.",
  hi: "{target} की डायरी में पोस्ट कर दिया।",
};

export const REMIND_CARD_TITLE_ONE: Line = {
  en: "Remind the parents of 1 learner in {class}",
  ms: "Ingatkan ibu bapa 1 murid dalam {class}",
  "ms-arab": "ايڠتکن ايبو باڤ 1 موريد دالم {class}",
  ar: "ذكّر أولياء أمور طالب واحد في {class}",
  fr: "Relancer les parents d'un élève de {class}",
  es: "Recordar a los padres de 1 alumno de {class}",
  pt: "Lembrar os responsáveis de 1 aluno em {class}",
  te: "{class}లో 1 విద్యార్థి తల్లిదండ్రులకు గుర్తు చేయండి",
  mr: "{class} मधील 1 विद्यार्थ्याच्या पालकांना आठवण करून द्या",
  hi: "{class} के 1 विद्यार्थी के अभिभावकों को याद दिलाएँ",
};

/** "Remind the parents of 4 learners in 7B". */
export const REMIND_CARD_TITLE: Line = {
  en: "Remind the parents of {n} learners in {class}",
  ms: "Ingatkan ibu bapa {n} murid dalam {class}",
  "ms-arab": "ايڠتکن ايبو باڤ {n} موريد دالم {class}",
  ar: "ذكّر أولياء أمور {n} من الطلاب في {class}",
  fr: "Relancer les parents de {n} élèves de {class}",
  es: "Recordar a los padres de {n} alumnos de {class}",
  pt: "Lembrar os responsáveis de {n} alunos em {class}",
  te: "{class}లో {n} విద్యార్థుల తల్లిదండ్రులకు గుర్తు చేయండి",
  mr: "{class} मधील {n} विद्यार्थ्यांच्या पालकांना आठवण करून द्या",
  hi: "{class} के {n} विद्यार्थियों के अभिभावकों को याद दिलाएँ",
};

export const REMIND_SENT_ONE: Line = {
  en: "Sent a reminder to 1 family (diary).",
  ms: "Peringatan dihantar kepada 1 keluarga (diari).",
  "ms-arab": "ڤريڠتن دهانتر کڤد 1 کلوارݢ (دياري).",
  ar: "أُرسل تذكير إلى أسرة واحدة (اليوميات).",
  fr: "Rappel envoyé à 1 famille (carnet).",
  es: "Recordatorio enviado a 1 familia (agenda).",
  pt: "Lembrete enviado a 1 família (agenda).",
  te: "1 కుటుంబానికి గుర్తు పంపాను (డైరీ).",
  mr: "1 कुटुंबाला आठवण पाठवली (डायरी).",
  hi: "1 परिवार को याद दिलाने का संदेश भेजा (डायरी)।",
};

export const REMIND_SENT: Line = {
  en: "Sent reminders to {n} families (diary).",
  ms: "Peringatan dihantar kepada {n} keluarga (diari).",
  "ms-arab": "ڤريڠتن دهانتر کڤد {n} کلوارݢ (دياري).",
  ar: "أُرسلت تذكيرات إلى {n} من الأسر (اليوميات).",
  fr: "Rappels envoyés à {n} familles (carnet).",
  es: "Recordatorios enviados a {n} familias (agenda).",
  pt: "Lembretes enviados a {n} famílias (agenda).",
  te: "{n} కుటుంబాలకు గుర్తులు పంపాను (డైరీ).",
  mr: "{n} कुटुंबांना आठवणी पाठवल्या (डायरी).",
  hi: "{n} परिवारों को याद दिलाने के संदेश भेजे (डायरी)।",
};

export const REMIND_LEFT_OUT_DONE: Line = {
  en: "Left out {names}: already finished.",
  ms: "Tidak termasuk {names}: sudah selesai.",
  "ms-arab": "تيدق ترماسوق {names}: سوده سلساي.",
  ar: "استثنيت {names}: أنهوا بالفعل.",
  fr: "Non inclus : {names}, déjà terminé.",
  es: "Sin incluir a {names}: ya terminaron.",
  pt: "Não incluí {names}: já terminaram.",
  te: "{names}ని వదిలేశాను: ఇప్పటికే పూర్తి చేశారు.",
  mr: "{names} यांना वगळले: आधीच पूर्ण केले.",
  hi: "{names} को छोड़ दिया: पहले ही पूरा कर चुके हैं।",
};

export const REMIND_LEFT_OUT_GONE: Line = {
  en: "Left out {n} no longer in this class.",
  ms: "Tidak termasuk {n} yang tiada lagi dalam kelas ini.",
  "ms-arab": "تيدق ترماسوق {n} يڠ تيادا لاݢي دالم کلس اين.",
  ar: "استثنيت {n} لم يعودوا في هذا الصف.",
  fr: "Non inclus : {n} qui ne sont plus dans cette classe.",
  es: "Sin incluir a {n} que ya no están en esta clase.",
  pt: "Não incluí {n} que já não estão nesta turma.",
  te: "ఇకపై ఈ తరగతిలో లేని {n} మందిని వదిలేశాను.",
  mr: "आता या वर्गात नसलेल्या {n} जणांना वगळले.",
  hi: "{n} को छोड़ दिया जो अब इस कक्षा में नहीं हैं।",
};

export const REMIND_NONE_LEFT: Line = {
  en: "Everyone has finished now, so I sent no reminders.",
  ms: "Semua sudah selesai sekarang, jadi saya tidak menghantar sebarang peringatan.",
  "ms-arab": "سموا سوده سلساي سکارڠ، جادي ساي تيدق مڠهانتر سبارڠ ڤريڠتن.",
  ar: "أنهى الجميع الآن، لذا لم أرسل أي تذكير.",
  fr: "Tout le monde a terminé maintenant, je n'ai donc envoyé aucun rappel.",
  es: "Ya han terminado todos, así que no envié ningún recordatorio.",
  pt: "Já terminaram todos, por isso não enviei nenhum lembrete.",
  te: "ఇప్పుడు అందరూ పూర్తి చేశారు, కాబట్టి నేను ఎలాంటి గుర్తులూ పంపలేదు.",
  mr: "आता सर्वांनी पूर्ण केले आहे, म्हणून मी कोणतीही आठवण पाठवली नाही.",
  hi: "अब सबने पूरा कर लिया है, इसलिए मैंने कोई याद दिलाने का संदेश नहीं भेजा।",
};

export const REMIND_TOO_MANY: Line = {
  en: "That's more than {max} families — narrow it to one class.",
  ms: "Itu lebih daripada {max} keluarga — hadkan kepada satu kelas.",
  "ms-arab": "ايت لبيه درڤد {max} کلوارݢ — هادکن کڤد ساتو کلس.",
  ar: "هذا أكثر من {max} أسرة — اقصره على صف واحد.",
  fr: "Cela fait plus de {max} familles — limitez à une seule classe.",
  es: "Son más de {max} familias — limítalo a una clase.",
  pt: "São mais de {max} famílias — limite a uma turma.",
  te: "అది {max} కుటుంబాల కంటే ఎక్కువ — ఒక తరగతికి పరిమితం చేయండి.",
  mr: "हे {max} पेक्षा जास्त कुटुंबे आहेत — एका वर्गापुरते मर्यादित करा.",
  hi: "यह {max} से ज़्यादा परिवार हैं — इसे एक कक्षा तक सीमित करें।",
};

/** The default reminder each family receives. NO child names: one note per
 *  student goes out with the same text, so it says "your child". */
export const REMIND_BODY: Line = {
  en: 'Reminder: "{title}" is not done yet — due {due}. Please encourage your child to finish it.',
  ms: 'Peringatan: "{title}" belum disiapkan — tarikh akhir {due}. Sila galakkan anak anda untuk menyiapkannya.',
  "ms-arab": 'ڤريڠتن: "{title}" بلوم دسياڤکن — تاريخ اخير {due}. سيلا ݢالقکن انق اندا اونتوق مڽياڤکنڽ.',
  ar: 'تذكير: "{title}" لم يُنجز بعد — موعد التسليم {due}. يرجى تشجيع طفلكم على إنهائه.',
  fr: "Rappel : « {title} » n'est pas encore terminé — à rendre {due}. Merci d'encourager votre enfant à le terminer.",
  es: "Recordatorio: «{title}» aún no está hecho — entrega {due}. Por favor, anime a su hijo o hija a terminarlo.",
  pt: 'Lembrete: "{title}" ainda não foi feito — prazo {due}. Por favor, incentive o seu filho ou filha a terminá-lo.',
  te: 'గుర్తు: "{title}" ఇంకా పూర్తి కాలేదు — గడువు {due}. దయచేసి మీ పిల్లలను దాన్ని పూర్తి చేయమని ప్రోత్సహించండి.',
  mr: 'आठवण: "{title}" अजून पूर्ण झाले नाही — अंतिम मुदत {due}. कृपया आपल्या मुलाला ते पूर्ण करण्यासाठी प्रोत्साहन द्या.',
  hi: 'याद दिलाना: "{title}" अभी पूरा नहीं हुआ है — अंतिम तिथि {due}। कृपया अपने बच्चे को इसे पूरा करने के लिए प्रोत्साहित करें।',
};

export const REMIND_BODY_NO_DUE: Line = {
  en: 'Reminder: "{title}" is not done yet. Please encourage your child to finish it.',
  ms: 'Peringatan: "{title}" belum disiapkan. Sila galakkan anak anda untuk menyiapkannya.',
  "ms-arab": 'ڤريڠتن: "{title}" بلوم دسياڤکن. سيلا ݢالقکن انق اندا اونتوق مڽياڤکنڽ.',
  ar: 'تذكير: "{title}" لم يُنجز بعد. يرجى تشجيع طفلكم على إنهائه.',
  fr: "Rappel : « {title} » n'est pas encore terminé. Merci d'encourager votre enfant à le terminer.",
  es: "Recordatorio: «{title}» aún no está hecho. Por favor, anime a su hijo o hija a terminarlo.",
  pt: 'Lembrete: "{title}" ainda não foi feito. Por favor, incentive o seu filho ou filha a terminá-lo.',
  te: 'గుర్తు: "{title}" ఇంకా పూర్తి కాలేదు. దయచేసి మీ పిల్లలను దాన్ని పూర్తి చేయమని ప్రోత్సహించండి.',
  mr: 'आठवण: "{title}" अजून पूर्ण झाले नाही. कृपया आपल्या मुलाला ते पूर्ण करण्यासाठी प्रोत्साहन द्या.',
  hi: 'याद दिलाना: "{title}" अभी पूरा नहीं हुआ है। कृपया अपने बच्चे को इसे पूरा करने के लिए प्रोत्साहित करें।',
};

/** A write that failed AFTER the token was consumed (docs/sk-actions.md). */
export const ACT_WRITE_FAILED: Line = {
  en: "That didn't go through — nothing was changed. Ask me again.",
  ms: "Itu tidak berjaya — tiada apa-apa yang diubah. Tanya saya sekali lagi.",
  "ms-arab": "ايت تيدق برجاي — تيادا اڤ٢ يڠ دأوبه. تاڽ ساي سکالي لاݢي.",
  ar: "لم يتم ذلك — لم يتغير شيء. اطلب مني مرة أخرى.",
  fr: "Cela n'a pas abouti — rien n'a été modifié. Redemandez-moi.",
  es: "No se pudo hacer — no se cambió nada. Pídemelo de nuevo.",
  pt: "Não deu certo — nada foi alterado. Peça-me de novo.",
  te: "అది జరగలేదు — ఏమీ మారలేదు. మళ్ళీ అడగండి.",
  mr: "ते झाले नाही — काहीही बदलले नाही. मला पुन्हा विचारा.",
  hi: "यह नहीं हो पाया — कुछ भी नहीं बदला। मुझसे फिर से कहें।",
};

/** Dictionary key (`sk.shell.act.<key>`) → table, for the parity test. */
export const ACT_LINE_TABLES: Record<string, Line> = {
  diaryCardTitle: DIARY_CARD_TITLE,
  diaryPosted: DIARY_POSTED,
  remindCardTitleOne: REMIND_CARD_TITLE_ONE,
  remindCardTitle: REMIND_CARD_TITLE,
  remindSentOne: REMIND_SENT_ONE,
  remindSent: REMIND_SENT,
  remindLeftOutDone: REMIND_LEFT_OUT_DONE,
  remindLeftOutGone: REMIND_LEFT_OUT_GONE,
  remindNoneLeft: REMIND_NONE_LEFT,
  remindTooMany: REMIND_TOO_MANY,
  remindBody: REMIND_BODY,
  remindBodyNoDue: REMIND_BODY_NO_DUE,
  writeFailed: ACT_WRITE_FAILED,
};

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

// ── S2 slice B: marking + lesson prep ─────────────────────────────────────

/** "Ali's worksheet" — a learner's worksheet, as SK names it. */
export const MARK_WHAT_WORKSHEET: Line = {
  en: "{learner}'s worksheet",
  ms: "lembaran kerja {learner}",
  "ms-arab": "لمبارن کرجا {learner}",
  ar: "ورقة عمل {learner}",
  fr: "la fiche d'exercices de {learner}",
  es: "la hoja de trabajo de {learner}",
  pt: "a ficha de trabalho de {learner}",
  te: "{learner} వర్క్‌షీట్",
  mr: "{learner} यांची कार्यपत्रिका",
  hi: "{learner} की वर्कशीट",
};

/** "Ali's test paper". */
export const MARK_WHAT_TEST: Line = {
  en: "{learner}'s test paper",
  ms: "kertas ujian {learner}",
  "ms-arab": "کرتس اوجين {learner}",
  ar: "ورقة اختبار {learner}",
  fr: "l'épreuve de {learner}",
  es: "el examen de {learner}",
  pt: "o teste de {learner}",
  te: "{learner} పరీక్ష పత్రం",
  mr: "{learner} यांची चाचणी पत्रिका",
  hi: "{learner} का टेस्ट पेपर",
};

/** "Ali's work" — any other kind that was handed in. */
export const MARK_WHAT_OTHER: Line = {
  en: "{learner}'s work",
  ms: "kerja {learner}",
  "ms-arab": "کرجا {learner}",
  ar: "عمل {learner}",
  fr: "le travail de {learner}",
  es: "el trabajo de {learner}",
  pt: "o trabalho de {learner}",
  te: "{learner} పని",
  mr: "{learner} यांचे काम",
  hi: "{learner} का काम",
};

/** marking.next: "Ali's worksheet, Plant and Animal Cells — 3 more after this." */
export const MARK_NEXT: Line = {
  en: "{what}, {kit} — {n} more after this.",
  ms: "{what}, {kit} — {n} lagi selepas ini.",
  "ms-arab": "{what}، {kit} — {n} لاݢي سلڤس اين.",
  ar: "{what}، {kit} — بقي {n} بعد هذا.",
  fr: "{what}, {kit} — encore {n} après celle-ci.",
  es: "{what}, {kit} — quedan {n} después de esta.",
  pt: "{what}, {kit} — faltam mais {n} depois desta.",
  te: "{what}, {kit} — దీని తర్వాత ఇంకా {n} ఉన్నాయి.",
  mr: "{what}, {kit} — यानंतर आणखी {n}.",
  hi: "{what}, {kit} — इसके बाद {n} और।",
};

/** marking.next when it is the only one left. */
export const MARK_NEXT_LAST: Line = {
  en: "{what}, {kit} — the last one to mark.",
  ms: "{what}, {kit} — yang terakhir untuk ditanda.",
  "ms-arab": "{what}، {kit} — يڠ ترأخير اونتوق دتندا.",
  ar: "{what}، {kit} — آخر ما يحتاج إلى تصحيح.",
  fr: "{what}, {kit} — la dernière à corriger.",
  es: "{what}, {kit} — la última por corregir.",
  pt: "{what}, {kit} — a última para corrigir.",
  te: "{what}, {kit} — దిద్దాల్సినది ఇదే చివరిది.",
  mr: "{what}, {kit} — तपासण्यासाठी हे शेवटचे.",
  hi: "{what}, {kit} — जाँचने के लिए यह आख़िरी है।",
};

/** marking.next with an empty queue. */
export const MARK_EMPTY: Line = {
  en: "Nothing to mark — you're all caught up.",
  ms: "Tiada apa-apa untuk ditanda — semuanya sudah selesai.",
  "ms-arab": "تيادا اڤ٢ اونتوق دتندا — سمواڽ سوده سلساي.",
  ar: "لا يوجد شيء للتصحيح — أنهيت كل شيء.",
  fr: "Rien à corriger — vous êtes à jour.",
  es: "Nada que corregir — estás al día.",
  pt: "Nada para corrigir — está tudo em dia.",
  te: "దిద్దాల్సింది ఏమీ లేదు — అన్నీ పూర్తయ్యాయి.",
  mr: "तपासण्यासाठी काहीही नाही — सर्व पूर्ण झाले आहे.",
  hi: "जाँचने के लिए कुछ नहीं है — सब पूरा हो गया है।",
};

/** The marking.grade card title: "Grade Ali's worksheet". */
export const MARK_CARD_TITLE: Line = {
  en: "Grade {what}",
  ms: "Gred {what}",
  "ms-arab": "ݢريد {what}",
  ar: "قيّم {what}",
  fr: "Noter {what}",
  es: "Calificar {what}",
  pt: "Avaliar {what}",
  te: "{what}కి గ్రేడ్ ఇవ్వండి",
  mr: "{what} ला गुण द्या",
  hi: "{what} को ग्रेड दें",
};

/** marking.grade done. */
export const MARK_GRADED: Line = {
  en: "Graded {learner}: {score}/{outOf}.",
  ms: "{learner} telah digred: {score}/{outOf}.",
  "ms-arab": "{learner} تله دݢريد: {score}/{outOf}.",
  ar: "تم تقييم {learner}: {score}/{outOf}.",
  fr: "{learner} noté(e) : {score}/{outOf}.",
  es: "Calificado {learner}: {score}/{outOf}.",
  pt: "Avaliado {learner}: {score}/{outOf}.",
  te: "{learner}కి గ్రేడ్ ఇచ్చాను: {score}/{outOf}.",
  mr: "{learner} यांना गुण दिले: {score}/{outOf}.",
  hi: "{learner} को ग्रेड दिया: {score}/{outOf}।",
};

/** After a grade: SK offers the next one in the queue. */
export const MARK_OFFER_NEXT: Line = {
  en: "Next: {what} — say “next one” to see it.",
  ms: "Seterusnya: {what} — sebut “yang seterusnya” untuk melihatnya.",
  "ms-arab": "ستروسڽ: {what} — سبوت “يڠ ستروسڽ” اونتوق مليهتڽ.",
  ar: "التالي: {what} — قل «التالي» لعرضه.",
  fr: "Suivant : {what} — dites « la suivante » pour la voir.",
  es: "Siguiente: {what} — di «la siguiente» para verla.",
  pt: "Próximo: {what} — diga «o próximo» para o ver.",
  te: "తర్వాత: {what} — చూడటానికి “తర్వాతది” అని చెప్పండి.",
  mr: "पुढे: {what} — पाहण्यासाठी “पुढचे” म्हणा.",
  hi: "अगला: {what} — देखने के लिए “अगला” कहें।",
};

/** After a grade, when the queue is now empty. */
export const MARK_ALL_DONE: Line = {
  en: "That was the last one to mark.",
  ms: "Itu yang terakhir untuk ditanda.",
  "ms-arab": "ايت يڠ ترأخير اونتوق دتندا.",
  ar: "كان ذلك آخر ما يحتاج إلى تصحيح.",
  fr: "C'était la dernière à corriger.",
  es: "Era la última por corregir.",
  pt: "Era a última para corrigir.",
  te: "దిద్దాల్సిన వాటిలో అదే చివరిది.",
  mr: "तपासण्यासाठी ते शेवटचे होते.",
  hi: "जाँचने के लिए वह आख़िरी था।",
};

/** marking.grade on a submission someone already graded. */
export const MARK_ALREADY_GRADED: Line = {
  en: "That one is already graded.",
  ms: "Yang itu sudah digred.",
  "ms-arab": "يڠ ايت سوده دݢريد.",
  ar: "تم تقييم هذا بالفعل.",
  fr: "Celle-ci est déjà notée.",
  es: "Ese ya está calificado.",
  pt: "Esse já foi avaliado.",
  te: "దానికి ఇప్పటికే గ్రేడ్ ఇచ్చారు.",
  mr: "त्याला आधीच गुण दिले आहेत.",
  hi: "उसे पहले ही ग्रेड दिया जा चुका है।",
};

/** The lesson.prepare card title. */
export const PREP_CARD_TITLE: Line = {
  en: "Prepare a kit: {chapter}",
  ms: "Sediakan kit: {chapter}",
  "ms-arab": "سدياکن کيت: {chapter}",
  ar: "جهّز حزمة: {chapter}",
  fr: "Préparer un kit : {chapter}",
  es: "Preparar un kit: {chapter}",
  pt: "Preparar um kit: {chapter}",
  te: "కిట్ సిద్ధం చేయండి: {chapter}",
  mr: "किट तयार करा: {chapter}",
  hi: "किट तैयार करें: {chapter}",
};

/** The card title with the day she said ("for Friday") — recorded, never scheduled. */
export const PREP_CARD_TITLE_FOR: Line = {
  en: "Prepare a kit: {chapter} (for {when})",
  ms: "Sediakan kit: {chapter} (untuk {when})",
  "ms-arab": "سدياکن کيت: {chapter} (اونتوق {when})",
  ar: "جهّز حزمة: {chapter} (لـ {when})",
  fr: "Préparer un kit : {chapter} (pour {when})",
  es: "Preparar un kit: {chapter} (para {when})",
  pt: "Preparar um kit: {chapter} (para {when})",
  te: "కిట్ సిద్ధం చేయండి: {chapter} ({when} కోసం)",
  mr: "किट तयार करा: {chapter} ({when} साठी)",
  hi: "किट तैयार करें: {chapter} ({when} के लिए)",
};

/** lesson.prepare done. */
export const PREP_STARTED: Line = {
  en: "Started the kit for {chapter} — about 10 minutes. Ask me how it's going, or find it in your Library.",
  ms: "Kit untuk {chapter} telah dimulakan — kira-kira 10 minit. Tanya saya perkembangannya, atau cari dalam Perpustakaan anda.",
  "ms-arab": "کيت اونتوق {chapter} تله دمولاکن — کيرا٢ 10 مينيت. تاڽ ساي ڤرکمباڠنڽ، اتاو چاري دالم ڤرڤوستاکاءن اندا.",
  ar: "بدأت الحزمة لـ {chapter} — نحو 10 دقائق. اسألني عن تقدّمها، أو ابحث عنها في مكتبتك.",
  fr: "Kit lancé pour {chapter} — environ 10 minutes. Demandez-moi où il en est, ou retrouvez-le dans votre bibliothèque.",
  es: "He empezado el kit de {chapter} — unos 10 minutos. Pregúntame cómo va, o búscalo en tu biblioteca.",
  pt: "Comecei o kit de {chapter} — cerca de 10 minutos. Pergunte-me como está a correr, ou procure-o na sua biblioteca.",
  te: "{chapter} కోసం కిట్ ప్రారంభించాను — సుమారు 10 నిమిషాలు. అది ఎలా సాగుతోందో నన్ను అడగండి, లేదా మీ లైబ్రరీలో చూడండి.",
  mr: "{chapter} साठी किट सुरू केले — सुमारे 10 मिनिटे. ते कसे चालले आहे ते मला विचारा, किंवा तुमच्या लायब्ररीत पाहा.",
  hi: "{chapter} के लिए किट शुरू कर दिया — लगभग 10 मिनट। मुझसे पूछें कि यह कैसा चल रहा है, या इसे अपनी लाइब्रेरी में देखें।",
};

/** lesson.prepare when she already has a kit for that chapter (no card). */
export const PREP_EXISTS: Line = {
  en: "You already have that kit — want me to open it?",
  ms: "Anda sudah ada kit itu — mahu saya bukakan?",
  "ms-arab": "اندا سوده اد کيت ايت — ماهو ساي بوکاکن؟",
  ar: "لديك هذه الحزمة بالفعل — هل أفتحها لك؟",
  fr: "Vous avez déjà ce kit — voulez-vous que je l'ouvre ?",
  es: "Ya tienes ese kit — ¿quieres que lo abra?",
  pt: "Já tem esse kit — quer que o abra?",
  te: "ఆ కిట్ మీ దగ్గర ఇప్పటికే ఉంది — నేను దాన్ని తెరవనా?",
  mr: "ते किट तुमच्याकडे आधीच आहे — मी ते उघडू का?",
  hi: "वह किट आपके पास पहले से है — क्या मैं उसे खोलूँ?",
};

/** Refused by fair_use_cap (monthly / trial / school-trial allowance used up). */
export const PREP_NO_CREDITS: Line = {
  en: "You're out of credits for this month.",
  ms: "Kredit anda untuk bulan ini sudah habis.",
  "ms-arab": "کريديت اندا اونتوق بولن اين سوده هابيس.",
  ar: "نفدت أرصدتك لهذا الشهر.",
  fr: "Vous n'avez plus de crédits pour ce mois-ci.",
  es: "Te has quedado sin créditos este mes.",
  pt: "Ficou sem créditos este mês.",
  te: "ఈ నెలకు మీ క్రెడిట్‌లు అయిపోయాయి.",
  mr: "या महिन्याचे तुमचे क्रेडिट संपले आहेत.",
  hi: "इस महीने के आपके क्रेडिट ख़त्म हो गए हैं।",
};

/** Refused by gen_write / can_use_book (RLS). */
export const PREP_NOT_ON_SHELF: Line = {
  en: "That book isn't on your shelf.",
  ms: "Buku itu tiada dalam rak anda.",
  "ms-arab": "بوکو ايت تيادا دالم رق اندا.",
  ar: "هذا الكتاب ليس على رفّك.",
  fr: "Ce livre n'est pas dans votre bibliothèque.",
  es: "Ese libro no está en tu estantería.",
  pt: "Esse livro não está na sua estante.",
  te: "ఆ పుస్తకం మీ షెల్ఫ్‌లో లేదు.",
  mr: "ते पुस्तक तुमच्या शेल्फवर नाही.",
  hi: "वह किताब आपकी शेल्फ़ पर नहीं है।",
};

/** Refused by duplicate_guard (the same kit queued under 10 s ago). */
export const PREP_JUST_STARTED: Line = {
  en: "That was just started — give it a moment.",
  ms: "Itu baru sahaja dimulakan — tunggu sebentar.",
  "ms-arab": "ايت بارو سهاج دمولاکن — توڠݢو سبنتر.",
  ar: "بدأ ذلك للتو — امنحه لحظة.",
  fr: "Il vient d'être lancé — patientez un instant.",
  es: "Se acaba de iniciar — dale un momento.",
  pt: "Acabou de ser iniciado — aguarde um momento.",
  te: "అది ఇప్పుడే ప్రారంభమైంది — కొంచెం ఆగండి.",
  mr: "ते आत्ताच सुरू झाले आहे — थोडा वेळ द्या.",
  hi: "यह अभी-अभी शुरू हुआ है — थोड़ा रुकिए।",
};

/** Refused by the trial pin (beta_generation_cap) or the console chapter cap. */
export const PREP_TRIAL: Line = {
  en: "Your free trial includes one kit for one part of a chapter, so I can't start this one.",
  ms: "Percubaan percuma anda merangkumi satu kit untuk satu bahagian bab, jadi saya tidak boleh memulakan yang ini.",
  "ms-arab": "ڤرچوباءن ڤرچوما اندا مرڠکومي ساتو کيت اونتوق ساتو بهاݢين باب، جادي ساي تيدق بوليه ممولاکن يڠ اين.",
  ar: "تجربتك المجانية تشمل حزمة واحدة لجزء واحد من فصل، لذا لا يمكنني بدء هذه.",
  fr: "Votre essai gratuit comprend un kit pour une partie d'un chapitre, je ne peux donc pas lancer celui-ci.",
  es: "Tu prueba gratuita incluye un kit para una parte de un capítulo, así que no puedo iniciar este.",
  pt: "O seu teste gratuito inclui um kit para uma parte de um capítulo, por isso não posso iniciar este.",
  te: "మీ ఉచిత ట్రయల్‌లో ఒక అధ్యాయంలోని ఒక భాగానికి ఒక కిట్ మాత్రమే ఉంటుంది, కాబట్టి దీన్ని ప్రారంభించలేను.",
  mr: "तुमच्या मोफत चाचणीत एका प्रकरणाच्या एका भागासाठी एकच किट आहे, म्हणून मी हे सुरू करू शकत नाही.",
  hi: "आपके मुफ़्त ट्रायल में एक अध्याय के एक भाग के लिए एक ही किट है, इसलिए मैं इसे शुरू नहीं कर सकता।",
};

/** Refused by generations_part_map_guard (the book is being re-read). */
export const PREP_BOOK_BUSY: Line = {
  en: "That book is being re-read — try again in a few minutes.",
  ms: "Buku itu sedang dibaca semula — cuba lagi dalam beberapa minit.",
  "ms-arab": "بوکو ايت سدڠ دباچ سمولا — چوبا لاݢي دالم ببراڤ مينيت.",
  ar: "يُعاد قراءة هذا الكتاب الآن — حاول مجددًا بعد بضع دقائق.",
  fr: "Ce livre est en cours de relecture — réessayez dans quelques minutes.",
  es: "Ese libro se está releyendo — inténtalo de nuevo en unos minutos.",
  pt: "Esse livro está a ser relido — tente de novo daqui a uns minutos.",
  te: "ఆ పుస్తకాన్ని మళ్ళీ చదువుతున్నాం — కొన్ని నిమిషాల్లో మళ్ళీ ప్రయత్నించండి.",
  mr: "ते पुस्तक पुन्हा वाचले जात आहे — काही मिनिटांनी पुन्हा प्रयत्न करा.",
  hi: "वह किताब फिर से पढ़ी जा रही है — कुछ मिनट बाद फिर कोशिश करें।",
};

/** Refused by lesson tools off, a suspended or expired school. */
export const PREP_NO_ACCESS: Line = {
  en: "Your account can't start new kits right now — contact support.",
  ms: "Akaun anda tidak boleh memulakan kit baharu sekarang — hubungi sokongan.",
  "ms-arab": "اکاٴون اندا تيدق بوليه ممولاکن کيت بهارو سکارڠ — هوبوڠي سوکوڠن.",
  ar: "لا يمكن لحسابك بدء حزم جديدة الآن — تواصل مع الدعم.",
  fr: "Votre compte ne peut pas lancer de nouveaux kits pour le moment — contactez l'assistance.",
  es: "Tu cuenta no puede iniciar kits nuevos ahora mismo — contacta con soporte.",
  pt: "A sua conta não pode iniciar novos kits neste momento — contacte o suporte.",
  te: "మీ ఖాతా ఇప్పుడు కొత్త కిట్‌లను ప్రారంభించలేదు — సపోర్ట్‌ను సంప్రదించండి.",
  mr: "तुमचे खाते सध्या नवीन किट सुरू करू शकत नाही — सपोर्टशी संपर्क साधा.",
  hi: "आपका खाता अभी नए किट शुरू नहीं कर सकता — सपोर्ट से संपर्क करें।",
};

/** The card's warning for a book the junk-upload gate flagged (soft; confirming proceeds). */
export const PREP_GATE_WARNING: Line = {
  en: "This upload may not be a textbook — the kit may come out poorly.",
  ms: "Muat naik ini mungkin bukan buku teks — kit mungkin kurang baik.",
  "ms-arab": "موات نايق اين موڠکين بوکن بوکو تيکس — کيت موڠکين کورڠ باءيق.",
  ar: "قد لا يكون هذا الملف كتابًا مدرسيًا — قد تخرج الحزمة ضعيفة.",
  fr: "Ce fichier n'est peut-être pas un manuel — le kit risque d'être médiocre.",
  es: "Puede que este archivo no sea un libro de texto — el kit podría salir mal.",
  pt: "Este ficheiro pode não ser um manual — o kit pode sair fraco.",
  te: "ఈ అప్‌లోడ్ పాఠ్యపుస్తకం కాకపోవచ్చు — కిట్ సరిగా రాకపోవచ్చు.",
  mr: "हे अपलोड पाठ्यपुस्तक नसू शकते — किट नीट तयार होणार नाही असे होऊ शकते.",
  hi: "यह अपलोड शायद पाठ्यपुस्तक नहीं है — किट ठीक से नहीं बन सकता।",
};

/** The greeting's lead line when an SK-started kit has finished (S2 tray). */
export const KIT_READY_NOTICE: Line = {
  en: "Your kit for {chapter} is ready — want me to open it?",
  ms: "Kit anda untuk {chapter} sudah siap — mahu saya bukakannya?",
  "ms-arab": "کيت اندا اونتوق {chapter} سوده سياڤ — ماهو ساي بوکاکنڽ؟",
  ar: "حزمتك لـ {chapter} جاهزة — هل أفتحها لك؟",
  fr: "Votre kit pour {chapter} est prêt — voulez-vous que je l'ouvre ?",
  es: "Tu kit de {chapter} está listo — ¿quieres que lo abra?",
  pt: "O seu kit de {chapter} está pronto — quer que o abra?",
  te: "{chapter} కోసం మీ కిట్ సిద్ధంగా ఉంది — నేను దాన్ని తెరవనా?",
  mr: "{chapter} साठी तुमचे किट तयार आहे — मी ते उघडू का?",
  hi: "{chapter} के लिए आपकी किट तैयार है — क्या मैं उसे खोल दूँ?",
};

/** The greeting's lead line when an SK-started kit failed. */
export const KIT_FAILED_NOTICE: Line = {
  en: "The kit for {chapter} didn't finish — ask me to try again, or check the Library.",
  ms: "Kit untuk {chapter} tidak berjaya disiapkan — minta saya cuba lagi, atau semak Perpustakaan.",
  "ms-arab": "کيت اونتوق {chapter} تيدق برجاي دسياڤکن — مينتا ساي چوبا لاݢي، اتاو سمق ڤرڤوستاکاءن.",
  ar: "لم تكتمل حزمة {chapter} — اطلب مني المحاولة مجددًا، أو راجع المكتبة.",
  fr: "Le kit pour {chapter} n'a pas abouti — demandez-moi de réessayer, ou consultez la bibliothèque.",
  es: "El kit de {chapter} no se terminó — pídeme que lo intente de nuevo, o revisa la biblioteca.",
  pt: "O kit de {chapter} não foi concluído — peça-me para tentar de novo, ou veja a biblioteca.",
  te: "{chapter} కిట్ పూర్తి కాలేదు — మళ్లీ ప్రయత్నించమని నన్ను అడగండి, లేదా లైబ్రరీలో చూడండి.",
  mr: "{chapter} चे किट पूर्ण झाले नाही — मला पुन्हा प्रयत्न करायला सांगा, किंवा लायब्ररी पाहा.",
  hi: "{chapter} की किट पूरी नहीं हुई — मुझसे फिर से कोशिश करने को कहें, या लाइब्रेरी देखें।",
};

/** A "no" to the greeting's "want me to open it?". */
export const KIT_OFFER_DECLINED: Line = {
  en: "All right — it's in your Library whenever you need it.",
  ms: "Baiklah — ia ada dalam Perpustakaan anda bila-bila masa anda perlukan.",
  "ms-arab": "باءيقله — اي اد دالم ڤرڤوستاکاءن اندا بيلا٢ ماس اندا ڤرلوکن.",
  ar: "حسنًا — ستجدها في مكتبتك متى احتجت إليها.",
  fr: "D'accord — il est dans votre bibliothèque quand vous en aurez besoin.",
  es: "De acuerdo — está en tu biblioteca cuando lo necesites.",
  pt: "Muito bem — está na sua biblioteca sempre que precisar.",
  te: "సరే — మీకు అవసరమైనప్పుడు అది మీ లైబ్రరీలో ఉంటుంది.",
  mr: "ठीक आहे — तुम्हाला हवे तेव्हा ते तुमच्या लायब्ररीत आहे.",
  hi: "ठीक है — जब भी ज़रूरत हो, वह आपकी लाइब्रेरी में है।",
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
  markWhatWorksheet: MARK_WHAT_WORKSHEET,
  markWhatTest: MARK_WHAT_TEST,
  markWhatOther: MARK_WHAT_OTHER,
  markNext: MARK_NEXT,
  markNextLast: MARK_NEXT_LAST,
  markEmpty: MARK_EMPTY,
  markCardTitle: MARK_CARD_TITLE,
  markGraded: MARK_GRADED,
  markOfferNext: MARK_OFFER_NEXT,
  markAllDone: MARK_ALL_DONE,
  markAlreadyGraded: MARK_ALREADY_GRADED,
  prepCardTitle: PREP_CARD_TITLE,
  prepCardTitleFor: PREP_CARD_TITLE_FOR,
  prepStarted: PREP_STARTED,
  prepExists: PREP_EXISTS,
  prepNoCredits: PREP_NO_CREDITS,
  prepNotOnShelf: PREP_NOT_ON_SHELF,
  prepJustStarted: PREP_JUST_STARTED,
  prepTrial: PREP_TRIAL,
  prepBookBusy: PREP_BOOK_BUSY,
  prepNoAccess: PREP_NO_ACCESS,
  prepGateWarning: PREP_GATE_WARNING,
  kitReadyNotice: KIT_READY_NOTICE,
  kitFailedNotice: KIT_FAILED_NOTICE,
  kitOfferDeclined: KIT_OFFER_DECLINED,
};

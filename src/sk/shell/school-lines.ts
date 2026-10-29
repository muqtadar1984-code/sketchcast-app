// SK's fixed lines for the S5 LEADER reads (school.health, and the school /
// scope modes of learners.risk, assignments.status and timetable.now_next),
// ten locales. The capabilities write these themselves — a principal's or a
// coordinator's rules-routed answer is deterministic, so every number in it is
// a fact — and the same strings live in src/i18n/messages/*.json under
// `sk.shell.school.*`; school-lines.test.ts holds the two copies equal. Fill
// with `lineFor` (lines.ts).
//
// Counts are written "label n" / "label: n" so no locale needs plural forms.
// {where} always sits mid-sentence (it is "the school" or a scope label).
// Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

export const S_NO_SCOPE: Line = {
  en: "You hold no coordinator scope in this school, so I have nothing to show.",
  ms: "Anda tiada skop penyelaras di sekolah ini, jadi tiada apa-apa untuk ditunjukkan.",
  "ms-arab": "اندا تيادا سکوڤ ڤڽلارس د سکوله اين، جادي تيادا اڤ٢ اونتوق دتونجوقکن.",
  ar: "ليس لديك نطاق منسّق في هذه المدرسة، لذا لا يوجد ما أعرضه.",
  fr: "Vous n'avez aucun périmètre de coordination dans cette école : je n'ai rien à afficher.",
  es: "No tienes ningún ámbito de coordinación en esta escuela, así que no tengo nada que mostrar.",
  pt: "Não tem nenhum âmbito de coordenação nesta escola, por isso não tenho nada para mostrar.",
  te: "ఈ పాఠశాలలో మీకు సమన్వయకర్త పరిధి లేదు, కాబట్టి చూపించడానికి ఏమీ లేదు.",
  mr: "या शाळेत तुमच्याकडे समन्वयक कार्यक्षेत्र नाही, त्यामुळे दाखवण्यासारखे काही नाही.",
  hi: "इस स्कूल में आपके पास समन्वयक दायरा नहीं है, इसलिए दिखाने को कुछ नहीं है।",
};

export const S_READ_FAILED: Line = {
  en: "I could not read the school data right now.",
  ms: "Saya tidak dapat membaca data sekolah sekarang.",
  "ms-arab": "ساي تيدق داڤت ممباچ دات سکوله سکارڠ.",
  ar: "تعذّر عليّ قراءة بيانات المدرسة الآن.",
  fr: "Je n'arrive pas à lire les données de l'école pour le moment.",
  es: "No he podido leer los datos de la escuela ahora mismo.",
  pt: "Não consegui ler os dados da escola neste momento.",
  te: "ప్రస్తుతం పాఠశాల డేటాను చదవలేకపోయాను.",
  mr: "आत्ता शाळेचा डेटा वाचता आला नाही.",
  hi: "अभी स्कूल का डेटा पढ़ नहीं पाया।",
};

export const S_WHERE_SCHOOL: Line = {
  en: "the school",
  ms: "sekolah",
  "ms-arab": "سکوله",
  ar: "المدرسة",
  fr: "l'école",
  es: "la escuela",
  pt: "a escola",
  te: "పాఠశాల",
  mr: "शाळा",
  hi: "स्कूल",
};

export const S_WHERE_GRADE: Line = {
  en: "grade {grade}",
  ms: "tahun {grade}",
  "ms-arab": "تاهون {grade}",
  ar: "الصف {grade}",
  fr: "le niveau {grade}",
  es: "el curso {grade}",
  pt: "o ano {grade}",
  te: "తరగతి {grade}",
  mr: "इयत्ता {grade}",
  hi: "कक्षा {grade}",
};

export const S_OUT_OF_SCOPE: Line = {
  en: "{grade} is outside your scope ({scope}), so I can't show it.",
  ms: "{grade} di luar skop anda ({scope}), jadi saya tidak boleh menunjukkannya.",
  "ms-arab": "{grade} د لوار سکوڤ اندا ({scope})، جادي ساي تيدق بوليه منونجوقکنڽ.",
  ar: "{grade} خارج نطاقك ({scope})، لذا لا يمكنني عرضه.",
  fr: "{grade} est hors de votre périmètre ({scope}) : je ne peux pas l'afficher.",
  es: "{grade} está fuera de tu ámbito ({scope}), así que no puedo mostrarlo.",
  pt: "{grade} está fora do seu âmbito ({scope}), por isso não o posso mostrar.",
  te: "{grade} మీ పరిధి ({scope}) బయట ఉంది, కాబట్టి చూపించలేను.",
  mr: "{grade} तुमच्या कार्यक्षेत्राबाहेर ({scope}) आहे, त्यामुळे दाखवू शकत नाही.",
  hi: "{grade} आपके दायरे ({scope}) से बाहर है, इसलिए नहीं दिखा सकता।",
};

export const S_NOT_YET: Line = {
  en: "not yet",
  ms: "belum ada",
  "ms-arab": "بلوم اد",
  ar: "لا يوجد بعد",
  fr: "pas encore",
  es: "aún no",
  pt: "ainda não",
  te: "ఇంకా లేదు",
  mr: "अजून नाही",
  hi: "अभी नहीं",
};

export const S_EMPTY: Line = {
  en: "There are no classes in {where} to report on yet.",
  ms: "Belum ada kelas dalam {where} untuk dilaporkan.",
  "ms-arab": "بلوم اد کلس دالم {where} اونتوق دلاڤورکن.",
  ar: "لا توجد فصول في {where} للإبلاغ عنها بعد.",
  fr: "Il n'y a encore aucune classe dans {where} sur laquelle faire un point.",
  es: "Aún no hay clases en {where} sobre las que informar.",
  pt: "Ainda não há turmas em {where} para relatar.",
  te: "{where}లో నివేదించడానికి ఇంకా తరగతులు లేవు.",
  mr: "{where} मध्ये अहवाल देण्यासाठी अजून वर्ग नाहीत.",
  hi: "{where} में रिपोर्ट करने के लिए अभी कोई कक्षा नहीं है।",
};

export const S_OVERVIEW: Line = {
  en: "Overview for {where}: learners {students}, classes {classes}, teachers {teachers}. Active in the last 14 days: {active}. Work done: {completion}. At risk: {atRisk}. Overdue: {overdue}. Awaiting marking: {pending}.",
  ms: "Gambaran keseluruhan {where}: murid {students}, kelas {classes}, guru {teachers}. Aktif dalam 14 hari lepas: {active}. Kerja siap: {completion}. Berisiko: {atRisk}. Lewat: {overdue}. Menunggu penandaan: {pending}.",
  "ms-arab": "ݢمبارن کسلوروهن {where}: موريد {students}، کلس {classes}، ݢورو {teachers}. اکتيف دالم 14 هاري لڤس: {active}. کرجا سياڤ: {completion}. برايسيکو: {atRisk}. ليوت: {overdue}. منوڠݢو ڤناندان: {pending}.",
  ar: "نظرة عامة على {where}: المتعلمون {students}، الفصول {classes}، المعلمون {teachers}. النشطون في آخر 14 يومًا: {active}. العمل المنجز: {completion}. المعرّضون للخطر: {atRisk}. المتأخر: {overdue}. بانتظار التصحيح: {pending}.",
  fr: "Vue d'ensemble de {where} : élèves {students}, classes {classes}, enseignants {teachers}. Actifs ces 14 derniers jours : {active}. Travail fait : {completion}. À risque : {atRisk}. En retard : {overdue}. À corriger : {pending}.",
  es: "Resumen de {where}: alumnos {students}, clases {classes}, docentes {teachers}. Activos en los últimos 14 días: {active}. Trabajo hecho: {completion}. En riesgo: {atRisk}. Atrasado: {overdue}. Por corregir: {pending}.",
  pt: "Visão geral de {where}: alunos {students}, turmas {classes}, professores {teachers}. Ativos nos últimos 14 dias: {active}. Trabalho feito: {completion}. Em risco: {atRisk}. Em atraso: {overdue}. Por corrigir: {pending}.",
  te: "{where} అవలోకనం: విద్యార్థులు {students}, తరగతులు {classes}, ఉపాధ్యాయులు {teachers}. గత 14 రోజుల్లో చురుకుగా: {active}. పూర్తైన పని: {completion}. ప్రమాదంలో: {atRisk}. గడువు దాటినవి: {overdue}. దిద్దడానికి వేచి ఉన్నవి: {pending}.",
  mr: "{where} चा आढावा: विद्यार्थी {students}, वर्ग {classes}, शिक्षक {teachers}. गेल्या 14 दिवसांत सक्रिय: {active}. पूर्ण झालेले काम: {completion}. धोक्यात: {atRisk}. मुदत उलटलेले: {overdue}. तपासणी बाकी: {pending}.",
  hi: "{where} का सारांश: विद्यार्थी {students}, कक्षाएँ {classes}, शिक्षक {teachers}। पिछले 14 दिनों में सक्रिय: {active}। पूरा काम: {completion}। जोखिम में: {atRisk}। समय से पीछे: {overdue}। जाँच बाकी: {pending}।",
};

export const S_BY_GRADE: Line = {
  en: "At risk by grade: {items}.",
  ms: "Berisiko mengikut tahun: {items}.",
  "ms-arab": "برايسيکو مڠيکوت تاهون: {items}.",
  ar: "المعرّضون للخطر حسب الصف: {items}.",
  fr: "À risque par niveau : {items}.",
  es: "En riesgo por curso: {items}.",
  pt: "Em risco por ano: {items}.",
  te: "తరగతి వారీగా ప్రమాదంలో: {items}.",
  mr: "इयत्तेनुसार धोक्यात: {items}.",
  hi: "कक्षा के अनुसार जोखिम में: {items}।",
};

export const S_AT_RISK: Line = {
  en: "At risk in {where}: {n}. {items}.",
  ms: "Berisiko dalam {where}: {n}. {items}.",
  "ms-arab": "برايسيکو دالم {where}: {n}. {items}.",
  ar: "المعرّضون للخطر في {where}: {n}. {items}.",
  fr: "À risque dans {where} : {n}. {items}.",
  es: "En riesgo en {where}: {n}. {items}.",
  pt: "Em risco em {where}: {n}. {items}.",
  te: "{where}లో ప్రమాదంలో: {n}. {items}.",
  mr: "{where} मध्ये धोक्यात: {n}. {items}.",
  hi: "{where} में जोखिम में: {n}। {items}।",
};

export const S_AT_RISK_NONE: Line = {
  en: "Nobody in {where} is at risk by the school-health rules (learners: {students}).",
  ms: "Tiada sesiapa dalam {where} berisiko mengikut peraturan kesihatan sekolah (murid: {students}).",
  "ms-arab": "تيادا سسيڤا دالم {where} برايسيکو مڠيکوت ڤراتورن کصيحتن سکوله (موريد: {students}).",
  ar: "لا أحد في {where} معرّض للخطر وفق قواعد صحة المدرسة (المتعلمون: {students}).",
  fr: "Personne dans {where} n'est à risque selon les règles de suivi de l'école (élèves : {students}).",
  es: "Nadie en {where} está en riesgo según las reglas de seguimiento de la escuela (alumnos: {students}).",
  pt: "Ninguém em {where} está em risco segundo as regras de acompanhamento da escola (alunos: {students}).",
  te: "పాఠశాల ఆరోగ్య నియమాల ప్రకారం {where}లో ఎవరూ ప్రమాదంలో లేరు (విద్యార్థులు: {students}).",
  mr: "शाळा-आरोग्य नियमांनुसार {where} मध्ये कोणीही धोक्यात नाही (विद्यार्थी: {students}).",
  hi: "स्कूल-स्वास्थ्य नियमों के अनुसार {where} में कोई जोखिम में नहीं है (विद्यार्थी: {students})।",
};

export const S_TEACHERS: Line = {
  en: "Teachers flagged in {where}: {n}. {items}.",
  ms: "Guru yang ditandakan dalam {where}: {n}. {items}.",
  "ms-arab": "ݢورو يڠ دتنداکن دالم {where}: {n}. {items}.",
  ar: "المعلمون المُنبَّه عليهم في {where}: {n}. {items}.",
  fr: "Enseignants signalés dans {where} : {n}. {items}.",
  es: "Docentes señalados en {where}: {n}. {items}.",
  pt: "Professores assinalados em {where}: {n}. {items}.",
  te: "{where}లో గుర్తించబడిన ఉపాధ్యాయులు: {n}. {items}.",
  mr: "{where} मध्ये लक्ष वेधलेले शिक्षक: {n}. {items}.",
  hi: "{where} में चिह्नित शिक्षक: {n}। {items}।",
};

export const S_TEACHERS_NONE: Line = {
  en: "No teacher in {where} is flagged (teachers: {teachers}).",
  ms: "Tiada guru dalam {where} yang ditandakan (guru: {teachers}).",
  "ms-arab": "تيادا ݢورو دالم {where} يڠ دتنداکن (ݢورو: {teachers}).",
  ar: "لا يوجد معلم مُنبَّه عليه في {where} (المعلمون: {teachers}).",
  fr: "Aucun enseignant n'est signalé dans {where} (enseignants : {teachers}).",
  es: "Ningún docente está señalado en {where} (docentes: {teachers}).",
  pt: "Nenhum professor está assinalado em {where} (professores: {teachers}).",
  te: "{where}లో ఏ ఉపాధ్యాయుడూ గుర్తించబడలేదు (ఉపాధ్యాయులు: {teachers}).",
  mr: "{where} मध्ये कोणत्याही शिक्षकाकडे लक्ष वेधलेले नाही (शिक्षक: {teachers}).",
  hi: "{where} में कोई शिक्षक चिह्नित नहीं है (शिक्षक: {teachers})।",
};

export const S_ASSIGN: Line = {
  en: "Assignments in {where}: {n} across classes {classes}. Done {done} of {assigned} ({pct}%), not done {notDone}, overdue {overdue}, awaiting marking {pending}.",
  ms: "Tugasan dalam {where}: {n} merentas kelas {classes}. Siap {done} daripada {assigned} ({pct}%), belum siap {notDone}, lewat {overdue}, menunggu penandaan {pending}.",
  "ms-arab": "توݢسن دالم {where}: {n} مرنتس کلس {classes}. سياڤ {done} درڤد {assigned} ({pct}%)، بلوم سياڤ {notDone}، ليوت {overdue}، منوڠݢو ڤناندان {pending}.",
  ar: "الواجبات في {where}: {n} عبر الفصول {classes}. المنجز {done} من {assigned} ({pct}%)، غير المنجز {notDone}، المتأخر {overdue}، بانتظار التصحيح {pending}.",
  fr: "Devoirs dans {where} : {n} sur les classes {classes}. Faits {done} sur {assigned} ({pct} %), non faits {notDone}, en retard {overdue}, à corriger {pending}.",
  es: "Tareas en {where}: {n} en las clases {classes}. Hechas {done} de {assigned} ({pct}%), sin hacer {notDone}, atrasadas {overdue}, por corregir {pending}.",
  pt: "Trabalhos em {where}: {n} nas turmas {classes}. Feitos {done} de {assigned} ({pct}%), por fazer {notDone}, em atraso {overdue}, por corrigir {pending}.",
  te: "{where}లో అసైన్‌మెంట్లు: తరగతులు {classes} అంతటా {n}. పూర్తైనవి {assigned}లో {done} ({pct}%), పూర్తి కానివి {notDone}, గడువు దాటినవి {overdue}, దిద్దడానికి వేచి ఉన్నవి {pending}.",
  mr: "{where} मधील गृहपाठ: वर्ग {classes} मध्ये {n}. पूर्ण {assigned} पैकी {done} ({pct}%), अपूर्ण {notDone}, मुदत उलटलेले {overdue}, तपासणी बाकी {pending}.",
  hi: "{where} में असाइनमेंट: कक्षाओं {classes} में {n}। पूरे {assigned} में से {done} ({pct}%), अधूरे {notDone}, समय से पीछे {overdue}, जाँच बाकी {pending}।",
};

export const S_ASSIGN_NONE: Line = {
  en: "Nothing has been assigned in {where}.",
  ms: "Belum ada tugasan diberikan dalam {where}.",
  "ms-arab": "بلوم اد توݢسن دبريکن دالم {where}.",
  ar: "لم يُسنَد أي واجب في {where}.",
  fr: "Aucun devoir n'a été donné dans {where}.",
  es: "No se ha asignado nada en {where}.",
  pt: "Nada foi atribuído em {where}.",
  te: "{where}లో ఏమీ అసైన్ చేయలేదు.",
  mr: "{where} मध्ये काहीही दिलेले नाही.",
  hi: "{where} में कुछ भी असाइन नहीं किया गया है।",
};

export const S_TT_IN: Line = {
  en: "Now in {where} — {period} ({start}–{end}): lessons {n}. {items}.",
  ms: "Sekarang dalam {where} — {period} ({start}–{end}): pelajaran {n}. {items}.",
  "ms-arab": "سکارڠ دالم {where} — {period} ({start}–{end}): ڤلاجرن {n}. {items}.",
  ar: "الآن في {where} — {period} ({start}–{end}): الحصص {n}. {items}.",
  fr: "En ce moment dans {where} — {period} ({start}–{end}) : cours {n}. {items}.",
  es: "Ahora en {where} — {period} ({start}–{end}): clases {n}. {items}.",
  pt: "Agora em {where} — {period} ({start}–{end}): aulas {n}. {items}.",
  te: "ఇప్పుడు {where}లో — {period} ({start}–{end}): పాఠాలు {n}. {items}.",
  mr: "आत्ता {where} मध्ये — {period} ({start}–{end}): तासिका {n}. {items}.",
  hi: "अभी {where} में — {period} ({start}–{end}): पाठ {n}। {items}।",
};

export const S_TT_NEXT: Line = {
  en: "Next in {where} — {period} ({start}–{end}): lessons {n}. {items}.",
  ms: "Seterusnya dalam {where} — {period} ({start}–{end}): pelajaran {n}. {items}.",
  "ms-arab": "ستروسڽ دالم {where} — {period} ({start}–{end}): ڤلاجرن {n}. {items}.",
  ar: "التالي في {where} — {period} ({start}–{end}): الحصص {n}. {items}.",
  fr: "Ensuite dans {where} — {period} ({start}–{end}) : cours {n}. {items}.",
  es: "A continuación en {where} — {period} ({start}–{end}): clases {n}. {items}.",
  pt: "A seguir em {where} — {period} ({start}–{end}): aulas {n}. {items}.",
  te: "తరువాత {where}లో — {period} ({start}–{end}): పాఠాలు {n}. {items}.",
  mr: "पुढे {where} मध्ये — {period} ({start}–{end}): तासिका {n}. {items}.",
  hi: "अगला {where} में — {period} ({start}–{end}): पाठ {n}। {items}।",
};

export const S_TT_NONE: Line = {
  en: "No lessons are timetabled in {where} for {period}.",
  ms: "Tiada pelajaran dijadualkan dalam {where} untuk {period}.",
  "ms-arab": "تيادا ڤلاجرن دجدوالکن دالم {where} اونتوق {period}.",
  ar: "لا توجد حصص مجدولة في {where} لـ{period}.",
  fr: "Aucun cours n'est prévu dans {where} pour {period}.",
  es: "No hay clases programadas en {where} para {period}.",
  pt: "Não há aulas marcadas em {where} para {period}.",
  te: "{period}కి {where}లో పాఠాలు షెడ్యూల్ చేయలేదు.",
  mr: "{period} साठी {where} मध्ये कोणतीही तासिका वेळापत्रकात नाही.",
  hi: "{period} के लिए {where} में कोई पाठ समय-सारणी में नहीं है।",
};

export const S_TT_CLOSED: Line = {
  en: "No school periods are running right now.",
  ms: "Tiada waktu persekolahan berjalan sekarang.",
  "ms-arab": "تيادا وقتو ڤرسکولاهن برجالن سکارڠ.",
  ar: "لا توجد حصص مدرسية جارية الآن.",
  fr: "Aucune période de cours n'est en cours en ce moment.",
  es: "No hay ningún periodo de clase en curso ahora mismo.",
  pt: "Não há nenhum tempo letivo a decorrer neste momento.",
  te: "ప్రస్తుతం ఏ పాఠశాల పీరియడ్ జరగడం లేదు.",
  mr: "आत्ता शाळेची कोणतीही तासिका सुरू नाही.",
  hi: "अभी स्कूल का कोई पीरियड नहीं चल रहा है।",
};

/** Every line, keyed by its `sk.shell.school.*` dictionary key (the test walks this). */
export const SCHOOL_LINES: Record<string, Line> = {
  noScope: S_NO_SCOPE,
  readFailed: S_READ_FAILED,
  whereSchool: S_WHERE_SCHOOL,
  whereGrade: S_WHERE_GRADE,
  outOfScope: S_OUT_OF_SCOPE,
  notYet: S_NOT_YET,
  empty: S_EMPTY,
  overview: S_OVERVIEW,
  byGrade: S_BY_GRADE,
  atRisk: S_AT_RISK,
  atRiskNone: S_AT_RISK_NONE,
  teachers: S_TEACHERS,
  teachersNone: S_TEACHERS_NONE,
  assign: S_ASSIGN,
  assignNone: S_ASSIGN_NONE,
  ttIn: S_TT_IN,
  ttNext: S_TT_NEXT,
  ttNone: S_TT_NONE,
  ttClosed: S_TT_CLOSED,
};

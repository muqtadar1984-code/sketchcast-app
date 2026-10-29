// SK's fixed lines for the S4 PARENT reads (child.status, child.diary,
// child.notices, child.risk, child.progress, child.week), ten locales. The
// capabilities write these themselves — NO model writes a parent's answer — so,
// like act-lines.ts, the text is pinned here; the same strings live in
// src/i18n/messages/*.json under `sk.shell.parent.*` and parent-lines.test.ts
// holds the two copies equal. Fill with `lineFor` (lines.ts).
//
// Counts are written "label: n" so no locale needs plural forms.
// Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

export const P_NO_CHILDREN: Line = {
  en: "You have no linked children yet — add one on My Children.",
  ms: "Anda belum ada anak yang dipautkan — tambah seorang di Anak Saya.",
  "ms-arab": "اندا بلوم اد انق يڠ دڤاءوتکن — تمبه سأورڠ د انق ساي.",
  ar: "لا يوجد أطفال مرتبطون بحسابك بعد — أضف طفلًا من صفحة أطفالي.",
  fr: "Aucun enfant n'est encore lié à votre compte — ajoutez-en un dans Mes enfants.",
  es: "Aún no tienes hijos vinculados — añade uno en Mis hijos.",
  pt: "Ainda não tem filhos associados — adicione um em Os meus filhos.",
  te: "మీకు ఇంకా లింక్ చేసిన పిల్లలు లేరు — నా పిల్లలు పేజీలో జోడించండి.",
  mr: "तुमच्याशी अजून कोणतेही मूल जोडलेले नाही — माझी मुले पानावर जोडा.",
  hi: "आपसे अभी कोई बच्चा जुड़ा नहीं है — मेरे बच्चे पेज पर जोड़ें।",
};

export const P_NOT_LINKED: Line = {
  en: "That child isn't linked to your account, so I can't show anything about them.",
  ms: "Anak itu tidak dipautkan kepada akaun anda, jadi saya tidak boleh tunjukkan apa-apa tentangnya.",
  "ms-arab": "انق ايت تيدق دڤاءوتکن کڤد اکاءون اندا، جادي ساي تيدق بوليه تونجوقکن اڤ٢ تنتڠڽ.",
  ar: "هذا الطفل غير مرتبط بحسابك، لذا لا يمكنني عرض أي شيء عنه.",
  fr: "Cet enfant n'est pas lié à votre compte : je ne peux rien afficher à son sujet.",
  es: "Ese niño no está vinculado a tu cuenta, así que no puedo mostrar nada sobre él.",
  pt: "Essa criança não está associada à sua conta, por isso não posso mostrar nada sobre ela.",
  te: "ఆ పిల్లలు మీ ఖాతాకు లింక్ కాలేదు, కాబట్టి వారి గురించి నేను ఏమీ చూపించలేను.",
  mr: "ते मूल तुमच्या खात्याशी जोडलेले नाही, त्यामुळे मी त्याबद्दल काहीही दाखवू शकत नाही.",
  hi: "वह बच्चा आपके खाते से जुड़ा नहीं है, इसलिए मैं उसके बारे में कुछ नहीं दिखा सकता।",
};

export const P_UNVERIFIED: Line = {
  en: "{name}'s link isn't verified yet, so I can't show their work.",
  ms: "Pautan {name} belum disahkan, jadi saya tidak boleh tunjukkan kerjanya.",
  "ms-arab": "ڤاءوتن {name} بلوم دصحکن، جادي ساي تيدق بوليه تونجوقکن کرجاڽ.",
  ar: "لم يتم التحقق من ارتباط {name} بعد، لذا لا يمكنني عرض أعماله.",
  fr: "Le lien avec {name} n'est pas encore vérifié : je ne peux pas montrer son travail.",
  es: "El vínculo con {name} aún no está verificado, así que no puedo mostrar su trabajo.",
  pt: "A associação de {name} ainda não foi verificada, por isso não posso mostrar o trabalho.",
  te: "{name} లింక్ ఇంకా ధృవీకరించబడలేదు, కాబట్టి వారి పని చూపించలేను.",
  mr: "{name} ची जोडणी अजून पडताळलेली नाही, त्यामुळे मी काम दाखवू शकत नाही.",
  hi: "{name} का जुड़ाव अभी सत्यापित नहीं है, इसलिए मैं उनका काम नहीं दिखा सकता।",
};

export const P_WHICH_CHILD: Line = {
  en: "Which child do you mean — {names}?",
  ms: "Anak yang mana satu — {names}?",
  "ms-arab": "انق يڠ مان ساتو — {names}؟",
  ar: "أي طفل تقصد — {names}؟",
  fr: "De quel enfant parlez-vous — {names} ?",
  es: "¿A qué hijo te refieres — {names}?",
  pt: "De que filho está a falar — {names}?",
  te: "మీరు ఏ పిల్లల గురించి అడుగుతున్నారు — {names}?",
  mr: "तुम्ही कोणत्या मुलाबद्दल विचारत आहात — {names}?",
  hi: "आप किस बच्चे की बात कर रहे हैं — {names}?",
};

export const P_STATUS_NONE: Line = {
  en: "{name}: no shared work yet.",
  ms: "{name}: belum ada kerja yang dikongsi.",
  "ms-arab": "{name}: بلوم اد کرجا يڠ دکوڠسي.",
  ar: "{name}: لا توجد أعمال مشتركة بعد.",
  fr: "{name} : aucun travail partagé pour l'instant.",
  es: "{name}: todavía no hay trabajo compartido.",
  pt: "{name}: ainda não há trabalho partilhado.",
  te: "{name}: ఇంకా పంచుకున్న పని లేదు.",
  mr: "{name}: अजून कोणतेही काम दिलेले नाही.",
  hi: "{name}: अभी कोई साझा काम नहीं है।",
};

export const P_STATUS_LINE: Line = {
  en: "{name}: shared work {total} — done {done}, overdue {overdue}, awaiting marking {awaiting}.",
  ms: "{name}: kerja dikongsi {total} — siap {done}, lewat {overdue}, menunggu penandaan {awaiting}.",
  "ms-arab": "{name}: کرجا دکوڠسي {total} — سياڤ {done}، لوات {overdue}، منوڠݢو ڤنندأن {awaiting}.",
  ar: "{name}: الأعمال المشتركة {total} — المنجزة {done}، المتأخرة {overdue}، بانتظار التصحيح {awaiting}.",
  fr: "{name} : travaux partagés {total} — terminés {done}, en retard {overdue}, en attente de correction {awaiting}.",
  es: "{name}: trabajos compartidos {total} — hechos {done}, atrasados {overdue}, pendientes de corrección {awaiting}.",
  pt: "{name}: trabalhos partilhados {total} — feitos {done}, em atraso {overdue}, a aguardar correção {awaiting}.",
  te: "{name}: పంచుకున్న పనులు {total} — పూర్తి {done}, గడువు దాటినవి {overdue}, మార్కుల కోసం వేచి ఉన్నవి {awaiting}.",
  mr: "{name}: दिलेली कामे {total} — पूर्ण {done}, मुदत संपलेली {overdue}, तपासणी बाकी {awaiting}.",
  hi: "{name}: साझा काम {total} — पूरे {done}, देर से {overdue}, जाँच बाकी {awaiting}।",
};

export const P_OVERDUE_LIST: Line = {
  en: "Overdue: {items}.",
  ms: "Lewat: {items}.",
  "ms-arab": "لوات: {items}.",
  ar: "متأخر: {items}.",
  fr: "En retard : {items}.",
  es: "Atrasado: {items}.",
  pt: "Em atraso: {items}.",
  te: "గడువు దాటినవి: {items}.",
  mr: "मुदत संपलेली: {items}.",
  hi: "देर से: {items}।",
};

export const P_DUE_ON: Line = {
  en: "{title} (due {date})",
  ms: "{title} (tarikh akhir {date})",
  "ms-arab": "{title} (تاريخ اخير {date})",
  ar: "{title} (موعده {date})",
  fr: "{title} (pour le {date})",
  es: "{title} (entrega {date})",
  pt: "{title} (prazo {date})",
  te: "{title} (గడువు {date})",
  mr: "{title} (मुदत {date})",
  hi: "{title} (अंतिम तिथि {date})",
};

export const P_LATEST_SCORE: Line = {
  en: "Latest score: {title} {score}.",
  ms: "Markah terkini: {title} {score}.",
  "ms-arab": "مارکه ترکيني: {title} {score}.",
  ar: "آخر درجة: {title} {score}.",
  fr: "Dernière note : {title} {score}.",
  es: "Última nota: {title} {score}.",
  pt: "Última nota: {title} {score}.",
  te: "తాజా మార్కులు: {title} {score}.",
  mr: "नवीन गुण: {title} {score}.",
  hi: "नवीनतम अंक: {title} {score}।",
};

export const P_TEACHER_NOTE: Line = {
  en: "Teacher's note on {title}: \"{text}\"",
  ms: "Catatan guru tentang {title}: \"{text}\"",
  "ms-arab": "چاتتن ݢورو تنتڠ {title}: \"{text}\"",
  ar: "ملاحظة المعلم على {title}: \"{text}\"",
  fr: "Note de l'enseignant sur {title} : « {text} »",
  es: "Nota del docente sobre {title}: «{text}»",
  pt: "Nota do professor sobre {title}: «{text}»",
  te: "{title} పై ఉపాధ్యాయుల గమనిక: \"{text}\"",
  mr: "{title} वर शिक्षकांची टीप: \"{text}\"",
  hi: "{title} पर शिक्षक की टिप्पणी: \"{text}\"",
};

export const P_DIARY_NONE: Line = {
  en: "{name}: no diary notes in the last {days} days.",
  ms: "{name}: tiada catatan diari dalam {days} hari lepas.",
  "ms-arab": "{name}: تياد چاتتن دياري دالم {days} هاري لڤس.",
  ar: "{name}: لا توجد ملاحظات في اليوميات خلال آخر {days} يومًا.",
  fr: "{name} : aucune note dans le carnet ces {days} derniers jours.",
  es: "{name}: no hay notas en la agenda en los últimos {days} días.",
  pt: "{name}: sem notas na agenda nos últimos {days} dias.",
  te: "{name}: గత {days} రోజుల్లో డైరీ గమనికలు లేవు.",
  mr: "{name}: मागील {days} दिवसांत डायरीत नोंद नाही.",
  hi: "{name}: पिछले {days} दिनों में डायरी में कोई नोट नहीं।",
};

export const P_DIARY_LINE: Line = {
  en: "{name}: diary notes in the last {days} days: {n}. Latest, {date}: \"{text}\"",
  ms: "{name}: catatan diari dalam {days} hari lepas: {n}. Terkini, {date}: \"{text}\"",
  "ms-arab": "{name}: چاتتن دياري دالم {days} هاري لڤس: {n}. ترکيني، {date}: \"{text}\"",
  ar: "{name}: ملاحظات اليوميات خلال آخر {days} يومًا: {n}. الأحدث، {date}: \"{text}\"",
  fr: "{name} : notes du carnet ces {days} derniers jours : {n}. La plus récente, {date} : « {text} »",
  es: "{name}: notas de la agenda en los últimos {days} días: {n}. La más reciente, {date}: «{text}»",
  pt: "{name}: notas da agenda nos últimos {days} dias: {n}. A mais recente, {date}: «{text}»",
  te: "{name}: గత {days} రోజుల డైరీ గమనికలు: {n}. తాజాది, {date}: \"{text}\"",
  mr: "{name}: मागील {days} दिवसांतील डायरी नोंदी: {n}. नवीनतम, {date}: \"{text}\"",
  hi: "{name}: पिछले {days} दिनों के डायरी नोट: {n}। नवीनतम, {date}: \"{text}\"",
};

export const P_NOTICES_HOME: Line = {
  en: "Notices come from a school; {name} learns at home.",
  ms: "Notis datang daripada sekolah; {name} belajar di rumah.",
  "ms-arab": "نوتيس داتڠ درڤد سکوله؛ {name} بلاجر د رومه.",
  ar: "الإشعارات تصدر عن المدرسة، و{name} يتعلم في المنزل.",
  fr: "Les annonces viennent d'une école ; {name} apprend à la maison.",
  es: "Los avisos vienen de un colegio; {name} aprende en casa.",
  pt: "Os avisos vêm de uma escola; {name} aprende em casa.",
  te: "నోటీసులు పాఠశాల నుండి వస్తాయి; {name} ఇంట్లో నేర్చుకుంటున్నారు.",
  mr: "सूचना शाळेकडून येतात; {name} घरी शिकत आहे.",
  hi: "सूचनाएँ स्कूल से आती हैं; {name} घर पर पढ़ते हैं।",
};

export const P_NOTICES_NONE: Line = {
  en: "{name}'s school has no upcoming notices.",
  ms: "Sekolah {name} tiada notis akan datang.",
  "ms-arab": "سکوله {name} تياد نوتيس اکن داتڠ.",
  ar: "لا توجد إشعارات قادمة من مدرسة {name}.",
  fr: "L'école de {name} n'a aucune annonce à venir.",
  es: "El colegio de {name} no tiene avisos próximos.",
  pt: "A escola de {name} não tem avisos próximos.",
  te: "{name} పాఠశాల నుండి రాబోయే నోటీసులు లేవు.",
  mr: "{name} च्या शाळेकडून कोणतीही आगामी सूचना नाही.",
  hi: "{name} के स्कूल से कोई आगामी सूचना नहीं है।",
};

export const P_NOTICES_LINE: Line = {
  en: "{name}'s school: {items}.",
  ms: "Sekolah {name}: {items}.",
  "ms-arab": "سکوله {name}: {items}.",
  ar: "مدرسة {name}: {items}.",
  fr: "École de {name} : {items}.",
  es: "Colegio de {name}: {items}.",
  pt: "Escola de {name}: {items}.",
  te: "{name} పాఠశాల: {items}.",
  mr: "{name} ची शाळा: {items}.",
  hi: "{name} का स्कूल: {items}।",
};

export const P_RISK_AT_RISK: Line = {
  en: "{name} could use a hand: {reasons}.",
  ms: "{name} perlukan sedikit bantuan: {reasons}.",
  "ms-arab": "{name} ڤرلوکن سديکيت بنتوان: {reasons}.",
  ar: "{name} يحتاج إلى بعض المساعدة: {reasons}.",
  fr: "{name} aurait besoin d'un coup de main : {reasons}.",
  es: "{name} necesita una mano: {reasons}.",
  pt: "{name} precisa de uma ajuda: {reasons}.",
  te: "{name}కి కొంచెం సహాయం అవసరం: {reasons}.",
  mr: "{name} ला थोडी मदत हवी आहे: {reasons}.",
  hi: "{name} को थोड़ी मदद चाहिए: {reasons}।",
};

export const P_RISK_WELL: Line = {
  en: "{name} did well: {reasons}.",
  ms: "{name} menunjukkan prestasi baik: {reasons}.",
  "ms-arab": "{name} منونجوقکن ڤريستاسي باءيق: {reasons}.",
  ar: "أحسن {name}: {reasons}.",
  fr: "{name} a bien travaillé : {reasons}.",
  es: "{name} lo hizo bien: {reasons}.",
  pt: "{name} esteve bem: {reasons}.",
  te: "{name} బాగా చేశారు: {reasons}.",
  mr: "{name} ने चांगली कामगिरी केली: {reasons}.",
  hi: "{name} ने अच्छा किया: {reasons}।",
};

export const P_RISK_ON_TRACK: Line = {
  en: "{name} is on track — nothing flagged.",
  ms: "{name} berada di landasan yang betul — tiada yang perlu dirisaukan.",
  "ms-arab": "{name} برادا د لندسن يڠ بتول — تياد يڠ ڤرلو دريساءوکن.",
  ar: "{name} يسير على الطريق الصحيح — لا شيء يستدعي القلق.",
  fr: "{name} est sur la bonne voie — rien à signaler.",
  es: "{name} va bien — nada que señalar.",
  pt: "{name} está no bom caminho — nada a assinalar.",
  te: "{name} సరైన దారిలో ఉన్నారు — ఆందోళన కలిగించేది ఏమీ లేదు.",
  mr: "{name} योग्य मार्गावर आहे — काळजीचे काही नाही.",
  hi: "{name} सही राह पर हैं — चिंता की कोई बात नहीं।",
};

export const P_RISK_NO_WORK: Line = {
  en: "{name} has no shared work yet, so there is nothing to judge.",
  ms: "{name} belum ada kerja yang dikongsi, jadi belum ada apa-apa untuk dinilai.",
  "ms-arab": "{name} بلوم اد کرجا يڠ دکوڠسي، جادي بلوم اد اڤ٢ اونتوق دنيلاي.",
  ar: "لا توجد أعمال مشتركة لـ{name} بعد، فلا شيء يمكن تقييمه.",
  fr: "{name} n'a encore aucun travail partagé : rien à évaluer.",
  es: "{name} aún no tiene trabajo compartido, así que no hay nada que valorar.",
  pt: "{name} ainda não tem trabalho partilhado, por isso não há nada a avaliar.",
  te: "{name}కి ఇంకా పంచుకున్న పని లేదు, కాబట్టి అంచనా వేయడానికి ఏమీ లేదు.",
  mr: "{name} ला अजून कोणतेही काम दिलेले नाही, त्यामुळे मूल्यमापनासाठी काही नाही.",
  hi: "{name} के पास अभी कोई साझा काम नहीं है, इसलिए आँकने को कुछ नहीं।",
};

export const P_R_COMPLETION: Line = {
  en: "{pct}% of work done",
  ms: "{pct}% kerja siap",
  "ms-arab": "{pct}% کرجا سياڤ",
  ar: "أُنجز {pct}% من الأعمال",
  fr: "{pct} % du travail fait",
  es: "{pct} % del trabajo hecho",
  pt: "{pct}% do trabalho feito",
  te: "{pct}% పని పూర్తయింది",
  mr: "{pct}% काम पूर्ण",
  hi: "{pct}% काम पूरा",
};

export const P_R_INACTIVE: Line = {
  en: "no activity for {days} days",
  ms: "tiada aktiviti selama {days} hari",
  "ms-arab": "تياد اکتيۏيتي سلاما {days} هاري",
  ar: "لا نشاط منذ {days} يومًا",
  fr: "aucune activité depuis {days} jours",
  es: "sin actividad desde hace {days} días",
  pt: "sem atividade há {days} dias",
  te: "{days} రోజులుగా ఎలాంటి కార్యకలాపం లేదు",
  mr: "{days} दिवस कोणतीही हालचाल नाही",
  hi: "{days} दिनों से कोई गतिविधि नहीं",
};

export const P_R_NEVER: Line = {
  en: "has not started yet",
  ms: "belum bermula lagi",
  "ms-arab": "بلوم برمولا لاݢي",
  ar: "لم يبدأ بعد",
  fr: "n'a pas encore commencé",
  es: "aún no ha empezado",
  pt: "ainda não começou",
  te: "ఇంకా మొదలుపెట్టలేదు",
  mr: "अजून सुरुवात केलेली नाही",
  hi: "अभी शुरू नहीं किया",
};

export const P_R_AVG: Line = {
  en: "average score {pct}%",
  ms: "purata markah {pct}%",
  "ms-arab": "ڤوراتا مارکه {pct}%",
  ar: "متوسط الدرجات {pct}%",
  fr: "moyenne de {pct} %",
  es: "nota media {pct} %",
  pt: "nota média {pct}%",
  te: "సగటు మార్కులు {pct}%",
  mr: "सरासरी गुण {pct}%",
  hi: "औसत अंक {pct}%",
};

export const P_R_DECLINING: Line = {
  en: "scores going down",
  ms: "markah semakin menurun",
  "ms-arab": "مارکه سماکين منورون",
  ar: "الدرجات في تراجع",
  fr: "notes en baisse",
  es: "notas a la baja",
  pt: "notas a descer",
  te: "మార్కులు తగ్గుతున్నాయి",
  mr: "गुण कमी होत आहेत",
  hi: "अंक घट रहे हैं",
};

export const P_R_OVERDUE: Line = {
  en: "overdue: {n}",
  ms: "lewat: {n}",
  "ms-arab": "لوات: {n}",
  ar: "متأخر: {n}",
  fr: "en retard : {n}",
  es: "atrasados: {n}",
  pt: "em atraso: {n}",
  te: "గడువు దాటినవి: {n}",
  mr: "मुदत संपलेली: {n}",
  hi: "देर से: {n}",
};

export const P_PROGRESS_NONE: Line = {
  en: "{name} hasn't practised with SK yet, so there is no mastery to show.",
  ms: "{name} belum berlatih dengan SK, jadi belum ada penguasaan untuk ditunjukkan.",
  "ms-arab": "{name} بلوم برلاتيه دڠن SK، جادي بلوم اد ڤڠواسأن اونتوق دتونجوقکن.",
  ar: "لم يتدرب {name} مع SK بعد، لذا لا يوجد إتقان لعرضه.",
  fr: "{name} ne s'est pas encore exercé avec SK : aucune maîtrise à afficher.",
  es: "{name} aún no ha practicado con SK, así que no hay dominio que mostrar.",
  pt: "{name} ainda não praticou com o SK, por isso não há domínio a mostrar.",
  te: "{name} ఇంకా SKతో సాధన చేయలేదు, కాబట్టి చూపించడానికి ప్రావీణ్యం లేదు.",
  mr: "{name} ने अजून SK सोबत सराव केलेला नाही, त्यामुळे दाखवण्यासारखे प्रावीण्य नाही.",
  hi: "{name} ने अभी SK के साथ अभ्यास नहीं किया, इसलिए दिखाने को कोई महारत नहीं।",
};

export const P_PROGRESS_LINE: Line = {
  en: "{name}: mastered {mastered}, getting there {getting}, needs work {needs}.",
  ms: "{name}: dikuasai {mastered}, hampir dikuasai {getting}, perlu usaha {needs}.",
  "ms-arab": "{name}: دکواساءي {mastered}، همڤير دکواساءي {getting}، ڤرلو اوسها {needs}.",
  ar: "{name}: أتقنها {mastered}، يقترب منها {getting}، تحتاج إلى عمل {needs}.",
  fr: "{name} : maîtrisé {mastered}, presque {getting}, à retravailler {needs}.",
  es: "{name}: dominado {mastered}, casi {getting}, por reforzar {needs}.",
  pt: "{name}: dominado {mastered}, quase lá {getting}, a reforçar {needs}.",
  te: "{name}: ప్రావీణ్యం పొందినవి {mastered}, దగ్గరలో ఉన్నవి {getting}, సాధన అవసరమైనవి {needs}.",
  mr: "{name}: आत्मसात {mastered}, जवळपास {getting}, सराव हवा {needs}.",
  hi: "{name}: महारत {mastered}, लगभग {getting}, अभ्यास चाहिए {needs}।",
};

export const P_GROUP_MASTERED: Line = {
  en: "Mastered",
  ms: "Dikuasai",
  "ms-arab": "دکواساءي",
  ar: "أتقنها",
  fr: "Maîtrisé",
  es: "Dominado",
  pt: "Dominado",
  te: "ప్రావీణ్యం పొందినవి",
  mr: "आत्मसात",
  hi: "महारत",
};

export const P_GROUP_GETTING: Line = {
  en: "Getting there",
  ms: "Hampir dikuasai",
  "ms-arab": "همڤير دکواساءي",
  ar: "يقترب منها",
  fr: "Presque",
  es: "Casi",
  pt: "Quase lá",
  te: "దగ్గరలో ఉన్నవి",
  mr: "जवळपास",
  hi: "लगभग",
};

export const P_GROUP_NEEDS: Line = {
  en: "Needs work",
  ms: "Perlu usaha",
  "ms-arab": "ڤرلو اوسها",
  ar: "تحتاج إلى عمل",
  fr: "À retravailler",
  es: "Por reforzar",
  pt: "A reforçar",
  te: "సాధన అవసరమైనవి",
  mr: "सराव हवा",
  hi: "अभ्यास चाहिए",
};

export const P_GROUP_LIST: Line = {
  en: "{group}: {items}.",
  ms: "{group}: {items}.",
  "ms-arab": "{group}: {items}.",
  ar: "{group}: {items}.",
  fr: "{group} : {items}.",
  es: "{group}: {items}.",
  pt: "{group}: {items}.",
  te: "{group}: {items}.",
  mr: "{group}: {items}.",
  hi: "{group}: {items}।",
};

/** "This week: 3 done, 1 overdue (…), awaiting marking 1; mastered: 2 ideas; diary: 1 new note." */
export const P_WEEK_LINE: Line = {
  en: "{name} — this week: done {done}, overdue {overdue}{overdueItems}, awaiting marking {awaiting}; ideas mastered {mastered}; new diary notes {notes}.",
  ms: "{name} — minggu ini: siap {done}, lewat {overdue}{overdueItems}, menunggu penandaan {awaiting}; idea dikuasai {mastered}; catatan diari baharu {notes}.",
  "ms-arab": "{name} — ميڠݢو اين: سياڤ {done}، لوات {overdue}{overdueItems}، منوڠݢو ڤنندأن {awaiting}؛ ايديا دکواساءي {mastered}؛ چاتتن دياري بهارو {notes}.",
  ar: "{name} — هذا الأسبوع: المنجز {done}، المتأخر {overdue}{overdueItems}، بانتظار التصحيح {awaiting}؛ الأفكار المتقنة {mastered}؛ ملاحظات اليوميات الجديدة {notes}.",
  fr: "{name} — cette semaine : terminés {done}, en retard {overdue}{overdueItems}, en attente de correction {awaiting} ; notions maîtrisées {mastered} ; nouvelles notes du carnet {notes}.",
  es: "{name} — esta semana: hechos {done}, atrasados {overdue}{overdueItems}, pendientes de corrección {awaiting}; ideas dominadas {mastered}; notas nuevas en la agenda {notes}.",
  pt: "{name} — esta semana: feitos {done}, em atraso {overdue}{overdueItems}, a aguardar correção {awaiting}; ideias dominadas {mastered}; novas notas na agenda {notes}.",
  te: "{name} — ఈ వారం: పూర్తి {done}, గడువు దాటినవి {overdue}{overdueItems}, మార్కుల కోసం వేచి ఉన్నవి {awaiting}; ప్రావీణ్యం పొందిన అంశాలు {mastered}; కొత్త డైరీ గమనికలు {notes}.",
  mr: "{name} — या आठवड्यात: पूर्ण {done}, मुदत संपलेली {overdue}{overdueItems}, तपासणी बाकी {awaiting}; आत्मसात कल्पना {mastered}; डायरीतील नवीन नोंदी {notes}.",
  hi: "{name} — इस हफ़्ते: पूरे {done}, देर से {overdue}{overdueItems}, जाँच बाकी {awaiting}; महारत वाले विचार {mastered}; डायरी के नए नोट {notes}।",
};

export const P_WEEK_TODO: Line = {
  en: "What to do about it: {steps}.",
  ms: "Apa yang boleh dibuat: {steps}.",
  "ms-arab": "اڤ يڠ بوليه دبوات: {steps}.",
  ar: "ما الذي يمكن فعله: {steps}.",
  fr: "Que faire : {steps}.",
  es: "Qué hacer: {steps}.",
  pt: "O que fazer: {steps}.",
  te: "ఏం చేయాలి: {steps}.",
  mr: "काय करावे: {steps}.",
  hi: "क्या करें: {steps}।",
};

export const P_WEEK_NOTHING: Line = {
  en: "What to do about it: nothing urgent — keep going.",
  ms: "Apa yang boleh dibuat: tiada yang mendesak — teruskan.",
  "ms-arab": "اڤ يڠ بوليه دبوات: تياد يڠ مندسق — تروسکن.",
  ar: "ما الذي يمكن فعله: لا شيء عاجل — استمروا.",
  fr: "Que faire : rien d'urgent — continuez ainsi.",
  es: "Qué hacer: nada urgente — seguid así.",
  pt: "O que fazer: nada urgente — continuem assim.",
  te: "ఏం చేయాలి: అత్యవసరమైనది ఏమీ లేదు — ఇలాగే కొనసాగించండి.",
  mr: "काय करावे: काहीही तातडीचे नाही — असेच चालू ठेवा.",
  hi: "क्या करें: कुछ ज़रूरी नहीं — ऐसे ही जारी रखें।",
};

export const P_STEP_FINISH: Line = {
  en: "finish {title}",
  ms: "siapkan {title}",
  "ms-arab": "سياڤکن {title}",
  ar: "أكمل {title}",
  fr: "terminer {title}",
  es: "terminar {title}",
  pt: "terminar {title}",
  te: "{title} పూర్తి చేయండి",
  mr: "{title} पूर्ण करा",
  hi: "{title} पूरा करें",
};

export const P_STEP_FINISH_BY: Line = {
  en: "finish {title} before {date}",
  ms: "siapkan {title} sebelum {date}",
  "ms-arab": "سياڤکن {title} سبلوم {date}",
  ar: "أكمل {title} قبل {date}",
  fr: "terminer {title} avant le {date}",
  es: "terminar {title} antes del {date}",
  pt: "terminar {title} antes de {date}",
  te: "{date} లోపు {title} పూర్తి చేయండి",
  mr: "{date} पूर्वी {title} पूर्ण करा",
  hi: "{date} से पहले {title} पूरा करें",
};

export const P_STEP_REVISIT: Line = {
  en: "revisit \"{objective}\" in {kit}",
  ms: "ulang kaji \"{objective}\" dalam {kit}",
  "ms-arab": "اولڠ کاجي \"{objective}\" دالم {kit}",
  ar: "راجع \"{objective}\" في {kit}",
  fr: "revoir « {objective} » dans {kit}",
  es: "repasar «{objective}» en {kit}",
  pt: "rever «{objective}» em {kit}",
  te: "{kit}లో \"{objective}\" మళ్ళీ చూడండి",
  mr: "{kit} मधील \"{objective}\" पुन्हा पाहा",
  hi: "{kit} में \"{objective}\" दोबारा देखें",
};

export const P_STEP_GO_OVER: Line = {
  en: "go over {title} together",
  ms: "semak semula {title} bersama-sama",
  "ms-arab": "سمق سمولا {title} برسام٢",
  ar: "راجعا {title} معًا",
  fr: "revoir {title} ensemble",
  es: "repasar {title} juntos",
  pt: "rever {title} em conjunto",
  te: "{title}ని కలిసి మళ్ళీ చూడండి",
  mr: "{title} एकत्र पुन्हा पाहा",
  hi: "{title} को साथ में दोबारा देखें",
};

export const P_UNTITLED: Line = {
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

export const P_READ_FAILED: Line = {
  en: "I couldn't read {name}'s work right now.",
  ms: "Saya tidak dapat membaca kerja {name} sekarang.",
  "ms-arab": "ساي تيدق داڤت ممباچ کرجا {name} سکارڠ.",
  ar: "تعذّر عليّ قراءة أعمال {name} الآن.",
  fr: "Je n'arrive pas à lire le travail de {name} pour le moment.",
  es: "No he podido leer el trabajo de {name} ahora mismo.",
  pt: "Não consegui ler o trabalho de {name} neste momento.",
  te: "ఇప్పుడు {name} పనిని చదవలేకపోయాను.",
  mr: "मला आत्ता {name} चे काम वाचता आले नाही.",
  hi: "मैं अभी {name} का काम नहीं पढ़ पाया।",
};

// ── S4 slice C: the parent's diary note (diary.note, parent branch) ──────
// The card title, the refusals, and the line that says WHO WILL SEE the note
// (0066 dn_read: the child's teachers via teaches_student, the school's
// leaders via diary_leader_of, the child unless parents_only).

export const P_DIARY_CARD_TITLE: Line = {
  en: "Write in {name}'s diary",
  ms: "Tulis dalam diari {name}",
  "ms-arab": "توليس دالم دياري {name}",
  ar: "اكتب في يوميات {name}",
  fr: "Écrire dans le carnet de {name}",
  es: "Escribir en la agenda de {name}",
  pt: "Escrever na agenda de {name}",
  te: "{name} డైరీలో రాయండి",
  mr: "{name} च्या डायरीत लिहा",
  hi: "{name} की डायरी में लिखें",
};

export const P_DIARY_NO_CLASS: Line = {
  en: "A note from you goes to one child's diary, not a class — which child is it for?",
  ms: "Nota daripada anda masuk ke diari seorang anak, bukan kelas — untuk anak yang mana?",
  "ms-arab": "نوتا درڤد اندا ماسوق ک دياري سأورڠ انق، بوکن کلس — اونتوق انق يڠ مان؟",
  ar: "ملاحظتك تُكتب في يوميات طفل واحد، لا في صف كامل — لأي طفل هي؟",
  fr: "Votre note va dans le carnet d'un seul enfant, pas d'une classe — pour quel enfant ?",
  es: "Tu nota va a la agenda de un solo hijo, no de una clase: ¿para qué hijo es?",
  pt: "A sua nota vai para a agenda de um só filho, não de uma turma — para que filho é?",
  te: "మీ నోట్ ఒక్క పిల్లల డైరీకి వెళ్తుంది, తరగతికి కాదు — ఇది ఏ పిల్లల కోసం?",
  mr: "तुमची नोंद एका मुलाच्या डायरीत जाते, वर्गाच्या नाही — ती कोणत्या मुलासाठी आहे?",
  hi: "आपका नोट एक ही बच्चे की डायरी में जाता है, पूरी कक्षा में नहीं — यह किस बच्चे के लिए है?",
};

export const P_DIARY_UNVERIFIED: Line = {
  en: "{name}'s link isn't verified yet, so I can't write in their diary.",
  ms: "Pautan {name} belum disahkan, jadi saya tidak boleh menulis dalam diarinya.",
  "ms-arab": "ڤاءوتن {name} بلوم دصحکن، جادي ساي تيدق بوليه منوليس دالم دياريڽ.",
  ar: "لم يتم التحقق من ارتباط {name} بعد، لذا لا يمكنني الكتابة في يومياته.",
  fr: "Le lien avec {name} n'est pas encore vérifié : je ne peux pas écrire dans son carnet.",
  es: "El vínculo con {name} aún no está verificado, así que no puedo escribir en su agenda.",
  pt: "A associação de {name} ainda não foi verificada, por isso não posso escrever na agenda.",
  te: "{name} లింక్ ఇంకా ధృవీకరించబడలేదు, కాబట్టి వారి డైరీలో రాయలేను.",
  mr: "{name} ची जोडणी अजून पडताळलेली नाही, त्यामुळे मी डायरीत लिहू शकत नाही.",
  hi: "{name} का जुड़ाव अभी सत्यापित नहीं है, इसलिए मैं उनकी डायरी में नहीं लिख सकता।",
};

export const P_DIARY_SEEN_SCHOOL: Line = {
  en: "Seen by {name}'s teacher, the school's leaders and {name}.",
  ms: "Dilihat oleh guru {name}, pimpinan sekolah dan {name}.",
  "ms-arab": "دليهت اوليه ݢورو {name}، ڤيمڤينن سکوله دان {name}.",
  ar: "يراها معلم {name} وقيادة المدرسة و{name}.",
  fr: "Vue par l'enseignant de {name}, la direction de l'école et {name}.",
  es: "La ven el profesor de {name}, la dirección del colegio y {name}.",
  pt: "Vista pelo professor de {name}, pela direção da escola e por {name}.",
  te: "{name} ఉపాధ్యాయులు, పాఠశాల నాయకత్వం మరియు {name} చూస్తారు.",
  mr: "{name} चे शिक्षक, शाळेचे नेतृत्व आणि {name} पाहतील.",
  hi: "{name} के शिक्षक, स्कूल का नेतृत्व और {name} इसे देखेंगे।",
};

export const P_DIARY_SEEN_SCHOOL_PRIVATE: Line = {
  en: "Seen by {name}'s teacher and the school's leaders — not by {name}.",
  ms: "Dilihat oleh guru {name} dan pimpinan sekolah — bukan oleh {name}.",
  "ms-arab": "دليهت اوليه ݢورو {name} دان ڤيمڤينن سکوله — بوکن اوليه {name}.",
  ar: "يراها معلم {name} وقيادة المدرسة — ولا يراها {name}.",
  fr: "Vue par l'enseignant de {name} et la direction de l'école — pas par {name}.",
  es: "La ven el profesor de {name} y la dirección del colegio, pero no {name}.",
  pt: "Vista pelo professor de {name} e pela direção da escola — não por {name}.",
  te: "{name} ఉపాధ్యాయులు మరియు పాఠశాల నాయకత్వం చూస్తారు — {name} చూడరు.",
  mr: "{name} चे शिक्षक आणि शाळेचे नेतृत्व पाहतील — {name} नाही.",
  hi: "{name} के शिक्षक और स्कूल का नेतृत्व इसे देखेंगे — {name} नहीं।",
};

export const P_DIARY_SEEN_TEACHER: Line = {
  en: "Seen by {name}'s teacher and {name}.",
  ms: "Dilihat oleh guru {name} dan {name}.",
  "ms-arab": "دليهت اوليه ݢورو {name} دان {name}.",
  ar: "يراها معلم {name} و{name}.",
  fr: "Vue par l'enseignant de {name} et par {name}.",
  es: "La ven el profesor de {name} y {name}.",
  pt: "Vista pelo professor de {name} e por {name}.",
  te: "{name} ఉపాధ్యాయులు మరియు {name} చూస్తారు.",
  mr: "{name} चे शिक्षक आणि {name} पाहतील.",
  hi: "{name} के शिक्षक और {name} इसे देखेंगे।",
};

export const P_DIARY_SEEN_TEACHER_PRIVATE: Line = {
  en: "Seen by {name}'s teacher — not by {name}.",
  ms: "Dilihat oleh guru {name} — bukan oleh {name}.",
  "ms-arab": "دليهت اوليه ݢورو {name} — بوکن اوليه {name}.",
  ar: "يراها معلم {name} — ولا يراها {name}.",
  fr: "Vue par l'enseignant de {name} — pas par {name}.",
  es: "La ve el profesor de {name}, pero no {name}.",
  pt: "Vista pelo professor de {name} — não por {name}.",
  te: "{name} ఉపాధ్యాయులు చూస్తారు — {name} చూడరు.",
  mr: "{name} चे शिक्षक पाहतील — {name} नाही.",
  hi: "{name} के शिक्षक इसे देखेंगे — {name} नहीं।",
};

export const P_DIARY_SEEN_LEADERS: Line = {
  en: "{name} has no class teacher yet — seen by the school's leaders and {name}.",
  ms: "{name} belum ada guru kelas — dilihat oleh pimpinan sekolah dan {name}.",
  "ms-arab": "{name} بلوم اد ݢورو کلس — دليهت اوليه ڤيمڤينن سکوله دان {name}.",
  ar: "ليس لـ{name} معلم صف بعد — تراها قيادة المدرسة و{name}.",
  fr: "{name} n'a pas encore d'enseignant de classe — vue par la direction de l'école et par {name}.",
  es: "{name} aún no tiene profesor de clase: la ven la dirección del colegio y {name}.",
  pt: "{name} ainda não tem professor de turma — vista pela direção da escola e por {name}.",
  te: "{name}కి ఇంకా తరగతి ఉపాధ్యాయులు లేరు — పాఠశాల నాయకత్వం మరియు {name} చూస్తారు.",
  mr: "{name} ला अजून वर्गशिक्षक नाहीत — शाळेचे नेतृत्व आणि {name} पाहतील.",
  hi: "{name} के अभी कोई कक्षा शिक्षक नहीं हैं — स्कूल का नेतृत्व और {name} इसे देखेंगे।",
};

export const P_DIARY_SEEN_LEADERS_PRIVATE: Line = {
  en: "{name} has no class teacher yet — seen by the school's leaders, not by {name}.",
  ms: "{name} belum ada guru kelas — dilihat oleh pimpinan sekolah, bukan oleh {name}.",
  "ms-arab": "{name} بلوم اد ݢورو کلس — دليهت اوليه ڤيمڤينن سکوله، بوکن اوليه {name}.",
  ar: "ليس لـ{name} معلم صف بعد — تراها قيادة المدرسة، ولا يراها {name}.",
  fr: "{name} n'a pas encore d'enseignant de classe — vue par la direction de l'école, pas par {name}.",
  es: "{name} aún no tiene profesor de clase: la ve la dirección del colegio, pero no {name}.",
  pt: "{name} ainda não tem professor de turma — vista pela direção da escola, não por {name}.",
  te: "{name}కి ఇంకా తరగతి ఉపాధ్యాయులు లేరు — పాఠశాల నాయకత్వం చూస్తుంది, {name} చూడరు.",
  mr: "{name} ला अजून वर्गशिक्षक नाहीत — शाळेचे नेतृत्व पाहील, {name} नाही.",
  hi: "{name} के अभी कोई कक्षा शिक्षक नहीं हैं — स्कूल का नेतृत्व इसे देखेगा, {name} नहीं।",
};

export const P_DIARY_SEEN_HOME: Line = {
  en: "{name} learns at home — this note is for your own record and {name}.",
  ms: "{name} belajar di rumah — nota ini untuk rekod anda sendiri dan {name}.",
  "ms-arab": "{name} بلاجر د رومه — نوتا اين اونتوق ريکود اندا سنديري دان {name}.",
  ar: "{name} يتعلم في البيت — هذه الملاحظة لسجلك أنت ولـ{name}.",
  fr: "{name} apprend à la maison — cette note est pour votre propre suivi et pour {name}.",
  es: "{name} aprende en casa: esta nota es para tu propio registro y para {name}.",
  pt: "{name} aprende em casa — esta nota é para o seu próprio registo e para {name}.",
  te: "{name} ఇంటి వద్ద నేర్చుకుంటున్నారు — ఈ నోట్ మీ స్వంత రికార్డు కోసం మరియు {name} కోసం.",
  mr: "{name} घरी शिकतात — ही नोंद तुमच्या स्वतःच्या नोंदीसाठी आणि {name} साठी आहे.",
  hi: "{name} घर पर पढ़ते हैं — यह नोट आपके अपने रिकॉर्ड और {name} के लिए है।",
};

export const P_DIARY_SEEN_HOME_PRIVATE: Line = {
  en: "{name} learns at home — this note is for your own record only; {name} won't see it.",
  ms: "{name} belajar di rumah — nota ini untuk rekod anda sahaja; {name} tidak akan melihatnya.",
  "ms-arab": "{name} بلاجر د رومه — نوتا اين اونتوق ريکود اندا سهاج؛ {name} تيدق اکن مليهتڽ.",
  ar: "{name} يتعلم في البيت — هذه الملاحظة لسجلك أنت فقط؛ لن يراها {name}.",
  fr: "{name} apprend à la maison — cette note est pour votre seul suivi ; {name} ne la verra pas.",
  es: "{name} aprende en casa: esta nota es solo para tu registro; {name} no la verá.",
  pt: "{name} aprende em casa — esta nota é só para o seu registo; {name} não a verá.",
  te: "{name} ఇంటి వద్ద నేర్చుకుంటున్నారు — ఈ నోట్ మీ రికార్డు కోసం మాత్రమే; {name} దీన్ని చూడరు.",
  mr: "{name} घरी शिकतात — ही नोंद फक्त तुमच्या नोंदीसाठी आहे; {name} ती पाहणार नाहीत.",
  hi: "{name} घर पर पढ़ते हैं — यह नोट केवल आपके रिकॉर्ड के लिए है; {name} इसे नहीं देखेंगे।",
};

/** Dictionary key (`sk.shell.parent.<key>`) → table, for the parity test. */
export const PARENT_LINE_TABLES: Record<string, Line> = {
  noChildren: P_NO_CHILDREN,
  notLinked: P_NOT_LINKED,
  unverified: P_UNVERIFIED,
  whichChild: P_WHICH_CHILD,
  statusNone: P_STATUS_NONE,
  statusLine: P_STATUS_LINE,
  overdueList: P_OVERDUE_LIST,
  dueOn: P_DUE_ON,
  latestScore: P_LATEST_SCORE,
  teacherNote: P_TEACHER_NOTE,
  diaryNone: P_DIARY_NONE,
  diaryLine: P_DIARY_LINE,
  noticesHome: P_NOTICES_HOME,
  noticesNone: P_NOTICES_NONE,
  noticesLine: P_NOTICES_LINE,
  riskAtRisk: P_RISK_AT_RISK,
  riskWell: P_RISK_WELL,
  riskOnTrack: P_RISK_ON_TRACK,
  riskNoWork: P_RISK_NO_WORK,
  reasonCompletion: P_R_COMPLETION,
  reasonInactive: P_R_INACTIVE,
  reasonNeverStarted: P_R_NEVER,
  reasonAvgScore: P_R_AVG,
  reasonDeclining: P_R_DECLINING,
  reasonOverdue: P_R_OVERDUE,
  progressNone: P_PROGRESS_NONE,
  progressLine: P_PROGRESS_LINE,
  groupMastered: P_GROUP_MASTERED,
  groupGettingThere: P_GROUP_GETTING,
  groupNeedsWork: P_GROUP_NEEDS,
  groupList: P_GROUP_LIST,
  weekLine: P_WEEK_LINE,
  weekTodo: P_WEEK_TODO,
  weekNothing: P_WEEK_NOTHING,
  stepFinish: P_STEP_FINISH,
  stepFinishBy: P_STEP_FINISH_BY,
  stepRevisit: P_STEP_REVISIT,
  stepGoOver: P_STEP_GO_OVER,
  untitled: P_UNTITLED,
  readFailed: P_READ_FAILED,
  diaryCardTitle: P_DIARY_CARD_TITLE,
  diaryNoClass: P_DIARY_NO_CLASS,
  diaryUnverified: P_DIARY_UNVERIFIED,
  diarySeenSchool: P_DIARY_SEEN_SCHOOL,
  diarySeenSchoolPrivate: P_DIARY_SEEN_SCHOOL_PRIVATE,
  diarySeenTeacher: P_DIARY_SEEN_TEACHER,
  diarySeenTeacherPrivate: P_DIARY_SEEN_TEACHER_PRIVATE,
  diarySeenLeaders: P_DIARY_SEEN_LEADERS,
  diarySeenLeadersPrivate: P_DIARY_SEEN_LEADERS_PRIVATE,
  diarySeenHome: P_DIARY_SEEN_HOME,
  diarySeenHomePrivate: P_DIARY_SEEN_HOME_PRIVATE,
};

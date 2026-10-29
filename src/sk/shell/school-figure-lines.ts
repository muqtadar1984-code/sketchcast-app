// SK's fixed lines for the S5 slice C LEADER figures (school.seats,
// school.cost, school.gaps, school.trend), ten locales. Like school-lines.ts:
// the capabilities write these themselves — a leader's rules-routed answer is
// deterministic, so every number in it is a fact — and the same strings live
// in src/i18n/messages/*.json under `sk.shell.school.figures.*`;
// school-figures-rules.test.ts holds the two copies equal.
//
// Counts are written "label n" / "label: n" so no locale needs plural forms.
// Portuguese puts {where} in parentheses (no "de a escola" contraction).
// Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

// ── school.seats (principal only) ────────────────────────────────────────────

export const F_SEATS: Line = {
  en: "Your school: teachers {teachers}, students {students}, school admins {admins}.",
  ms: "Sekolah anda: guru {teachers}, murid {students}, pentadbir sekolah {admins}.",
  "ms-arab": "سکوله اندا: ݢورو {teachers}، موريد {students}، ڤنتدبير سکوله {admins}.",
  ar: "مدرستك: المعلمون {teachers}، الطلاب {students}، مديرو المدرسة {admins}.",
  fr: "Votre école : enseignants {teachers}, élèves {students}, administrateurs {admins}.",
  es: "Tu escuela: docentes {teachers}, alumnos {students}, administradores {admins}.",
  pt: "A sua escola: professores {teachers}, alunos {students}, administradores {admins}.",
  te: "మీ పాఠశాల: ఉపాధ్యాయులు {teachers}, విద్యార్థులు {students}, పాఠశాల నిర్వాహకులు {admins}.",
  mr: "तुमची शाळा: शिक्षक {teachers}, विद्यार्थी {students}, शाळा प्रशासक {admins}.",
  hi: "आपका स्कूल: शिक्षक {teachers}, विद्यार्थी {students}, स्कूल प्रशासक {admins}।",
};

export const F_SEATS_PLAN: Line = {
  en: "Licence: {plan}, status {status}, current period ends {end}.",
  ms: "Lesen: {plan}, status {status}, tempoh semasa tamat {end}.",
  "ms-arab": "ليسين: {plan}، ستاتوس {status}، تيمڤوه سماس تامت {end}.",
  ar: "الترخيص: {plan}، الحالة {status}، تنتهي الفترة الحالية في {end}.",
  fr: "Licence : {plan}, statut {status}, période en cours jusqu'au {end}.",
  es: "Licencia: {plan}, estado {status}, el periodo actual termina el {end}.",
  pt: "Licença: {plan}, estado {status}, o período atual termina a {end}.",
  te: "లైసెన్స్: {plan}, స్థితి {status}, ప్రస్తుత వ్యవధి ముగింపు {end}.",
  mr: "परवाना: {plan}, स्थिती {status}, चालू कालावधी संपतो {end}.",
  hi: "लाइसेंस: {plan}, स्थिति {status}, मौजूदा अवधि समाप्त {end}।",
};

export const F_SEATS_NO_LIMIT: Line = {
  en: "No seat limit is recorded for your school yet.",
  ms: "Belum ada had bilangan pengguna yang direkodkan untuk sekolah anda.",
  "ms-arab": "بلوم اد حد بيلڠن ڤڠݢونا يڠ دريکودکن اونتوق سکوله اندا.",
  ar: "لم يُسجَّل بعد حدّ للمقاعد لمدرستك.",
  fr: "Aucune limite de places n'est encore enregistrée pour votre école.",
  es: "Todavía no hay un límite de plazas registrado para tu escuela.",
  pt: "Ainda não há um limite de lugares registado para a sua escola.",
  te: "మీ పాఠశాలకు ఇంకా సీట్ల పరిమితి నమోదు కాలేదు.",
  mr: "तुमच्या शाळेसाठी अजून जागांची मर्यादा नोंदवलेली नाही.",
  hi: "आपके स्कूल के लिए अभी कोई सीट सीमा दर्ज नहीं है।",
};

export const F_SEATS_PRINCIPAL_ONLY: Line = {
  en: "School licence and seat figures are for the principal only.",
  ms: "Angka lesen dan pengguna sekolah hanya untuk pengetua.",
  "ms-arab": "اڠک ليسين دان ڤڠݢونا سکوله هاڽ اونتوق ڤڠتوا.",
  ar: "أرقام ترخيص المدرسة والمقاعد متاحة للمدير فقط.",
  fr: "Les chiffres de licence et de places sont réservés à la direction.",
  es: "Las cifras de licencia y plazas son solo para la dirección.",
  pt: "Os números de licença e lugares são apenas para a direção.",
  te: "పాఠశాల లైసెన్స్ మరియు సీట్ల వివరాలు ప్రధానోపాధ్యాయులకు మాత్రమే.",
  mr: "शाळेचा परवाना आणि जागांचे आकडे फक्त मुख्याध्यापकांसाठी आहेत.",
  hi: "स्कूल लाइसेंस और सीटों के आँकड़े केवल प्रधानाचार्य के लिए हैं।",
};

// ── school.cost ──────────────────────────────────────────────────────────────

export const F_COST: Line = {
  en: "Generation cost for {where}, last 30 days: kits {kits} (with cost recorded {costed}), {usd}.",
  ms: "Kos penjanaan bagi {where}, 30 hari lepas: kit {kits} (kos direkodkan {costed}), {usd}.",
  "ms-arab": "کوس ڤنجاناٴن باݢي {where}، 30 هاري لڤس: کيت {kits} (کوس دريکودکن {costed})، {usd}.",
  ar: "تكلفة الإنشاء في {where} خلال آخر 30 يومًا: الحزم {kits} (المسجّلة تكلفتها {costed})، {usd}.",
  fr: "Coût de génération pour {where}, 30 derniers jours : kits {kits} (avec coût enregistré {costed}), {usd}.",
  es: "Coste de generación de {where}, últimos 30 días: kits {kits} (con coste registrado {costed}), {usd}.",
  pt: "Custo de geração ({where}), últimos 30 dias: kits {kits} (com custo registado {costed}), {usd}.",
  te: "{where} తయారీ ఖర్చు, గత 30 రోజులు: కిట్లు {kits} (ఖర్చు నమోదైనవి {costed}), {usd}.",
  mr: "{where} चा निर्मिती खर्च, गेले 30 दिवस: किट {kits} (खर्च नोंदवलेले {costed}), {usd}.",
  hi: "{where} की निर्माण लागत, पिछले 30 दिन: किट {kits} (लागत दर्ज {costed}), {usd}।",
};

export const F_COST_SINCE: Line = {
  en: "Since cost tracking began on {date}: kits {kits} (with cost recorded {costed}), {usd}.",
  ms: "Sejak penjejakan kos bermula pada {date}: kit {kits} (kos direkodkan {costed}), {usd}.",
  "ms-arab": "سجق ڤنجيجقن کوس برمولا ڤد {date}: کيت {kits} (کوس دريکودکن {costed})، {usd}.",
  ar: "منذ بدء تتبّع التكلفة في {date}: الحزم {kits} (المسجّلة تكلفتها {costed})، {usd}.",
  fr: "Depuis le début du suivi des coûts le {date} : kits {kits} (avec coût enregistré {costed}), {usd}.",
  es: "Desde que empezó el seguimiento de costes el {date}: kits {kits} (con coste registrado {costed}), {usd}.",
  pt: "Desde o início do registo de custos a {date}: kits {kits} (com custo registado {costed}), {usd}.",
  te: "{date}న ఖర్చు ట్రాకింగ్ మొదలైనప్పటి నుండి: కిట్లు {kits} (ఖర్చు నమోదైనవి {costed}), {usd}.",
  mr: "{date} रोजी खर्चाचा मागोवा सुरू झाल्यापासून: किट {kits} (खर्च नोंदवलेले {costed}), {usd}.",
  hi: "{date} को लागत ट्रैकिंग शुरू होने से अब तक: किट {kits} (लागत दर्ज {costed}), {usd}।",
};

export const F_COST_TRACKING: Line = {
  en: "Cost tracking began on {date}, so kits made before then carry no cost.",
  ms: "Penjejakan kos bermula pada {date}, jadi kit yang dibuat sebelum itu tiada kos.",
  "ms-arab": "ڤنجيجقن کوس برمولا ڤد {date}، جادي کيت يڠ دبوات سبلوم ايت تيادا کوس.",
  ar: "بدأ تتبّع التكلفة في {date}، لذا لا تحمل الحزم المنشأة قبل ذلك أي تكلفة.",
  fr: "Le suivi des coûts a commencé le {date} : les kits antérieurs n'ont pas de coût.",
  es: "El seguimiento de costes empezó el {date}, así que los kits anteriores no tienen coste.",
  pt: "O registo de custos começou a {date}, por isso os kits anteriores não têm custo.",
  te: "ఖర్చు ట్రాకింగ్ {date}న మొదలైంది, కాబట్టి అంతకు ముందు చేసిన కిట్లకు ఖర్చు లేదు.",
  mr: "खर्चाचा मागोवा {date} रोजी सुरू झाला, त्यामुळे त्याआधीच्या किटना खर्च नाही.",
  hi: "लागत ट्रैकिंग {date} को शुरू हुई, इसलिए उससे पहले बने किटों की कोई लागत दर्ज नहीं है।",
};

export const F_COST_TOP: Line = {
  en: "Top teachers by cost (last 30 days): {items}.",
  ms: "Guru dengan kos tertinggi (30 hari lepas): {items}.",
  "ms-arab": "ݢورو دڠن کوس ترتيڠݢي (30 هاري لڤس): {items}.",
  ar: "المعلمون الأعلى تكلفة (آخر 30 يومًا): {items}.",
  fr: "Enseignants au coût le plus élevé (30 derniers jours) : {items}.",
  es: "Docentes con mayor coste (últimos 30 días): {items}.",
  pt: "Professores com maior custo (últimos 30 dias): {items}.",
  te: "ఎక్కువ ఖర్చు చేసిన ఉపాధ్యాయులు (గత 30 రోజులు): {items}.",
  mr: "सर्वाधिक खर्चाचे शिक्षक (गेले 30 दिवस): {items}.",
  hi: "सबसे अधिक लागत वाले शिक्षक (पिछले 30 दिन): {items}।",
};

// ── school.gaps ──────────────────────────────────────────────────────────────

export const F_GAPS: Line = {
  en: "Shelf gaps in {where}: {n}. {items}.",
  ms: "Jurang rak buku dalam {where}: {n}. {items}.",
  "ms-arab": "جوريڠ رق بوکو دالم {where}: {n}. {items}.",
  ar: "فجوات رف الكتب في {where}: {n}. {items}.",
  fr: "Manques sur l'étagère pour {where} : {n}. {items}.",
  es: "Huecos en la estantería de {where}: {n}. {items}.",
  pt: "Lacunas na estante ({where}): {n}. {items}.",
  te: "{where} పుస్తకాల అరలో లోటులు: {n}. {items}.",
  mr: "{where} च्या पुस्तक शेल्फमधील उणिवा: {n}. {items}.",
  hi: "{where} की किताबों की शेल्फ़ में कमियाँ: {n}। {items}।",
};

export const F_GAP_NO_BOOK: Line = {
  en: "no book on the shelf",
  ms: "tiada buku di rak",
  "ms-arab": "تيادا بوکو د رق",
  ar: "لا يوجد كتاب على الرف",
  fr: "aucun livre sur l'étagère",
  es: "ningún libro en la estantería",
  pt: "nenhum livro na estante",
  te: "అరలో పుస్తకం లేదు",
  mr: "शेल्फवर पुस्तक नाही",
  hi: "शेल्फ़ पर कोई किताब नहीं",
};

export const F_GAP_NO_KITS: Line = {
  en: "book on shelf, no kits yet",
  ms: "buku ada di rak, belum ada kit",
  "ms-arab": "بوکو اد د رق، بلوم اد کيت",
  ar: "الكتاب على الرف، ولا توجد حزم بعد",
  fr: "livre sur l'étagère, pas encore de kit",
  es: "libro en la estantería, aún sin kits",
  pt: "livro na estante, ainda sem kits",
  te: "అరలో పుస్తకం ఉంది, ఇంకా కిట్లు లేవు",
  mr: "शेल्फवर पुस्तक आहे, अजून किट नाहीत",
  hi: "शेल्फ़ पर किताब है, अभी कोई किट नहीं",
};

export const F_GAP_PERIODS: Line = {
  en: "periods a week: {n}",
  ms: "waktu seminggu: {n}",
  "ms-arab": "وقتو سميڠݢو: {n}",
  ar: "الحصص أسبوعيًا: {n}",
  fr: "séances par semaine : {n}",
  es: "sesiones por semana: {n}",
  pt: "tempos por semana: {n}",
  te: "వారానికి పీరియడ్లు: {n}",
  mr: "आठवड्याच्या तासिका: {n}",
  hi: "सप्ताह के पीरियड: {n}",
};

export const F_GAPS_NONE: Line = {
  en: "Every timetabled subject in {where} has a book on the shelf with kits made (subject and grade pairs: {pairs}).",
  ms: "Setiap subjek dalam jadual waktu {where} ada buku di rak dan kit telah dibuat (pasangan subjek dan tahun: {pairs}).",
  "ms-arab": "ستياڤ سوبجيک دالم جادوال وقتو {where} اد بوکو د رق دان کيت تله دبوات (ڤاسڠن سوبجيک دان تاهون: {pairs}).",
  ar: "لكل مادة في جدول {where} كتاب على الرف وحزم منشأة (أزواج المادة والصف: {pairs}).",
  fr: "Chaque matière à l'emploi du temps de {where} a un livre sur l'étagère et des kits (paires matière-niveau : {pairs}).",
  es: "Cada asignatura del horario de {where} tiene un libro en la estantería con kits creados (pares asignatura-curso: {pairs}).",
  pt: "Cada disciplina do horário ({where}) tem um livro na estante com kits criados (pares disciplina-ano: {pairs}).",
  te: "{where} టైమ్‌టేబుల్‌లోని ప్రతి విషయానికి అరలో పుస్తకం, తయారైన కిట్లు ఉన్నాయి (విషయం-తరగతి జతలు: {pairs}).",
  mr: "{where} च्या वेळापत्रकातील प्रत्येक विषयासाठी शेल्फवर पुस्तक आणि तयार किट आहेत (विषय-इयत्ता जोड्या: {pairs}).",
  hi: "{where} की समय-सारणी के हर विषय के लिए शेल्फ़ पर किताब और बने हुए किट हैं (विषय-कक्षा जोड़े: {pairs})।",
};

export const F_GAPS_NO_TIMETABLE: Line = {
  en: "There is no timetable for {where} yet, so I can't compare it with the shelf.",
  ms: "Belum ada jadual waktu untuk {where}, jadi saya tidak dapat membandingkannya dengan rak buku.",
  "ms-arab": "بلوم اد جادوال وقتو اونتوق {where}، جادي ساي تيدق داڤت ممبنديڠکنڽ دڠن رق بوکو.",
  ar: "لا يوجد جدول حصص لـ{where} بعد، لذا لا يمكنني مقارنته بالرف.",
  fr: "Il n'y a pas encore d'emploi du temps pour {where} : je ne peux pas le comparer à l'étagère.",
  es: "Aún no hay horario para {where}, así que no puedo compararlo con la estantería.",
  pt: "Ainda não há horário ({where}), por isso não o posso comparar com a estante.",
  te: "{where}కు ఇంకా టైమ్‌టేబుల్ లేదు, కాబట్టి అరతో పోల్చలేను.",
  mr: "{where} साठी अजून वेळापत्रक नाही, त्यामुळे शेल्फशी तुलना करू शकत नाही.",
  hi: "{where} के लिए अभी कोई समय-सारणी नहीं है, इसलिए शेल्फ़ से तुलना नहीं कर सकता।",
};

export const F_GAPS_OFFER: Line = {
  en: "To add a book, open the school shelf.",
  ms: "Untuk menambah buku, buka rak buku sekolah.",
  "ms-arab": "اونتوق منمبه بوکو، بوک رق بوکو سکوله.",
  ar: "لإضافة كتاب، افتح رف المدرسة.",
  fr: "Pour ajouter un livre, ouvrez l'étagère de l'école.",
  es: "Para añadir un libro, abre la estantería de la escuela.",
  pt: "Para adicionar um livro, abra a estante da escola.",
  te: "పుస్తకం జోడించడానికి, పాఠశాల పుస్తకాల అరను తెరవండి.",
  mr: "पुस्तक जोडण्यासाठी शाळेचे पुस्तक शेल्फ उघडा.",
  hi: "किताब जोड़ने के लिए स्कूल की किताबों की शेल्फ़ खोलें।",
};

export const F_OPEN_SHELF: Line = {
  en: "Open the school shelf",
  ms: "Buka rak buku sekolah",
  "ms-arab": "بوک رق بوکو سکوله",
  ar: "افتح رف المدرسة",
  fr: "Ouvrir l'étagère de l'école",
  es: "Abrir la estantería de la escuela",
  pt: "Abrir a estante da escola",
  te: "పాఠశాల పుస్తకాల అరను తెరవండి",
  mr: "शाळेचे पुस्तक शेल्फ उघडा",
  hi: "स्कूल की किताबों की शेल्फ़ खोलें",
};

// ── school.trend (approximate) ───────────────────────────────────────────────

export const F_TREND: Line = {
  en: "Trend for {where}, last 4 weeks — approximate (from submission and due dates): {items}.",
  ms: "Trend bagi {where}, 4 minggu lepas — anggaran (daripada tarikh hantar dan tarikh akhir): {items}.",
  "ms-arab": "ترين باݢي {where}، 4 ميڠݢو لڤس — اڠݢارن (درڤد تاريخ هنتر دان تاريخ اخير): {items}.",
  ar: "الاتجاه في {where} خلال آخر 4 أسابيع — تقريبي (من تواريخ التسليم والاستحقاق): {items}.",
  fr: "Tendance pour {where}, 4 dernières semaines — approximative (d'après les dates de remise et d'échéance) : {items}.",
  es: "Tendencia de {where}, últimas 4 semanas — aproximada (a partir de las fechas de entrega y de vencimiento): {items}.",
  pt: "Tendência ({where}), últimas 4 semanas — aproximada (a partir das datas de entrega e de prazo): {items}.",
  te: "{where} ధోరణి, గత 4 వారాలు — సుమారు (సమర్పణ మరియు గడువు తేదీల ఆధారంగా): {items}.",
  mr: "{where} चा कल, गेले 4 आठवडे — अंदाजे (सादर करण्याच्या व देय तारखांवरून): {items}.",
  hi: "{where} का रुझान, पिछले 4 सप्ताह — अनुमानित (जमा करने और नियत तारीखों से): {items}।",
};

export const F_TREND_WEEK: Line = {
  en: "{week}: due {due}, submitted {submitted}, on time {onTime}, awaiting marking {pending}",
  ms: "{week}: perlu dihantar {due}, dihantar {submitted}, tepat masa {onTime}, menunggu penandaan {pending}",
  "ms-arab": "{week}: ڤرلو دهنتر {due}، دهنتر {submitted}، تڤت ماس {onTime}، منوڠݢو ڤناندان {pending}",
  ar: "{week}: المستحق {due}، المُسلَّم {submitted}، في الموعد {onTime}، بانتظار التصحيح {pending}",
  fr: "{week} : à rendre {due}, rendus {submitted}, à l'heure {onTime}, à corriger {pending}",
  es: "{week}: con entrega {due}, entregados {submitted}, a tiempo {onTime}, por corregir {pending}",
  pt: "{week}: a entregar {due}, entregues {submitted}, a tempo {onTime}, por corrigir {pending}",
  te: "{week}: గడువు ఉన్నవి {due}, సమర్పించినవి {submitted}, సమయానికి {onTime}, దిద్దడానికి వేచి ఉన్నవి {pending}",
  mr: "{week}: देय {due}, सादर {submitted}, वेळेवर {onTime}, तपासणी बाकी {pending}",
  hi: "{week}: नियत {due}, जमा {submitted}, समय पर {onTime}, जाँच बाकी {pending}",
};

export const F_WEEK_OF: Line = {
  en: "week of {date}",
  ms: "minggu {date}",
  "ms-arab": "ميڠݢو {date}",
  ar: "أسبوع {date}",
  fr: "semaine du {date}",
  es: "semana del {date}",
  pt: "semana de {date}",
  te: "{date} వారం",
  mr: "{date} चा आठवडा",
  hi: "{date} का सप्ताह",
};

export const F_THIS_WEEK: Line = {
  en: "this week (so far)",
  ms: "minggu ini (setakat ini)",
  "ms-arab": "ميڠݢو اين (ستاکت اين)",
  ar: "هذا الأسبوع (حتى الآن)",
  fr: "cette semaine (jusqu'ici)",
  es: "esta semana (hasta ahora)",
  pt: "esta semana (até agora)",
  te: "ఈ వారం (ఇప్పటివరకు)",
  mr: "हा आठवडा (आतापर्यंत)",
  hi: "इस सप्ताह (अब तक)",
};

export const F_TREND_NONE: Line = {
  en: "There is no work due or submitted in {where} in the last 4 weeks, so there is no trend to show yet.",
  ms: "Tiada kerja perlu dihantar atau dihantar dalam {where} dalam 4 minggu lepas, jadi belum ada trend untuk ditunjukkan.",
  "ms-arab": "تيادا کرجا ڤرلو دهنتر اتاو دهنتر دالم {where} دالم 4 ميڠݢو لڤس، جادي بلوم اد ترين اونتوق دتونجوقکن.",
  ar: "لا توجد أعمال مستحقة أو مُسلَّمة في {where} خلال آخر 4 أسابيع، لذا لا يوجد اتجاه لعرضه بعد.",
  fr: "Aucun travail à rendre ni rendu dans {where} ces 4 dernières semaines : pas encore de tendance à montrer.",
  es: "No hay trabajo con entrega ni entregado en {where} en las últimas 4 semanas, así que aún no hay tendencia que mostrar.",
  pt: "Não há trabalho a entregar nem entregue ({where}) nas últimas 4 semanas, por isso ainda não há tendência para mostrar.",
  te: "గత 4 వారాల్లో {where}లో గడువు ఉన్న లేదా సమర్పించిన పని లేదు, కాబట్టి చూపించడానికి ఇంకా ధోరణి లేదు.",
  mr: "गेल्या 4 आठवड्यांत {where} मध्ये देय किंवा सादर केलेले काम नाही, त्यामुळे दाखवण्यासाठी अजून कल नाही.",
  hi: "पिछले 4 सप्ताहों में {where} में कोई नियत या जमा काम नहीं है, इसलिए अभी दिखाने को कोई रुझान नहीं है।",
};

/** Every line, keyed by its `sk.shell.school.figures.*` dictionary key (the test walks this). */
export const SCHOOL_FIGURE_LINES: Record<string, Line> = {
  seats: F_SEATS,
  seatsPlan: F_SEATS_PLAN,
  seatsNoLimit: F_SEATS_NO_LIMIT,
  seatsPrincipalOnly: F_SEATS_PRINCIPAL_ONLY,
  cost: F_COST,
  costSince: F_COST_SINCE,
  costTracking: F_COST_TRACKING,
  costTop: F_COST_TOP,
  gaps: F_GAPS,
  gapNoBook: F_GAP_NO_BOOK,
  gapNoKits: F_GAP_NO_KITS,
  gapPeriods: F_GAP_PERIODS,
  gapsNone: F_GAPS_NONE,
  gapsNoTimetable: F_GAPS_NO_TIMETABLE,
  gapsOffer: F_GAPS_OFFER,
  openShelf: F_OPEN_SHELF,
  trend: F_TREND,
  trendWeek: F_TREND_WEEK,
  weekOf: F_WEEK_OF,
  thisWeek: F_THIS_WEEK,
  trendNone: F_TREND_NONE,
};

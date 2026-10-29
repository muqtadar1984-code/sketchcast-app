// SK S5 slice B — the fixed lines of the leader school-read gate (the 60/day
// cap, the fail-closed audit, the analytics gate), ten locales. The same
// strings live in src/i18n/messages/*.json under `sk.shell.schoolMeter.*`;
// school-meter.test.ts holds the two copies equal. Fill with `lineFor`
// (lines.ts). Self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

export const SM_ANALYTICS_OFF: Line = {
  en: "School analytics aren't switched on for your school.",
  ms: "Analitik sekolah belum dihidupkan untuk sekolah anda.",
  "ms-arab": "اناليتيک سکوله بلوم دهيدوڤکن اونتوق سکوله اندا.",
  ar: "تحليلات المدرسة غير مفعّلة لمدرستك.",
  fr: "Les analyses de l'école ne sont pas activées pour votre école.",
  es: "Las analíticas escolares no están activadas para tu escuela.",
  pt: "A análise da escola não está ativada para a sua escola.",
  te: "మీ పాఠశాలకు పాఠశాల విశ్లేషణలు ఆన్ చేయబడలేదు.",
  mr: "तुमच्या शाळेसाठी शाळा विश्लेषण सुरू केलेले नाही.",
  hi: "आपके स्कूल के लिए स्कूल एनालिटिक्स चालू नहीं है।",
};

export const SM_AUDIT_FAILED: Line = {
  en: "I can't open school figures right now — try again in a moment.",
  ms: "Saya tidak dapat membuka angka sekolah sekarang — cuba lagi sebentar lagi.",
  "ms-arab": "ساي تيدق داڤت ممبوک اڠک سکوله سکارڠ — چوبا لاڬي سبنتر لاڬي.",
  ar: "لا أستطيع فتح أرقام المدرسة الآن — حاول مرة أخرى بعد قليل.",
  fr: "Je ne peux pas ouvrir les chiffres de l'école pour le moment — réessayez dans un instant.",
  es: "No puedo abrir las cifras de la escuela ahora mismo — inténtalo de nuevo en un momento.",
  pt: "Não consigo abrir os números da escola neste momento — tente novamente daqui a pouco.",
  te: "ప్రస్తుతం పాఠశాల గణాంకాలను తెరవలేను — కాసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.",
  mr: "आत्ता शाळेची आकडेवारी उघडता येत नाही — थोड्या वेळाने पुन्हा प्रयत्न करा.",
  hi: "अभी स्कूल के आंकड़े नहीं खोल सकता — थोड़ी देर में फिर कोशिश करें।",
};

export const SM_CAP_REACHED: Line = {
  en: "You've reached today's {cap} school questions — it resets at midnight UTC.",
  ms: "Anda telah mencapai had {cap} soalan sekolah hari ini — ia ditetapkan semula pada tengah malam UTC.",
  "ms-arab": "اندا تله منچاڤاي حد {cap} سوالن سکوله هاري اين — اي دتتڤکن سمولا ڤد تڠه مالم UTC.",
  ar: "لقد بلغت حد {cap} سؤالًا عن المدرسة اليوم — يُعاد ضبطه عند منتصف الليل بتوقيت UTC.",
  fr: "Vous avez atteint les {cap} questions sur l'école d'aujourd'hui — le compteur repart à minuit UTC.",
  es: "Has alcanzado las {cap} preguntas sobre la escuela de hoy — se reinicia a medianoche UTC.",
  pt: "Atingiu as {cap} perguntas sobre a escola de hoje — o limite repõe-se à meia-noite UTC.",
  te: "ఈరోజు {cap} పాఠశాల ప్రశ్నల పరిమితిని మీరు చేరుకున్నారు — ఇది UTC అర్ధరాత్రి రీసెట్ అవుతుంది.",
  mr: "आजचे {cap} शाळा प्रश्न तुम्ही पूर्ण केले आहेत — ही मर्यादा UTC मध्यरात्री पुन्हा सुरू होते.",
  hi: "आप आज के {cap} स्कूल प्रश्नों की सीमा तक पहुँच गए हैं — यह UTC मध्यरात्रि को रीसेट होती है।",
};

/** Every line, keyed by its `sk.shell.schoolMeter.*` dictionary key (the test walks this). */
export const SCHOOL_METER_LINES: Record<string, Line> = {
  analyticsOff: SM_ANALYTICS_OFF,
  auditFailed: SM_AUDIT_FAILED,
  capReached: SM_CAP_REACHED,
};

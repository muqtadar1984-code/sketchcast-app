// SK's fixed lines for `book.activate` (S4 slice D: book activation for a
// chosen child), ten locales. The capability (src/sk/capabilities/book.ts) and
// the action (act-book.ts) emit these themselves — NO model writes them — so,
// like act-lines.ts, the text is pinned here. The same strings live in
// src/i18n/messages/*.json under `sk.shell.book.*`; act-book-lines.test.ts
// holds the two copies equal. Fill with `lineFor` (lines.ts).
//
// Generated once from the translation table and then maintained by hand;
// self-contained on purpose (no imports): a plain data module.

type Line = Record<string, string>;

export const BOOK_CARD_TITLE_FOR: Line = {
  en: "Activate a book code for {child}",
  ms: "Aktifkan kod buku untuk {child}",
  "ms-arab": "اکتيفکن کود بوکو اونتوق {child}",
  ar: "تفعيل رمز كتاب لـ{child}",
  fr: "Activer un code de livre pour {child}",
  es: "Activar un código de libro para {child}",
  pt: "Ativar um código de livro para {child}",
  te: "{child} కోసం పుస్తక కోడ్‌ను యాక్టివేట్ చేయండి",
  mr: "{child} साठी पुस्तक कोड सक्रिय करा",
  hi: "{child} के लिए पुस्तक कोड सक्रिय करें",
};

export const BOOK_CARD_TITLE_SELF: Line = {
  en: "Activate a book code",
  ms: "Aktifkan kod buku",
  "ms-arab": "اکتيفکن کود بوکو",
  ar: "تفعيل رمز كتاب",
  fr: "Activer un code de livre",
  es: "Activar un código de libro",
  pt: "Ativar um código de livro",
  te: "పుస్తక కోడ్‌ను యాక్టివేట్ చేయండి",
  mr: "पुस्तक कोड सक्रिय करा",
  hi: "पुस्तक कोड सक्रिय करें",
};

export const BOOK_CARD_NOTE: Line = {
  en: "Nothing is activated until you click Confirm.",
  ms: "Tiada apa-apa diaktifkan sehingga anda klik Sahkan.",
  "ms-arab": "تياد اڤ٢ دأکتيفکن سهيڠݢ اندا کليک سهکن.",
  ar: "لن يُفعَّل شيء حتى تنقر على تأكيد.",
  fr: "Rien n'est activé tant que vous n'avez pas cliqué sur Confirmer.",
  es: "No se activa nada hasta que haga clic en Confirmar.",
  pt: "Nada é ativado até clicar em Confirmar.",
  te: "మీరు నిర్ధారించు క్లిక్ చేసే వరకు ఏదీ యాక్టివేట్ కాదు.",
  mr: "तुम्ही निश्चित करा वर क्लिक करेपर्यंत काहीही सक्रिय होणार नाही.",
  hi: "जब तक आप पुष्टि करें पर क्लिक नहीं करते, कुछ भी सक्रिय नहीं होगा।",
};

export const BOOK_ASK_CODE: Line = {
  en: "Type the code from your book — it starts with SKB or SKE.",
  ms: "Taipkan kod daripada buku anda — ia bermula dengan SKB atau SKE.",
  "ms-arab": "تايڤکن کود درڤد بوکو اندا — اي برمولا دڠن SKB اتاو SKE.",
  ar: "اكتب الرمز الموجود في كتابك — يبدأ بـ SKB أو SKE.",
  fr: "Saisissez le code de votre livre — il commence par SKB ou SKE.",
  es: "Escriba el código de su libro: empieza por SKB o SKE.",
  pt: "Escreva o código do seu livro — começa por SKB ou SKE.",
  te: "మీ పుస్తకంలోని కోడ్‌ను టైప్ చేయండి — అది SKB లేదా SKEతో మొదలవుతుంది.",
  mr: "तुमच्या पुस्तकातील कोड टाइप करा — तो SKB किंवा SKE ने सुरू होतो.",
  hi: "अपनी पुस्तक का कोड टाइप करें — यह SKB या SKE से शुरू होता है।",
};

export const BOOK_ASK_ORDER: Line = {
  en: "Edition codes also need the Amazon order number (like 123-1234567-1234567). What is it?",
  ms: "Kod edisi juga memerlukan nombor pesanan Amazon (contohnya 123-1234567-1234567). Apakah nombornya?",
  "ms-arab": "کود اديسي جوݢ ممرلوکن نومبور ڤسنن Amazon (چونتوهڽ 123-1234567-1234567). اڤاکه نومبورڽ؟",
  ar: "رموز الإصدار تحتاج أيضًا إلى رقم طلب أمازون (مثل 123-1234567-1234567). ما هو؟",
  fr: "Les codes d'édition demandent aussi le numéro de commande Amazon (par exemple 123-1234567-1234567). Quel est-il ?",
  es: "Los códigos de edición también necesitan el número de pedido de Amazon (por ejemplo, 123-1234567-1234567). ¿Cuál es?",
  pt: "Os códigos de edição também precisam do número de encomenda da Amazon (por exemplo, 123-1234567-1234567). Qual é?",
  te: "ఎడిషన్ కోడ్‌లకు Amazon ఆర్డర్ నంబర్ కూడా అవసరం (ఉదా. 123-1234567-1234567). అది ఏమిటి?",
  mr: "आवृत्ती कोडसाठी Amazon ऑर्डर क्रमांकही लागतो (उदा. 123-1234567-1234567). तो कोणता आहे?",
  hi: "संस्करण कोड के लिए Amazon ऑर्डर नंबर भी चाहिए (जैसे 123-1234567-1234567)। वह क्या है?",
};

export const BOOK_ASK_CHILD: Line = {
  en: "Which child is this for: {names}?",
  ms: "Untuk anak yang mana: {names}?",
  "ms-arab": "اونتوق انق يڠ مان: {names}؟",
  ar: "لأيّ طفل هذا: {names}؟",
  fr: "C'est pour quel enfant : {names} ?",
  es: "¿Para qué hijo es: {names}?",
  pt: "É para qual filho: {names}?",
  te: "ఇది ఏ పిల్లల కోసం: {names}?",
  mr: "हे कोणत्या मुलासाठी आहे: {names}?",
  hi: "यह किस बच्चे के लिए है: {names}?",
};

export const BOOK_BAD_CODE: Line = {
  en: "That code doesn't look right — check the letters and try again.",
  ms: "Kod itu nampaknya tidak betul — semak hurufnya dan cuba lagi.",
  "ms-arab": "کود ايت نمڤقڽ تيدق بتول — سمق حروفڽ دان چوبا لاݢي.",
  ar: "يبدو أن هذا الرمز غير صحيح — تحقّق من الحروف وحاول مرة أخرى.",
  fr: "Ce code ne semble pas correct — vérifiez les caractères et réessayez.",
  es: "Ese código no parece correcto: revise los caracteres e inténtelo de nuevo.",
  pt: "Esse código não parece correto — verifique os caracteres e tente novamente.",
  te: "ఆ కోడ్ సరిగ్గా లేనట్టుంది — అక్షరాలను సరిచూసి మళ్లీ ప్రయత్నించండి.",
  mr: "हा कोड बरोबर वाटत नाही — अक्षरे तपासा आणि पुन्हा प्रयत्न करा.",
  hi: "यह कोड सही नहीं लगता — अक्षर जाँचें और फिर से कोशिश करें।",
};

export const BOOK_BAD_ORDER: Line = {
  en: "That doesn't look like an Amazon order number (123-1234567-1234567).",
  ms: "Itu bukan seperti nombor pesanan Amazon (123-1234567-1234567).",
  "ms-arab": "ايت بوکن سڤرتي نومبور ڤسنن Amazon (123-1234567-1234567).",
  ar: "هذا لا يبدو رقم طلب أمازون (123-1234567-1234567).",
  fr: "Cela ne ressemble pas à un numéro de commande Amazon (123-1234567-1234567).",
  es: "Eso no parece un número de pedido de Amazon (123-1234567-1234567).",
  pt: "Isso não parece um número de encomenda da Amazon (123-1234567-1234567).",
  te: "అది Amazon ఆర్డర్ నంబర్ లాగా లేదు (123-1234567-1234567).",
  mr: "हा Amazon ऑर्डर क्रमांकासारखा दिसत नाही (123-1234567-1234567).",
  hi: "यह Amazon ऑर्डर नंबर जैसा नहीं लगता (123-1234567-1234567)।",
};

export const BOOK_CHILD_NOT_FOUND: Line = {
  en: "I can't find a child called {name} linked to your account.",
  ms: "Saya tidak menemui anak bernama {name} yang dipautkan ke akaun anda.",
  "ms-arab": "ساي تيدق منموءي انق برنام {name} يڠ دڤاءوتکن ک اکاءون اندا.",
  ar: "لا أجد طفلًا باسم {name} مرتبطًا بحسابك.",
  fr: "Je ne trouve aucun enfant nommé {name} lié à votre compte.",
  es: "No encuentro ningún hijo llamado {name} vinculado a su cuenta.",
  pt: "Não encontro nenhum filho chamado {name} associado à sua conta.",
  te: "మీ ఖాతాకు లింక్ అయిన {name} అనే పిల్లలు నాకు కనిపించలేదు.",
  mr: "तुमच्या खात्याशी जोडलेले {name} नावाचे मूल मला सापडले नाही.",
  hi: "आपके खाते से जुड़ा {name} नाम का कोई बच्चा मुझे नहीं मिला।",
};

export const BOOK_NOT_ON: Line = {
  en: "Book codes aren't switched on yet.",
  ms: "Kod buku belum dihidupkan lagi.",
  "ms-arab": "کود بوکو بلوم دهيدوڤکن لاݢي.",
  ar: "رموز الكتب غير مفعّلة بعد.",
  fr: "Les codes de livre ne sont pas encore activés.",
  es: "Los códigos de libro aún no están activados.",
  pt: "Os códigos de livro ainda não estão ativados.",
  te: "పుస్తక కోడ్‌లు ఇంకా ఆన్ చేయబడలేదు.",
  mr: "पुस्तक कोड अजून सुरू केलेले नाहीत.",
  hi: "पुस्तक कोड अभी चालू नहीं किए गए हैं।",
};

export const BOOK_UNLOCKED_FOR: Line = {
  en: "{book} is now unlocked for {child}.",
  ms: "{book} kini dibuka untuk {child}.",
  "ms-arab": "{book} کيني دبوک اونتوق {child}.",
  ar: "أصبح {book} متاحًا الآن لـ{child}.",
  fr: "{book} est maintenant débloqué pour {child}.",
  es: "{book} ya está desbloqueado para {child}.",
  pt: "{book} está agora desbloqueado para {child}.",
  te: "{book} ఇప్పుడు {child} కోసం అన్‌లాక్ అయింది.",
  mr: "{book} आता {child} साठी खुले झाले आहे.",
  hi: "{book} अब {child} के लिए खुल गई है।",
};

export const BOOK_UNLOCKED_SELF: Line = {
  en: "{book} is now unlocked.",
  ms: "{book} kini dibuka.",
  "ms-arab": "{book} کيني دبوک.",
  ar: "أصبح {book} متاحًا الآن.",
  fr: "{book} est maintenant débloqué.",
  es: "{book} ya está desbloqueado.",
  pt: "{book} está agora desbloqueado.",
  te: "{book} ఇప్పుడు అన్‌లాక్ అయింది.",
  mr: "{book} आता खुले झाले आहे.",
  hi: "{book} अब खुल गई है।",
};

export const BOOK_BOOK_FALLBACK: Line = {
  en: "Your book",
  ms: "Buku anda",
  "ms-arab": "بوکو اندا",
  ar: "كتابك",
  fr: "Votre livre",
  es: "Su libro",
  pt: "O seu livro",
  te: "మీ పుస్తకం",
  mr: "तुमचे पुस्तक",
  hi: "आपकी पुस्तक",
};

export const BOOK_INVALID: Line = {
  en: "That code isn't recognised. Check it and try again.",
  ms: "Kod itu tidak dikenali. Semak dan cuba lagi.",
  "ms-arab": "کود ايت تيدق دکنلي. سمق دان چوبا لاݢي.",
  ar: "هذا الرمز غير معروف. تحقّق منه وحاول مرة أخرى.",
  fr: "Ce code n'est pas reconnu. Vérifiez-le et réessayez.",
  es: "Ese código no se reconoce. Revíselo e inténtelo de nuevo.",
  pt: "Esse código não é reconhecido. Verifique-o e tente novamente.",
  te: "ఆ కోడ్ గుర్తించబడలేదు. సరిచూసి మళ్లీ ప్రయత్నించండి.",
  mr: "हा कोड ओळखला गेला नाही. तपासा आणि पुन्हा प्रयत्न करा.",
  hi: "यह कोड पहचाना नहीं गया। इसे जाँचें और फिर से कोशिश करें।",
};

export const BOOK_USED: Line = {
  en: "This code has already been used.",
  ms: "Kod ini telah digunakan.",
  "ms-arab": "کود اين تله دݢوناکن.",
  ar: "تم استخدام هذا الرمز من قبل.",
  fr: "Ce code a déjà été utilisé.",
  es: "Este código ya se ha utilizado.",
  pt: "Este código já foi utilizado.",
  te: "ఈ కోడ్ ఇప్పటికే ఉపయోగించబడింది.",
  mr: "हा कोड आधीच वापरला गेला आहे.",
  hi: "यह कोड पहले ही इस्तेमाल हो चुका है।",
};

export const BOOK_REVOKED: Line = {
  en: "This code is no longer valid. Please contact support.",
  ms: "Kod ini tidak lagi sah. Sila hubungi sokongan.",
  "ms-arab": "کود اين تيدق لاݢي صح. سيلا هوبوڠي سوکوڠن.",
  ar: "هذا الرمز لم يعد صالحًا. يُرجى التواصل مع الدعم.",
  fr: "Ce code n'est plus valable. Veuillez contacter l'assistance.",
  es: "Este código ya no es válido. Póngase en contacto con soporte.",
  pt: "Este código já não é válido. Contacte o suporte.",
  te: "ఈ కోడ్ ఇక చెల్లదు. దయచేసి సపోర్ట్‌ను సంప్రదించండి.",
  mr: "हा कोड आता वैध नाही. कृपया सपोर्टशी संपर्क साधा.",
  hi: "यह कोड अब मान्य नहीं है। कृपया सपोर्ट से संपर्क करें।",
};

export const BOOK_RATE_LIMITED: Line = {
  en: "Too many attempts. Please wait an hour and try again.",
  ms: "Terlalu banyak cubaan. Sila tunggu sejam dan cuba lagi.",
  "ms-arab": "ترلالو باڽق چوبائن. سيلا توڠݢو سجم دان چوبا لاݢي.",
  ar: "محاولات كثيرة جدًا. يُرجى الانتظار ساعة ثم المحاولة مرة أخرى.",
  fr: "Trop de tentatives. Veuillez patienter une heure et réessayer.",
  es: "Demasiados intentos. Espere una hora e inténtelo de nuevo.",
  pt: "Demasiadas tentativas. Aguarde uma hora e tente novamente.",
  te: "చాలా ఎక్కువ ప్రయత్నాలు. దయచేసి ఒక గంట ఆగి మళ్లీ ప్రయత్నించండి.",
  mr: "खूप जास्त प्रयत्न झाले. कृपया एक तास थांबा आणि पुन्हा प्रयत्न करा.",
  hi: "बहुत ज़्यादा कोशिशें हुईं। कृपया एक घंटा रुककर फिर से कोशिश करें।",
};

export const BOOK_NOT_YOUR_CHILD: Line = {
  en: "You can only activate a book for a child linked to your account.",
  ms: "Anda hanya boleh mengaktifkan buku untuk anak yang dipautkan ke akaun anda.",
  "ms-arab": "اندا هاڽ بوليه مڠأکتيفکن بوکو اونتوق انق يڠ دڤاءوتکن ک اکاءون اندا.",
  ar: "يمكنك تفعيل كتاب لطفل مرتبط بحسابك فقط.",
  fr: "Vous ne pouvez activer un livre que pour un enfant lié à votre compte.",
  es: "Solo puede activar un libro para un hijo vinculado a su cuenta.",
  pt: "Só pode ativar um livro para um filho associado à sua conta.",
  te: "మీ ఖాతాకు లింక్ అయిన పిల్లల కోసం మాత్రమే మీరు పుస్తకాన్ని యాక్టివేట్ చేయగలరు.",
  mr: "तुम्ही फक्त तुमच्या खात्याशी जोडलेल्या मुलासाठीच पुस्तक सक्रिय करू शकता.",
  hi: "आप केवल अपने खाते से जुड़े बच्चे के लिए ही पुस्तक सक्रिय कर सकते हैं।",
};

export const BOOK_ORDER_USED: Line = {
  en: "This order number has already been used to activate a copy.",
  ms: "Nombor pesanan ini telah digunakan untuk mengaktifkan satu naskhah.",
  "ms-arab": "نومبور ڤسنن اين تله دݢوناکن اونتوق مڠأکتيفکن ساتو نسخه.",
  ar: "تم استخدام رقم الطلب هذا من قبل لتفعيل نسخة.",
  fr: "Ce numéro de commande a déjà servi à activer un exemplaire.",
  es: "Este número de pedido ya se ha usado para activar un ejemplar.",
  pt: "Este número de encomenda já foi usado para ativar um exemplar.",
  te: "ఈ ఆర్డర్ నంబర్‌తో ఇప్పటికే ఒక కాపీ యాక్టివేట్ చేయబడింది.",
  mr: "हा ऑर्डर क्रमांक एक प्रत सक्रिय करण्यासाठी आधीच वापरला गेला आहे.",
  hi: "इस ऑर्डर नंबर से पहले ही एक प्रति सक्रिय की जा चुकी है।",
};

export const BOOK_DAILY_CAP: Line = {
  en: "This edition has reached today's activation limit. Please try again tomorrow.",
  ms: "Edisi ini telah mencapai had pengaktifan hari ini. Sila cuba lagi esok.",
  "ms-arab": "اديسي اين تله منچاڤاي حد ڤڠأکتيفن هاري اين. سيلا چوبا لاݢي ايسوق.",
  ar: "بلغ هذا الإصدار حدّ التفعيل لهذا اليوم. يُرجى المحاولة غدًا.",
  fr: "Cette édition a atteint la limite d'activations du jour. Veuillez réessayer demain.",
  es: "Esta edición ha alcanzado el límite de activaciones de hoy. Inténtelo de nuevo mañana.",
  pt: "Esta edição atingiu o limite de ativações de hoje. Tente novamente amanhã.",
  te: "ఈ ఎడిషన్ నేటి యాక్టివేషన్ పరిమితిని చేరుకుంది. దయచేసి రేపు మళ్లీ ప్రయత్నించండి.",
  mr: "या आवृत्तीची आजची सक्रियता मर्यादा पूर्ण झाली आहे. कृपया उद्या पुन्हा प्रयत्न करा.",
  hi: "इस संस्करण की आज की सक्रियण सीमा पूरी हो गई है। कृपया कल फिर से कोशिश करें।",
};

export const BOOK_FAILED: Line = {
  en: "That didn't go through. Ask me again in a moment.",
  ms: "Itu tidak berjaya. Tanya saya sekali lagi sebentar nanti.",
  "ms-arab": "ايت تيدق برجاي. تاڽ ساي سکالي لاݢي سبنتر نانتي.",
  ar: "لم يتم ذلك. اطلب مني مرة أخرى بعد قليل.",
  fr: "Cela n'a pas abouti. Redemandez-moi dans un instant.",
  es: "No se ha podido completar. Vuelva a pedírmelo en un momento.",
  pt: "Não foi possível concluir. Peça-me de novo daqui a pouco.",
  te: "అది పూర్తి కాలేదు. కాసేపటి తర్వాత మళ్లీ అడగండి.",
  mr: "ते पूर्ण झाले नाही. थोड्या वेळाने मला पुन्हा विचारा.",
  hi: "यह पूरा नहीं हुआ। थोड़ी देर बाद मुझसे फिर पूछें।",
};

export const BOOK_CODE_KIND_CARD: Line = {
  en: "Code card",
  ms: "Kad kod",
  "ms-arab": "کد کود",
  ar: "بطاقة رمز",
  fr: "Carte à code",
  es: "Tarjeta con código",
  pt: "Cartão com código",
  te: "కోడ్ కార్డ్",
  mr: "कोड कार्ड",
  hi: "कोड कार्ड",
};

export const BOOK_CODE_KIND_EDITION: Line = {
  en: "Edition code (in the book)",
  ms: "Kod edisi (dalam buku)",
  "ms-arab": "کود اديسي (دالم بوکو)",
  ar: "رمز الإصدار (في الكتاب)",
  fr: "Code d'édition (dans le livre)",
  es: "Código de edición (en el libro)",
  pt: "Código da edição (no livro)",
  te: "ఎడిషన్ కోడ్ (పుస్తకంలో)",
  mr: "आवृत्ती कोड (पुस्तकात)",
  hi: "संस्करण कोड (पुस्तक में)",
};

/** Dictionary key (`sk.shell.book.<key>`) → table, for the parity test. */
export const BOOK_LINE_TABLES: Record<string, Line> = {
  cardTitleFor: BOOK_CARD_TITLE_FOR,
  cardTitleSelf: BOOK_CARD_TITLE_SELF,
  cardNote: BOOK_CARD_NOTE,
  askCode: BOOK_ASK_CODE,
  askOrder: BOOK_ASK_ORDER,
  askChild: BOOK_ASK_CHILD,
  badCode: BOOK_BAD_CODE,
  badOrder: BOOK_BAD_ORDER,
  childNotFound: BOOK_CHILD_NOT_FOUND,
  notOn: BOOK_NOT_ON,
  unlockedFor: BOOK_UNLOCKED_FOR,
  unlockedSelf: BOOK_UNLOCKED_SELF,
  bookFallback: BOOK_BOOK_FALLBACK,
  invalid: BOOK_INVALID,
  used: BOOK_USED,
  revoked: BOOK_REVOKED,
  rateLimited: BOOK_RATE_LIMITED,
  notYourChild: BOOK_NOT_YOUR_CHILD,
  orderUsed: BOOK_ORDER_USED,
  dailyCap: BOOK_DAILY_CAP,
  failed: BOOK_FAILED,
  codeKindCard: BOOK_CODE_KIND_CARD,
  codeKindEdition: BOOK_CODE_KIND_EDITION,
};

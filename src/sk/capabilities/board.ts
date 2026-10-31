// `board.*` — the Classroom Board moves of Final Plan §2.4 as immediate-tier
// registry entries (S1 slice B). The handlers are SERVER-SIDE DECIDERS: they
// validate the request against the Board state the collector sent (a session
// must be open; segment-bound moves need the lesson map), resolve a concept
// or a heading to a segment, and hand back ONE move for the client to perform
// through the BoardController — nothing here touches the video. The route
// audits the decision (kind "board") and emits it as a `board` event.
//
// Indices: `k` is the 0-based index into the Board manifest the client holds
// (BoardController.slide(k, manifest)); people say "slide 4" meaning the
// fourth, so the rules router and the `say` lines translate (n = k + 1).

import type { SkBoardMove, SkBoardState, SkCapability, SkCapabilityMeta, SkCapabilityResult, SkContext, SkJsonSchema } from "@/sk/shell/types";
import { isDeckSource, type ArtifactRow } from "@/utils/present/deck-pages";
import { openUnitDeckSlide, openUnitSlides, type UnitSlide } from "./documents";
import { studentBoardMove } from "@/sk/shell/learner";

export const BOARD_NOT_OPEN = "Open the Board first.";
export const BOARD_NO_MAP = "The lesson map isn't ready yet.";
/** explain_selection with nothing highlighted (English; sayFor("no_selection") localises). */
export const BOARD_NO_SELECTION = "Highlight the part on the slide first, then ask me.";
/** explain_selection on a deck that is not hers (or not a deck). */
export const BOARD_SELECTION_REFUSED = "I can't open that deck.";
/** explain_selection when the deck's text map (or that slide in it) can't be read. */
export const BOARD_SELECTION_NO_SLIDE = "I couldn't read that slide's text.";
export const BOARD_MOVES: SkBoardMove[] = ["intro", "segment", "slide", "explain", "compare", "practise", "walkthrough", "freeze", "blank", "back", "resume", "pause", "recap", "rail", "load_slides", "load_deck", "explain_selection", "page"];
export const PRACTISE_MAX = 10;

type Say = Record<string, string>;

/** The say-line keys: one per move, plus the variants a move takes under a
 *  particular phrasing — `slides` is `slide {k: 0}` asked for as "the
 *  PowerPoint / the slides" (Board UX 2026-10-28), and `load_slides_any` is
 *  the load line when the client sent no segment list to count. */
export type SayKey = SkBoardMove | "slides" | "load_slides_any" | "deck_loaded" | "deck_first" | "no_selection" | "page_deck" | "page_video" | "selection_page" | "selection_video";

/** SK's one line per move, ten locales. `{n}`, `{heading}`, `{a}`, `{b}`,
 *  `{ha}`, `{hb}` are filled by the handler; the client speaks the result. */
const SAY: Record<SayKey, Say> = {
  intro: {
    en: "Playing the introduction.",
    ms: "Memainkan pengenalan.",
    "ms-arab": "ممأينكن پڠنالن.",
    ar: "جارٍ تشغيل المقدمة.",
    fr: "Lecture de l'introduction.",
    es: "Reproduciendo la introducción.",
    pt: "A reproduzir a introdução.",
    te: "పరిచయం ప్లే అవుతోంది.",
    mr: "प्रस्तावना सुरू करत आहे.",
    hi: "परिचय चल रहा है।",
  },
  segment: {
    en: "Playing part {n}.",
    ms: "Memainkan bahagian {n}.",
    "ms-arab": "ممأينكن بهاݢين {n}.",
    ar: "جارٍ تشغيل الجزء {n}.",
    fr: "Lecture de la partie {n}.",
    es: "Reproduciendo la parte {n}.",
    pt: "A reproduzir a parte {n}.",
    te: "భాగం {n} ప్లే అవుతోంది.",
    mr: "भाग {n} सुरू करत आहे.",
    hi: "भाग {n} चल रहा है।",
  },
  slide: {
    en: "Slide {n}: {heading}.",
    ms: "Slaid {n}: {heading}.",
    "ms-arab": "سلاءيد {n}: {heading}.",
    ar: "الشريحة {n}: {heading}.",
    fr: "Diapositive {n} : {heading}.",
    es: "Diapositiva {n}: {heading}.",
    pt: "Diapositivo {n}: {heading}.",
    te: "స్లైడ్ {n}: {heading}.",
    mr: "स्लाइड {n}: {heading}.",
    hi: "स्लाइड {n}: {heading}।",
  },
  explain: {
    en: "Let's look at {heading}.",
    ms: "Mari kita lihat {heading}.",
    "ms-arab": "ماري كيت ليهت {heading}.",
    ar: "لننظر إلى {heading}.",
    fr: "Regardons {heading}.",
    es: "Veamos {heading}.",
    pt: "Vamos ver {heading}.",
    te: "{heading} చూద్దాం.",
    mr: "{heading} पाहूया.",
    hi: "आइए {heading} देखें।",
  },
  compare: {
    en: "Slide {a} and slide {b}: {ha} against {hb}.",
    ms: "Slaid {a} dan slaid {b}: {ha} berbanding {hb}.",
    "ms-arab": "سلاءيد {a} دان سلاءيد {b}: {ha} بربنديڠ {hb}.",
    ar: "الشريحة {a} والشريحة {b}: {ha} مقابل {hb}.",
    fr: "Diapositives {a} et {b} : {ha} face à {hb}.",
    es: "Diapositivas {a} y {b}: {ha} frente a {hb}.",
    pt: "Diapositivos {a} e {b}: {ha} face a {hb}.",
    te: "స్లైడ్ {a} మరియు స్లైడ్ {b}: {ha} vs {hb}.",
    mr: "स्लाइड {a} आणि स्लाइड {b}: {ha} विरुद्ध {hb}.",
    hi: "स्लाइड {a} और स्लाइड {b}: {ha} बनाम {hb}।",
  },
  practise: {
    en: "{n} questions for the class.",
    ms: "{n} soalan untuk kelas.",
    "ms-arab": "{n} سوءالن اونتوق كلس.",
    ar: "{n} أسئلة للصف.",
    fr: "{n} questions pour la classe.",
    es: "{n} preguntas para la clase.",
    pt: "{n} perguntas para a turma.",
    te: "తరగతికి {n} ప్రశ్నలు.",
    mr: "वर्गासाठी {n} प्रश्न.",
    hi: "कक्षा के लिए {n} प्रश्न।",
  },
  walkthrough: {
    en: "Let's walk through the worksheet.",
    ms: "Mari kita teliti lembaran kerja.",
    "ms-arab": "ماري كيت تليتي لمبارن كرج.",
    ar: "لنستعرض ورقة العمل معاً.",
    fr: "Parcourons la fiche d'exercices.",
    es: "Repasemos la hoja de ejercicios.",
    pt: "Vamos percorrer a ficha de trabalho.",
    te: "వర్క్‌షీట్‌ను కలిసి చూద్దాం.",
    mr: "कार्यपत्रिका एकत्र पाहूया.",
    hi: "आइए वर्कशीट को साथ देखें।",
  },
  freeze: {
    en: "Frozen — write on it.",
    ms: "Dibekukan — tulis di atasnya.",
    "ms-arab": "دبكوكن — توليس د اتسڽ.",
    ar: "تم التثبيت — اكتب عليه.",
    fr: "Figé — écrivez dessus.",
    es: "Congelado: escribe encima.",
    pt: "Congelado — escreva por cima.",
    te: "నిలిపాను — దానిపై రాయండి.",
    mr: "थांबवले — यावर लिहा.",
    hi: "रोक दिया — इस पर लिखें।",
  },
  blank: {
    en: "A blank page.",
    ms: "Halaman kosong.",
    "ms-arab": "هلامن كوسوڠ.",
    ar: "صفحة فارغة.",
    fr: "Une page blanche.",
    es: "Una página en blanco.",
    pt: "Uma página em branco.",
    te: "ఖాళీ పేజీ.",
    mr: "रिकामे पान.",
    hi: "एक खाली पृष्ठ।",
  },
  back: {
    en: "Going back a page.",
    ms: "Kembali satu halaman.",
    "ms-arab": "كمبالي ساتو هلامن.",
    ar: "عودة صفحة واحدة.",
    fr: "Retour d'une page.",
    es: "Volviendo una página.",
    pt: "A recuar uma página.",
    te: "ఒక పేజీ వెనక్కి.",
    mr: "एक पान मागे.",
    hi: "एक पृष्ठ पीछे।",
  },
  resume: {
    en: "Continuing.",
    ms: "Menyambung.",
    "ms-arab": "مڽمبوڠ.",
    ar: "نتابع.",
    fr: "On continue.",
    es: "Continuamos.",
    pt: "A continuar.",
    te: "కొనసాగిస్తున్నాం.",
    mr: "पुढे चालू.",
    hi: "आगे बढ़ते हैं।",
  },
  pause: {
    en: "Paused.",
    ms: "Dijeda.",
    "ms-arab": "دجيدا.",
    ar: "متوقف.",
    fr: "En pause.",
    es: "En pausa.",
    pt: "Em pausa.",
    te: "ఆపాను.",
    mr: "थांबवले.",
    hi: "रुका हुआ।",
  },
  recap: {
    en: "Let's wrap up the lesson.",
    ms: "Mari kita tamatkan pelajaran.",
    "ms-arab": "ماري كيت تامتكن پلاجرن.",
    ar: "لننهِ الدرس.",
    fr: "Terminons la leçon.",
    es: "Cerremos la lección.",
    pt: "Vamos encerrar a lição.",
    te: "పాఠాన్ని ముగిద్దాం.",
    mr: "पाठ संपवूया.",
    hi: "आइए पाठ समाप्त करें।",
  },
  // "Skip to the PowerPoint / show the slides": slide 1 of the video's own
  // frames, with the correction that the deck file is a download in the rail.
  slides: {
    en: "The slides are the lesson's own frames — this is slide 1. The slide deck file is in the rail.",
    ms: "Slaid ialah bingkai pelajaran itu sendiri — ini slaid 1. Fail dek slaid ada di rel.",
    "ms-arab": "سلاءيد اياله بيڠکاي پلاجرن ايت سنديري — ايني سلاءيد 1. فاءيل ديق سلاءيد اد د ريل.",
    ar: "الشرائح هي إطارات الدرس نفسها — هذه الشريحة 1. ملف الشرائح موجود في الشريط الجانبي.",
    fr: "Les diapositives sont les images de la leçon elle-même — voici la diapositive 1. Le fichier du diaporama est dans le volet.",
    es: "Las diapositivas son los fotogramas de la propia lección: esta es la diapositiva 1. El archivo de la presentación está en el panel.",
    pt: "Os diapositivos são as imagens da própria lição — este é o diapositivo 1. O ficheiro da apresentação está no painel.",
    te: "స్లైడ్‌లు పాఠం యొక్క స్వంత ఫ్రేమ్‌లు — ఇది స్లైడ్ 1. స్లైడ్ డెక్ ఫైల్ రెయిల్‌లో ఉంది.",
    mr: "स्लाइड्स म्हणजे पाठाच्याच फ्रेम्स — ही स्लाइड 1. स्लाइड डेक फाइल रेलमध्ये आहे.",
    hi: "स्लाइड्स पाठ के अपने फ्रेम हैं — यह स्लाइड 1 है। स्लाइड डेक फ़ाइल रेल में है।",
  },
  rail: {
    en: "Here are the units.",
    ms: "Ini unit-unitnya.",
    "ms-arab": "ايني اونيت-اونيتڽ.",
    ar: "هذه هي الوحدات.",
    fr: "Voici les unités.",
    es: "Aquí están las unidades.",
    pt: "Aqui estão as unidades.",
    te: "ఇవి యూనిట్లు.",
    mr: "ही युनिट्स आहेत.",
    hi: "ये यूनिट हैं।",
  },
  // Said BEFORE the load: short, because the closing line (the panel's
  // sk.shell.slidesLoaded, with the page range the roll actually got) follows
  // once the pages are there.
  load_slides: {
    en: "Loading {n} slides onto the roll as pages.",
    ms: "Memuatkan {n} slaid ke gulungan sebagai halaman.",
    "ms-arab": "مموتکن {n} سلاءيد ک ڬولوڠن سباڬاي هلامن.",
    ar: "جارٍ تحميل {n} شريحة على اللفافة كصفحات.",
    fr: "Chargement de {n} diapositives sur le rouleau, une par page.",
    es: "Cargando {n} diapositivas en el rollo como páginas.",
    pt: "A carregar {n} diapositivos no rolo como páginas.",
    te: "{n} స్లైడ్‌లు రోల్‌పై పేజీలుగా లోడ్ అవుతున్నాయి.",
    mr: "{n} स्लाइड्स रोलवर पाने म्हणून लोड केल्या जात आहेत.",
    hi: "{n} स्लाइड्स रोल पर पेज के रूप में लोड की जा रही हैं।",
  },
  load_slides_any: {
    en: "Loading the slides onto the roll as pages.",
    ms: "Memuatkan slaid ke gulungan sebagai halaman.",
    "ms-arab": "مموتکن سلاءيد ک ڬولوڠن سباڬاي هلامن.",
    ar: "جارٍ تحميل الشرائح على اللفافة كصفحات.",
    fr: "Chargement des diapositives sur le rouleau, une par page.",
    es: "Cargando las diapositivas en el rollo como páginas.",
    pt: "A carregar os diapositivos no rolo como páginas.",
    te: "స్లైడ్‌లు రోల్‌పై పేజీలుగా లోడ్ అవుతున్నాయి.",
    mr: "स्लाइड्स रोलवर पाने म्हणून लोड केल्या जात आहेत.",
    hi: "स्लाइड्स रोल पर पेज के रूप में लोड की जा रही हैं।",
  },
  // The kit's .pptx as pages (founder 2026-10-28). Said BEFORE the load…
  load_deck: {
    en: "Loading the deck onto the roll as pages.",
    ms: "Memuatkan dek ke gulungan sebagai halaman.",
    "ms-arab": "مموتکن ديق ک ڬولوڠن سباڬاي هلامن.",
    ar: "جارٍ تحميل العرض التقديمي على اللفافة كصفحات.",
    fr: "Chargement du diaporama sur le rouleau, une diapositive par page.",
    es: "Cargando la presentación en el rollo como páginas.",
    pt: "A carregar a apresentação no rolo como páginas.",
    te: "డెక్ రోల్‌పై పేజీలుగా లోడ్ అవుతోంది.",
    mr: "डेक रोलवर पाने म्हणून लोड केला जात आहे.",
    hi: "डेक रोल पर पेज के रूप में लोड किया जा रहा है।",
  },
  // …and AFTER it, by the client, with the pages the roll actually got
  // ({a}–{b} are left in the template the server sends and filled there).
  deck_loaded: {
    en: "The deck is on the roll as pages {a}–{b}. Say 'blank page' to add one in between.",
    ms: "Dek kini di gulungan sebagai halaman {a}–{b}. Sebut 'halaman kosong' untuk menambah satu di antaranya.",
    "ms-arab": "ديق کيني د ڬولوڠن سباڬاي هلامن {a}–{b}. سبوت 'هلامن کوسوڠ' اونتوق منمبه ساتو د انتاراڽ.",
    ar: "العرض التقديمي الآن على اللفافة كصفحات {a}–{b}. قل 'صفحة فارغة' لإضافة صفحة بينها.",
    fr: "Le diaporama est sur le rouleau, pages {a} à {b}. Dites « page blanche » pour en insérer une entre deux.",
    es: "La presentación está en el rollo como páginas {a}–{b}. Di 'página en blanco' para añadir una en medio.",
    pt: "A apresentação está no rolo como páginas {a}–{b}. Diga 'página em branco' para acrescentar uma no meio.",
    te: "డెక్ రోల్‌పై పేజీలు {a}–{b}గా ఉంది. మధ్యలో ఒకటి చేర్చడానికి 'ఖాళీ పేజీ' అని చెప్పండి.",
    mr: "डेक रोलवर पाने {a}–{b} म्हणून आहे. मध्ये एक जोडण्यासाठी 'रिकामे पान' म्हणा.",
    hi: "डेक रोल पर पेज {a}–{b} के रूप में है। बीच में एक जोड़ने के लिए 'खाली पृष्ठ' कहें।",
  },
  // "Skip to the PowerPoint" with the deck's pages ready or on the roll.
  deck_first: {
    en: "Here is the deck — slide 1.",
    ms: "Inilah dek — slaid 1.",
    "ms-arab": "اينيله ديق — سلاءيد 1.",
    ar: "هذا هو العرض التقديمي — الشريحة 1.",
    fr: "Voici le diaporama — diapositive 1.",
    es: "Aquí está la presentación: diapositiva 1.",
    pt: "Aqui está a apresentação — diapositivo 1.",
    te: "ఇదిగో డెక్ — స్లైడ్ 1.",
    mr: "हा डेक — स्लाइड 1.",
    hi: "यह रहा डेक — स्लाइड 1।",
  },
  // "Highlight a portion and ask SK" (founder 2026-10-28). The fallback line
  // when nothing of the model's explanation survives grounding: the slide's
  // own words, quoted.
  explain_selection: {
    en: "On slide {n}: “{text}”.",
    ms: "Pada slaid {n}: “{text}”.",
    "ms-arab": "ڤد سلاءيد {n}: “{text}”.",
    ar: "في الشريحة {n}: «{text}».",
    fr: "Sur la diapositive {n} : « {text} ».",
    es: "En la diapositiva {n}: «{text}».",
    pt: "No diapositivo {n}: «{text}».",
    te: "స్లైడ్ {n}లో: “{text}”.",
    mr: "स्लाइड {n} वर: “{text}”.",
    hi: "स्लाइड {n} पर: “{text}”।",
  },
  // 2026-10-31: the roll by its own page numbers (board.page).
  page: {
    en: "Page {n}.",
    ms: "Halaman {n}.",
    "ms-arab": "هلامن {n}.",
    ar: "الصفحة {n}.",
    fr: "Page {n}.",
    es: "Página {n}.",
    pt: "Página {n}.",
    te: "పేజీ {n}.",
    mr: "पान {n}.",
    hi: "पृष्ठ {n}।",
  },
  page_deck: {
    en: "Deck slide {n}.",
    ms: "Slaid dek {n}.",
    "ms-arab": "سلاءيد ديق {n}.",
    ar: "شريحة العرض {n}.",
    fr: "Diapositive {n} du diaporama.",
    es: "Diapositiva {n} de la presentación.",
    pt: "Diapositivo {n} da apresentação.",
    te: "డెక్ స్లైడ్ {n}.",
    mr: "डेक स्लाइड {n}.",
    hi: "डेक स्लाइड {n}।",
  },
  page_video: {
    en: "Video slide {n} on the roll.",
    ms: "Slaid video {n} di gulungan.",
    "ms-arab": "سلاءيد ۏيديو {n} د ڬولوڠن.",
    ar: "شريحة الفيديو {n} على اللفافة.",
    fr: "Diapositive {n} de la vidéo, sur le rouleau.",
    es: "Diapositiva {n} del vídeo, en el rollo.",
    pt: "Diapositivo {n} do vídeo, no rolo.",
    te: "రోల్‌పై వీడియో స్లైడ్ {n}.",
    mr: "रोलवरील व्हिडिओ स्लाइड {n}.",
    hi: "रोल पर वीडियो स्लाइड {n}।",
  },
  // 2026-10-31: a highlight with no words under it. On a blank page (her
  // handwriting, a drawing) SK says what it cannot read…
  selection_page: {
    en: "I can't read handwriting or drawings on the roll. Say or type the words you want explained, and I'll explain them.",
    ms: "Saya tidak dapat membaca tulisan tangan atau lukisan pada gulungan. Sebut atau taip perkataan yang ingin diterangkan, dan saya akan terangkan.",
    "ms-arab": "ساي تيدق داڤت ممباچ توليسن تاڠن اتاو لوکيسن ڤد ڬولوڠن. سبوت اتاو تايڤ ڤرکاتأن يڠ ايڠين دتراڠکن، دان ساي اکن تراڠکن.",
    ar: "لا أستطيع قراءة الكتابة اليدوية أو الرسوم على اللفافة. قل أو اكتب الكلمات التي تريد شرحها، وسأشرحها.",
    fr: "Je ne peux pas lire l'écriture manuscrite ni les dessins sur le rouleau. Dites ou tapez les mots à expliquer, et je les expliquerai.",
    es: "No puedo leer la letra a mano ni los dibujos del rollo. Di o escribe las palabras que quieres que explique y las explicaré.",
    pt: "Não consigo ler a escrita à mão nem os desenhos no rolo. Diga ou escreva as palavras que quer que eu explique, e eu explico.",
    te: "రోల్‌పై చేతిరాత లేదా బొమ్మలను నేను చదవలేను. మీరు వివరించాలనుకునే పదాలను చెప్పండి లేదా టైప్ చేయండి, నేను వివరిస్తాను.",
    mr: "रोलवरील हस्ताक्षर किंवा चित्रे मला वाचता येत नाहीत. जे शब्द समजावून हवे आहेत ते सांगा किंवा टाइप करा, मी ते समजावून सांगेन.",
    hi: "मैं रोल पर हाथ की लिखावट या चित्र नहीं पढ़ सकता। जिन शब्दों को समझाना है उन्हें बोलें या टाइप करें, मैं उन्हें समझा दूँगा।",
  },
  // …and on a video slide's frame it explains that slide, saying so first.
  selection_video: {
    en: "That's on video slide {n}. I can't pick out words on a video frame, so here is that slide:",
    ms: "Itu pada slaid video {n}. Saya tidak dapat membaca perkataan pada bingkai video, jadi inilah slaid itu:",
    "ms-arab": "ايت ڤد سلاءيد ۏيديو {n}. ساي تيدق داڤت ممباچ ڤرکاتأن ڤد بيڠکاي ۏيديو، جادي اينيله سلاءيد ايت:",
    ar: "هذا في شريحة الفيديو {n}. لا أستطيع قراءة الكلمات في إطار الفيديو، فإليك تلك الشريحة:",
    fr: "C'est sur la diapositive {n} de la vidéo. Je ne peux pas lire les mots d'une image de la vidéo, alors voici cette diapositive :",
    es: "Eso está en la diapositiva {n} del vídeo. No puedo leer palabras en un fotograma, así que aquí está esa diapositiva:",
    pt: "Isso está no diapositivo {n} do vídeo. Não consigo ler palavras numa imagem do vídeo, por isso aqui está esse diapositivo:",
    te: "అది వీడియో స్లైడ్ {n}లో ఉంది. వీడియో ఫ్రేమ్‌లోని పదాలను నేను చదవలేను, కాబట్టి ఆ స్లైడ్ ఇదిగో:",
    mr: "ते व्हिडिओ स्लाइड {n} वर आहे. व्हिडिओ फ्रेममधील शब्द मला वाचता येत नाहीत, म्हणून ही ती स्लाइड:",
    hi: "यह वीडियो स्लाइड {n} पर है। मैं वीडियो फ़्रेम के शब्द नहीं पढ़ सकता, इसलिए यह रही वह स्लाइड:",
  },
  // …and when she asks with nothing highlighted.
  no_selection: {
    en: BOARD_NO_SELECTION,
    ms: "Serlahkan bahagian pada slaid dahulu, kemudian tanya saya.",
    "ms-arab": "سرلهکن بهاݢين ڤد سلاءيد دهولو، کمودين تاڽ ساي.",
    ar: "ظلّل الجزء على الشريحة أولاً، ثم اسألني.",
    fr: "Surlignez d'abord le passage sur la diapositive, puis demandez-moi.",
    es: "Primero resalta la parte en la diapositiva y luego pregúntame.",
    pt: "Primeiro destaque a parte no diapositivo e depois pergunte-me.",
    te: "ముందుగా స్లైడ్‌లో ఆ భాగాన్ని హైలైట్ చేసి, తర్వాత నన్ను అడగండి.",
    mr: "आधी स्लाइडवरील तो भाग हायलाइट करा, मग मला विचारा.",
    hi: "पहले स्लाइड पर उस हिस्से को हाइलाइट करें, फिर मुझसे पूछें।",
  },
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

export function sayFor(move: SayKey, locale: string | null | undefined, vars: Record<string, string | number> = {}): string {
  const table = SAY[move];
  return fill(table[locale ?? "en"] ?? table.en, vars);
}

// ── resolution: a spoken concept or heading → a segment ─────────────────────

const STOP: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "between", "vs", "versus",
  "slide", "segment", "part", "about", "me", "us", "class", "them",
  "yang", "dan", "atau", "untuk", "dengan", "tentang", "di", "ke", "itu", "ini", "slaid", "bahagian",
  "و", "في", "عن", "من", "إلى", "الى", "بين", "مع", "الشريحة",
]);

export function conceptTokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((w) => w.replace(/^(?:ال)/u, ""))
    .map((w) => (w.length > 4 && /^[a-z]+$/.test(w) ? w.replace(/(?:ies|es|s)$/u, "") : w))
    .filter((w) => w && !STOP.has(w));
}

function overlap(query: string[], target: string[]): number {
  if (!query.length || !target.length) return 0;
  const t = new Set(target);
  let hits = 0;
  for (const w of query) if (t.has(w) || target.some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) hits++;
  return hits / query.length;
}

export type SegmentHit = { k: number; heading: string; points?: string[]; via: "concept" | "heading"; concept?: string };

/** Concept name first (then its segment ids), headings second; a match needs
 *  at least half the query's content words. Pure. */
export function resolveSegment(query: string, board: SkBoardState): SegmentHit | null {
  const segments = board.segments ?? [];
  if (!segments.length) return null;
  const q = conceptTokens(query);
  if (!q.length) return null;
  const byK = (k: number) => segments.find((s) => s.k === k);
  let best: { score: number; hit: SegmentHit } | null = null;
  const consider = (score: number, hit: SegmentHit) => {
    if (score >= 0.5 && (!best || score > best.score)) best = { score, hit };
  };
  for (const c of board.concepts ?? []) {
    const score = overlap(q, conceptTokens(c.name));
    if (score < 0.5) continue;
    const seg = c.segmentIds.map((id) => segments.find((s) => s.id === id)).find(Boolean);
    if (seg) consider(score + 0.01, { k: seg.k, heading: seg.heading, points: seg.points, via: "concept", concept: c.name });
  }
  for (const s of segments) {
    const score = overlap(q, conceptTokens(s.heading));
    consider(score, { k: s.k, heading: s.heading, points: s.points, via: "heading" });
  }
  if (!best) return null;
  const hit = (best as { hit: SegmentHit }).hit;
  return byK(hit.k) ? hit : null;
}

// ── validation helpers ──────────────────────────────────────────────────────

function board(ctx: SkContext): SkBoardState | null {
  return ctx.board?.sessionId ? ctx.board : null;
}

const noBoard: SkCapabilityResult = { ok: false, summary: BOARD_NOT_OPEN, error: "no board", facts: [] };
const noMap: SkCapabilityResult = { ok: false, summary: BOARD_NO_MAP, error: "no manifest", facts: [] };

function intArg(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function strArg(v: unknown, max = 120): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** `k` must address a segment the client holds (when it sent the list). */
function checkK(b: SkBoardState, k: number | null): { ok: true; k: number; heading: string; points?: string[] } | SkCapabilityResult {
  if (k === null || k < 0) return { ok: false, summary: "Which slide? Say the number.", error: "bad_k", facts: [] };
  const segs = b.segments ?? [];
  if (segs.length) {
    const s = segs.find((x) => x.k === k);
    if (!s) return { ok: false, summary: `This lesson has ${segs.length} slides.`, error: "no_such_slide", facts: [] };
    return { ok: true, k, heading: s.heading, points: s.points };
  }
  return { ok: true, k, heading: "" };
}

const ok = (summary: string, b: { move: SkBoardMove; args: Record<string, unknown>; say: string }, facts: SkCapabilityResult["facts"] = []): SkCapabilityResult => ({
  ok: true,
  summary,
  facts,
  board: b,
});

// ── the entries ─────────────────────────────────────────────────────────────

const NONE: SkJsonSchema = { type: "object", properties: {}, additionalProperties: false };
const K: SkJsonSchema = {
  type: "object",
  properties: { k: { type: "integer", minimum: 0, description: "0-based segment index (the user's 'slide 4' is k=3)." } },
  required: ["k"],
  additionalProperties: false,
};

function meta(move: SkBoardMove, description: string, parameters: SkJsonSchema): SkCapabilityMeta {
  return {
    name: `board.${move}`,
    description,
    parameters,
    tier: "immediate",
    kind: "board",
    // The student Board (learner mode, 2026-10-31): a student drives her own
    // Board with the moves in STUDENT_BOARD_MOVES (shell/learner.ts); the
    // `board` flag is on for her only while that Board is open (context.ts).
    roles: studentBoardMove(move) ? ["teacher", "school_admin", "coordinator", "student"] : ["teacher", "school_admin", "coordinator"],
    hats: ["teacher"],
    flags: ["board"],
  };
}

type Handler = SkCapability["handler"];

/** Every move needs an open Board; `needsMap` moves also need the lesson map. */
function withBoard(needsMap: boolean, fn: (b: SkBoardState, ctx: SkContext, args: Record<string, unknown>) => SkCapabilityResult): Handler {
  return async (ctx, args) => {
    const b = board(ctx);
    if (!b) return noBoard;
    if (needsMap && !b.manifestId) return noMap;
    return fn(b, ctx, args ?? {});
  };
}

const simple = (move: SkBoardMove, description: string, summary: string): SkCapability => ({
  meta: meta(move, description, NONE),
  handler: withBoard(false, (b, ctx) => ok(summary, { move, args: {}, say: sayFor(move, ctx.user.locale) })),
});

export const boardIntro = simple("intro", "Board: play the lesson video from the start (SK stays silent). Use for 'start / play the video / play the intro'.", "Playing the video from the start.");
export const boardFreeze = simple("freeze", "Board: freeze the current video frame onto the roll so the teacher can write on it.", "Frozen the frame onto the roll.");
export const boardBlank = simple("blank", "Board: add a blank page to the roll.", "Added a blank page.");
export const boardBack = simple("back", "Board: go back one page on the roll (the same as board.page to=previous).", "Went back a page.");
export const boardResume = simple("resume", "Board: continue the paused video. Use for 'continue / resume / carry on'.", "Resumed the video.");
export const boardPause = simple("pause", "Board: pause the video. Use for 'pause / stop there / hold on'.", "Paused the video.");
export const boardRecap = simple("recap", "Board: end the lesson and open the recap draft. Use for 'end the lesson / recap / wrap up'.", "Ending the lesson — the recap draft opens.");

export const boardSegment: SkCapability = {
  meta: meta("segment", "Board: play one segment of the video — seek to its start, play to its end, then pause. k is the 0-based segment index.", K),
  handler: withBoard(true, (b, ctx, args) => {
    const r = checkK(b, intArg(args.k));
    if (!("k" in r)) return r;
    return ok(`Playing segment ${r.k + 1}${r.heading ? `: ${r.heading}` : ""}.`, { move: "segment", args: { k: r.k, heading: r.heading }, say: sayFor("segment", ctx.user.locale, { n: r.k + 1 }) }, [
      { k: r.k + 1, heading: r.heading },
    ]);
  }),
};

const SLIDE: SkJsonSchema = {
  type: "object",
  properties: {
    k: { type: "integer", minimum: 0, description: "0-based segment index (the user's 'slide 4' is k=3)." },
    deck: { type: "boolean", description: "True when the teacher asked for 'the slides / the PowerPoint / the deck' as a whole: the deck's own first page when its pages are rendered, else slide 1 of the video's frames with a line that the deck file is a download in the rail." },
  },
  required: ["k"],
  additionalProperties: false,
};

/** "Skip to the PowerPoint" with the .pptx's own pages ready or on the roll
 *  (founder 2026-10-28): the deck itself — loaded if it is not on the roll
 *  yet — landing on its first page. Needs no lesson map. */
function deckFirst(b: SkBoardState, ctx: SkContext): SkCapabilityResult {
  return ok(
    "Showing the deck's slide 1.",
    { move: "load_deck", args: { first: true, done: sayFor("deck_loaded", ctx.user.locale) }, say: sayFor("deck_first", ctx.user.locale) },
    [{ deck: b.deck ?? "", slide: 1 }],
  );
}

const slideHandler = withBoard(true, (b, ctx, args) => {
  const r = checkK(b, intArg(args.k));
  if (!("k" in r)) return r;
  // "Skip to the PowerPoint" with no rendered deck: slide 1 of the lesson's
  // own frames, and the line says where the file is.
  if (args.deck === true) {
    return ok(`Showing slide ${r.k + 1} — the slides are the video's frames; the deck file is in the rail.`, { move: "slide", args: { k: r.k, heading: r.heading, points: r.points ?? [], deck: true }, say: sayFor("slides", ctx.user.locale) }, [
      { k: r.k + 1, heading: r.heading, deck: "download in the rail" },
    ]);
  }
  // No heading known → "Slide 4." (the ": " before the empty heading goes).
  const say = sayFor("slide", ctx.user.locale, { n: r.k + 1, heading: r.heading }).replace(/\s*[:：]\s*(?=[.।]$)/u, "");
  return ok(`Showing slide ${r.k + 1}${r.heading ? `: ${r.heading}` : ""}.`, { move: "slide", args: { k: r.k, heading: r.heading, points: r.points ?? [] }, say }, [
    { k: r.k + 1, heading: r.heading, points: (r.points ?? []).join(" | ") },
  ]);
});

export const boardSlide: SkCapability = {
  meta: meta("slide", "Board: show the VIDEO's slide k on the video (the completed frame of segment k, paused) — the lesson video's own slides, not a deck page and not a page of the roll. k is the 0-based segment index; the user's 'video slide 4' is k=3. For 'page N', 'next / previous page' or a slide of the deck use board.page. With deck=true ('skip to the PowerPoint / show the slides') use k=0.", SLIDE),
  handler: async (ctx, args, deps) => {
    const b = board(ctx);
    if (b && args?.deck === true && (b.deck === "ready" || b.deck === "loaded")) return deckFirst(b, ctx);
    return slideHandler(ctx, args, deps);
  },
};

const RAIL: SkJsonSchema = {
  type: "object",
  properties: { open: { type: "boolean", description: "True opens the unit rail over the stage; false closes it. Default true." } },
  additionalProperties: false,
};

/** Board UX (2026-10-28): "show the units / show the rail / open the panel".
 *  A UI control — the client flips the rail overlay; no controller move. */
export const boardRail: SkCapability = {
  meta: meta("rail", "Board: open (or close) the unit rail — the panel listing the chapter's units and documents — over the stage. Use for 'show the units / show the rail / open the panel'.", RAIL),
  handler: withBoard(false, (b, ctx, args) => {
    const open = args.open !== false;
    return ok(open ? "Opening the unit rail." : "Closing the unit rail.", { move: "rail", args: { open }, say: open ? sayFor("rail", ctx.user.locale) : "" }, [{ open }]);
  }),
};

/** Board UX (2026-10-28, founder): every slide of the open unit onto the roll
 *  as one page each — the video's finished frames, not the pptx. The count
 *  comes from the segment list the client sent; the client knows the pages. */
export const boardLoadSlides: SkCapability = {
  meta: meta("load_slides", "Board: load every slide of the lesson onto the roll as pages, one per slide (the video's finished frames), then land on the first. Use for 'load the slides as pages / put the slides on the board'.", NONE),
  handler: withBoard(true, (b, ctx) => {
    const n = b.segments?.length ?? 0;
    const say = n > 0 ? sayFor("load_slides", ctx.user.locale, { n }) : sayFor("load_slides_any", ctx.user.locale);
    return ok(n > 0 ? `Loading ${n} slides onto the roll as pages.` : "Loading the slides onto the roll as pages.", { move: "load_slides", args: n > 0 ? { count: n } : {}, say }, n > 0 ? [{ count: n }] : []);
  }),
};

/** Founder 2026-10-28: "the pptx loaded on the board … each slide as 1 page".
 *  The kit's .pptx rendered by the worker, one page per slide; the client
 *  asks for the render when it is missing (~30 s), and winds to the first
 *  page when the deck is already on the roll. No lesson map needed. The
 *  closing line travels as a template ({a}–{b}) the client fills. */
function loadDeckMove(b: SkBoardState, ctx: SkContext, args: Record<string, unknown>): SkCapabilityResult {
  // 2026-10-31: "load the deck and go to slide 4" is ONE move — two Board
  // moves in one turn would leave only the last one on the Board.
  const page = intArg(args.page);
  const land = page !== null && page > 1 ? page : null;
  const loaded = b.deck === "loaded";
  const loc = ctx.user.locale;
  return ok(
    loaded
      ? `The deck is already on the roll; going to its ${land ? `slide ${land}` : "first page"}.`
      : `Loading the deck onto the roll as pages${land ? `, then going to its slide ${land}` : ""}.`,
    { move: "load_deck", args: { done: sayFor("deck_loaded", loc), ...(land ? { page: land } : {}) }, say: loaded ? (land ? sayFor("page_deck", loc, { n: land }) : sayFor("deck_first", loc)) : sayFor("load_deck", loc) },
    [...(b.deck ? [{ deck: b.deck }] : []), ...(land ? [{ deck_slide: land }] : [])],
  );
}

const loadDeckDecider = withBoard(false, loadDeckMove);

const LOAD_DECK: SkJsonSchema = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, description: "Land on this deck slide (1-based) instead of the first. 'Load the deck and go to slide 4' is ONE call with page=4 — never load_deck plus another Board move." },
  },
  additionalProperties: false,
};

/** 2026-10-31: the deck's TEXT travels with the move (each slide's title, text
 *  and speaker notes), so SK can walk through it at once (production
 *  2026-10-30: the deck loaded and SK said it did not have the slide text). */
export const boardLoadDeck: SkCapability = {
  meta: meta("load_deck", "Board: load the kit's PowerPoint (.pptx) onto the roll as pages, one rendered slide per page, then land on its first slide (or on `page`); returns each slide's text and speaker notes. Use for 'load the deck / load the PowerPoint as pages / put the presentation on the board', and for 'load the deck and go to slide N' (page=N, one call).", LOAD_DECK),
  handler: async (ctx, args, deps) => {
    const r = await loadDeckDecider(ctx, args, deps);
    if (!r.ok) return r;
    const unit = await openUnitSlides(ctx, deps?.session);
    if (!unit) return r;
    const rows = unit.slides.slice(0, 30).map((x) => ({ slide: x.n, title: x.title, text: x.text, notes: x.notes }));
    const what = unit.from === "lesson_script" ? "text as the lesson video shows them (from its script; the deck's own page text is not ready yet)" : "text and speaker notes";
    return { ...r, summary: `${r.summary} Its ${unit.slides.length} slides' ${what} are below.`, facts: [...(r.facts ?? []), ...rows] };
  },
};

const CONCEPT: SkJsonSchema = {
  type: "object",
  properties: { concept: { type: "string", description: "The concept or topic the teacher named, as said." } },
  required: ["concept"],
  additionalProperties: false,
};

/** The deck slide that best matches a concept (its title first, then its
 *  text); at least half the query's content words. Pure. */
export function resolveDeckSlide(query: string, slides: UnitSlide[]): UnitSlide | null {
  const q = conceptTokens(query);
  if (!q.length) return null;
  let best: { score: number; slide: UnitSlide } | null = null;
  for (const sl of slides) {
    const inTitle = overlap(q, conceptTokens(sl.title));
    const score = inTitle >= 0.5 ? inTitle + 0.01 : overlap(q, conceptTokens(`${sl.title} ${sl.text}`));
    if (score >= 0.5 && (!best || score > best.score)) best = { score, slide: sl };
  }
  return best ? best.slide : null;
}

/** board.explain before the lesson map is ready (2026-10-31): the open
 *  unit's DECK text answers instead: no Board move (the video's frames need
 *  the map), the slide's own words for SK to explain from. No deck text: the
 *  map refusal, as before; no match: no_match (the route then tries the kit's
 *  own book). */
async function explainFromDeck(ctx: SkContext, args: Record<string, unknown>, session?: Parameters<typeof openUnitSlides>[1]): Promise<SkCapabilityResult> {
  const concept = strArg(args.concept);
  if (!concept) return { ok: false, summary: "Explain what? Name the concept.", error: "bad_concept", facts: [] };
  const unit = await openUnitSlides(ctx, session);
  if (!unit || !unit.slides.length) return noMap;
  const hit = resolveDeckSlide(concept, unit.slides);
  if (!hit) return { ok: false, summary: `I couldn't find "${concept}" in this lesson.`, error: "no_match", facts: [] };
  const body = [hit.text, hit.notes].filter(Boolean).join(" ").slice(0, 600);
  return {
    ok: true,
    summary: `From the deck, slide ${hit.n}${hit.title ? `: ${hit.title}` : ""}. ${body}`.trim(),
    facts: [{ concept, slide: hit.n, title: hit.title, text: hit.text, notes: hit.notes, source: unit.from === "deck_text_map" ? "deck" : "lesson script" }],
  };
}

const explainWithMap = withBoard(true, (b, ctx, args) => {
  const concept = strArg(args.concept);
  if (!concept) return { ok: false, summary: "Explain what? Name the concept.", error: "bad_concept", facts: [] };
  const hit = resolveSegment(concept, b);
  if (!hit) return { ok: false, summary: `I couldn't find "${concept}" in this lesson.`, error: "no_match", facts: [] };
  return ok(
    `Showing slide ${hit.k + 1}: ${hit.heading}.`,
    { move: "slide", args: { k: hit.k, heading: hit.heading, points: hit.points ?? [], concept, via: hit.via }, say: sayFor("explain", ctx.user.locale, { heading: hit.heading }) },
    [{ concept, k: hit.k + 1, heading: hit.heading, points: (hit.points ?? []).join(" | ") }],
  );
});

export const boardExplain: SkCapability = {
  meta: meta("explain", "Board: explain a concept — shows the slide that teaches it (resolved from the lesson map) and returns its heading and points for you to narrate from; before the map is ready, returns the matching deck slide's text instead. Use for 'explain X / what is X' while the Board is open.", CONCEPT),
  handler: async (ctx, args, deps) => {
    const b = board(ctx);
    if (!b) return noBoard;
    if (!b.manifestId) return explainFromDeck(ctx, args ?? {}, deps?.session);
    return explainWithMap(ctx, args, deps);
  },
};

const COMPARE: SkJsonSchema = {
  type: "object",
  properties: { a: { type: "string", description: "First concept, as said." }, b: { type: "string", description: "Second concept, as said." } },
  required: ["a", "b"],
  additionalProperties: false,
};

export const boardCompare: SkCapability = {
  meta: meta("compare", "Board: compare two concepts — shows the first one's slide, carries the second's, and returns both headings and points for you to narrate the difference. Use for 'compare A and B / difference between A and B'.", COMPARE),
  handler: withBoard(true, (b, ctx, args) => {
    const a = strArg(args.a);
    const c = strArg(args.b);
    if (!a || !c) return { ok: false, summary: "Compare what with what?", error: "bad_concept", facts: [] };
    const ha = resolveSegment(a, b);
    const hb = resolveSegment(c, b);
    if (!ha || !hb) {
      const missing = [!ha ? a : null, !hb ? c : null].filter(Boolean).map((s) => `"${s}"`).join(" and ");
      return { ok: false, summary: `I couldn't find ${missing} in this lesson.`, error: "no_match", facts: [] };
    }
    return ok(
      `Slide ${ha.k + 1} (${ha.heading}) against slide ${hb.k + 1} (${hb.heading}).`,
      {
        move: "slide",
        args: { k: ha.k, heading: ha.heading, points: ha.points ?? [], next: hb.k, a: { k: ha.k, heading: ha.heading, concept: a }, b: { k: hb.k, heading: hb.heading, concept: c } },
        say: sayFor("compare", ctx.user.locale, { a: ha.k + 1, b: hb.k + 1, ha: ha.heading, hb: hb.heading }),
      },
      [
        { concept: a, k: ha.k + 1, heading: ha.heading, points: (ha.points ?? []).join(" | ") },
        { concept: c, k: hb.k + 1, heading: hb.heading, points: (hb.points ?? []).join(" | ") },
      ],
    );
  }),
};

const PRACTISE: SkJsonSchema = {
  type: "object",
  properties: { n: { type: "integer", minimum: 1, maximum: PRACTISE_MAX, description: "How many questions (default 3)." } },
  additionalProperties: false,
};

/** Slice C: the route may stamp the q_ids of the items mapped to the current
 *  segment (from the Kit Manifest) into the args; they travel to the client
 *  (the bridge opens the window at the first worksheet one) and sit in the
 *  audit row the recap reads. Bounded, strings only. */
function qIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 40)).slice(0, PRACTISE_MAX) : [];
}

export const boardPractise: SkCapability = {
  meta: meta("practise", "Board: put n practice questions from the kit's worksheet on the roll, those mapped to the current segment first. Use for 'give them three questions'.", PRACTISE),
  handler: withBoard(false, (b, ctx, args) => {
    const raw = args.n === undefined ? 3 : intArg(args.n);
    if (raw === null || raw < 1) return { ok: false, summary: "How many questions?", error: "bad_n", facts: [] };
    const n = Math.min(raw, PRACTISE_MAX);
    const items = qIds(args.items);
    return ok(
      `${n} practice questions on the roll.`,
      { move: "practise", args: { n, k: b.k ?? null, segmentId: b.segmentId ?? null, ...(items.length ? { items } : {}) }, say: sayFor("practise", ctx.user.locale, { n }) },
      [{ n, ...(items.length ? { items: items.join(", ") } : {}) }],
    );
  }),
};

export const boardWalkthrough = simple("walkthrough", "Board: walk through the worksheet questions in order on the roll.", "Walking through the worksheet.");

// ── the roll by its own page numbers (2026-10-31) ───────────────────────────

const PAGE: SkJsonSchema = {
  type: "object",
  properties: {
    to: {
      type: "string",
      enum: ["page", "next", "previous", "first", "last", "deck", "video"],
      description:
        "page = roll page n exactly as the Board shows it ('30 / 54' is page 30 of 54); next / previous / first / last = the roll; deck = where deck slide n is on the roll ('slide 4 in the deck', 'deck page 4'); video = where the video's slide n was loaded as a page.",
    },
    n: { type: "integer", minimum: 1, description: "The number: the roll page (to=page), the deck slide (to=deck) or the video slide (to=video)." },
  },
  required: ["to"],
  additionalProperties: false,
};

const PAGE_TO: ReadonlySet<string> = new Set(["page", "next", "previous", "first", "last", "deck", "video"]);

/** The roll page (1-based) holding `kind` item n, from the ranges the client
 *  sent — the one nearest the page on screen when it is there twice. */
export function rangePage(b: SkBoardState, kind: "video" | "deck", n: number): number | null {
  const hits = (b.roll ?? []).filter((r) => r.kind === kind && n >= r.first && n <= r.last).map((r) => r.from + (n - r.first));
  if (!hits.length) return null;
  const cur = typeof b.rollPage === "number" ? Math.round(b.rollPage) + 1 : 1;
  return hits.reduce((best, p) => (Math.abs(p - cur) < Math.abs(best - cur) ? p : best));
}

function pageMove(b: SkBoardState, ctx: SkContext, args: Record<string, unknown>): SkCapabilityResult {
  const raw = typeof args.to === "string" ? args.to.trim().toLowerCase() : "";
  const to = PAGE_TO.has(raw) ? raw : args.n !== undefined ? "page" : "";
  const n = intArg(args.n);
  const count = typeof b.rollCount === "number" && b.rollCount >= 1 ? b.rollCount : null;
  const cur = typeof b.rollPage === "number" ? Math.round(b.rollPage) + 1 : null;
  const loc = ctx.user.locale;
  const fail = (summary: string, error: string): SkCapabilityResult => ({ ok: false, summary, error, facts: [] });
  const of = count ? ` / ${count}` : "";
  const go = (page: number, say: string, summary: string, extra: Record<string, unknown> = {}) =>
    ok(summary, { move: "page", args: { page, ...extra }, say }, [{ page, ...(count ? { of: count } : {}) }]);

  if (to === "next" || to === "previous") {
    // An older Board that sends no page numbers: the bridge counts itself.
    if (cur === null || count === null) return ok(to === "next" ? "Next page." : "Previous page.", { move: "page", args: { to }, say: "" });
    const page = cur + (to === "next" ? 1 : -1);
    if (page > count) return fail(`This is the last page (${count} / ${count}).`, "at_end");
    if (page < 1) return fail(`This is the first page (1 / ${count}).`, "at_start");
    return go(page, sayFor("page", loc, { n: page }), `Page ${page}${of}.`);
  }
  if (to === "first") return go(1, sayFor("page", loc, { n: 1 }), `Page 1${of}.`);
  if (to === "last") {
    if (count === null) return ok("The last page.", { move: "page", args: { to }, say: "" });
    return go(count, sayFor("page", loc, { n: count }), `Page ${count}${of}.`);
  }
  if (!to) return fail("Which page? Say the number, or next / previous.", "bad_to");
  if (n === null || n < 1) return fail("Which page? Say the number.", "bad_n");
  if (to === "page") {
    if (count !== null && n > count) return fail(`The roll has ${count} pages.`, "no_such_page");
    return go(n, sayFor("page", loc, { n }), `Page ${n}${of}.`);
  }
  if (to === "deck") {
    const page = rangePage(b, "deck", n);
    if (page !== null) return go(page, sayFor("page_deck", loc, { n }), `Deck slide ${n} is page ${page}${of} on the roll.`, { item: { kind: "deck", n } });
    const decks = (b.roll ?? []).filter((r) => r.kind === "deck");
    if (decks.length) return fail(`The deck on the roll has slides ${Math.min(...decks.map((r) => r.first))}–${Math.max(...decks.map((r) => r.last))}.`, "no_such_slide");
    // An older Board that sends no ranges: the bridge finds the page itself.
    if (b.deck === "loaded") return ok(`Going to deck slide ${n}.`, { move: "page", args: { item: { kind: "deck", n } }, say: sayFor("page_deck", loc, { n }) }, [{ deck_slide: n }]);
    // Not on the roll yet: load it, landing on that slide (ONE move).
    if (b.deck && b.deck !== "failed") return loadDeckMove(b, ctx, { page: n });
    return fail("This lesson has no slide deck to show as pages.", "no_deck");
  }
  // to === "video": where the video's slide n was loaded as a page.
  const page = rangePage(b, "video", n);
  if (page !== null) return go(page, sayFor("page_video", loc, { n }), `Video slide ${n} is page ${page}${of} on the roll.`, { item: { kind: "video", n } });
  return fail(`Video slide ${n} is not on the roll as a page. Show it on the video with board.slide (k=${n - 1}), or load the slides as pages first.`, "not_on_roll");
}

/**
 * 2026-10-31 (production 2026-10-30: "move to page 31" on a 54-page roll was
 * refused, "show next page" had no tool, "slide 4 in the deck" showed the
 * VIDEO's slide 4). The roll by its own numbers, from the Board state's
 * rollPage / rollCount / roll ranges. A deck slide or a video slide travels as
 * `item` too, so the bridge finds it again on the live roll.
 */
export const boardPage: SkCapability = {
  meta: meta(
    "page",
    "Board: turn the ROLL — the Board's pages, shown as 'page / pages' (e.g. '30 / 54'). to=page with n = that page number exactly as shown; to=next / previous / first / last; to=deck with n = a deck slide ('slide 4 in the deck', 'deck page 4'); to=video with n = a video slide loaded as a page. A deck slide not on the roll yet is loaded, landing on it. Use for 'page 31', 'next page', 'previous page', 'the last page', 'deck slide 4'.",
    PAGE,
  ),
  handler: withBoard(false, pageMove),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Highlight a portion and ask SK to explain it" (founder 2026-10-28). The
 * selection rides in the Board state (SkBoardState.selection: the deck, the
 * slide, the words under the ink); this decider only VALIDATES it — an open
 * Board, something highlighted, and a deck that is HERS, re-read through her
 * own session with an explicit owner filter exactly as /api/present/deck-pages
 * reads it (that route is the only way a deck reaches the roll, so a deck on
 * her roll is always one she owns). No Board move: the route writes the
 * explanation from the slide's text map, and the video and roll stay put.
 *
 * 2026-10-31: an ADOPTED kit's deck is also accepted as the open unit's
 * sibling deck piece (documents.ts openUnitDeckSlide, #233's kit resolution);
 * a highlight on a video slide's frame (`on: "video"`) is that slide of the
 * open unit's video; one on any other page (`on: "page"`: her handwriting)
 * has nothing SK can read, and SK says so. In model routing this tool is a
 * HAND-OFF (routing.ts handoffBefore): the model stops and the route runs it.
 */
export const boardExplainSelection: SkCapability = {
  meta: meta(
    "explain_selection",
    "Board: explain the part of the roll the teacher highlighted (the Board state's highlight) — a deck slide's highlighted words from that slide's own text and speaker notes, or a video slide as a whole. Use for 'explain this / what does this mean / tell me more about this' right after she highlights. SK performs it completely; nothing on the Board moves.",
    NONE,
  ),
  handler: async (ctx, _args, deps) => {
    const b = board(ctx);
    if (!b) return noBoard;
    const sel = b.selection;
    const loc = ctx.user.locale;
    if (sel?.on === "page" && Number.isInteger(sel.n) && sel.n >= 1) return { ok: false, summary: sayFor("selection_page", loc), error: "unreadable_page", facts: [] };
    if (sel?.on === "video" && Number.isInteger(sel.n) && sel.n >= 1) {
      // Her open unit's video only; the slide must be in the lesson map she holds (when sent).
      if (!sel.generationId || sel.generationId !== b.generationId || (b.segments?.length && !b.segments.some((s) => s.k === sel.n - 1))) {
        return { ok: false, summary: sayFor("no_selection", loc), error: "no_selection", facts: [] };
      }
      return { ok: true, summary: `Explaining video slide ${sel.n}${sel.title ? ` (${sel.title})` : ""}, which she highlighted.`, facts: [{ video_slide: sel.n, title: sel.title ?? "" }] };
    }
    if (!sel?.text?.trim() || !sel.generationId || !Number.isInteger(sel.n) || sel.n < 1) {
      return { ok: false, summary: sayFor("no_selection", loc), error: "no_selection", facts: [] };
    }
    const refused: SkCapabilityResult = { ok: false, summary: BOARD_SELECTION_REFUSED, error: "not_owner", facts: [] };
    const sibling = async (): Promise<SkCapabilityResult> => ((await openUnitDeckSlide(ctx, sel.generationId, sel.n, deps?.session)) ? selected : refused);
    const selected: SkCapabilityResult = {
      ok: true,
      summary: `Explaining the highlighted part of slide ${sel.n}${sel.title ? ` (${sel.title})` : ""}.`,
      facts: [{ slide: sel.n, title: sel.title ?? "", highlighted: sel.text }],
    };
    if (!UUID_RE.test(sel.generationId)) return refused;
    let row: { id: string; kind: string; owner_id: string; artifacts?: ArtifactRow[] | null } | null = null;
    try {
      const { data, error } = await deps.session
        .from("generations")
        .select("id, kind, owner_id, artifacts(kind, storage_path)")
        .eq("id", sel.generationId)
        .eq("owner_id", ctx.user.id)
        .eq("status", "done")
        .is("withdrawn_at", null)
        .maybeSingle();
      if (error) return sibling();
      row = data;
    } catch {
      return sibling();
    }
    // Belt and braces: the filter above already said so (and a leaked row must not pass).
    if (!row || row.id !== sel.generationId || row.owner_id !== ctx.user.id || !isDeckSource({ kind: row.kind, artifacts: row.artifacts ?? [] })) return sibling();
    return selected;
  },
};

export const BOARD_CAPABILITIES: SkCapability[] = [
  boardIntro,
  boardSegment,
  boardSlide,
  boardExplain,
  boardCompare,
  boardPractise,
  boardWalkthrough,
  boardFreeze,
  boardBlank,
  boardBack,
  boardResume,
  boardPause,
  boardRecap,
  boardRail,
  boardLoadSlides,
  boardLoadDeck,
  boardExplainSelection,
  boardPage,
];

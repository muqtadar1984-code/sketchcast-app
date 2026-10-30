/**
 * The paraphrase corpus (founder 2026-10-30: "we need to make sure SK
 * understands what we mean when we ask a particular action in different
 * ways"). For every no-model intent — the tour start, each tour control, the
 * language switch, the repeat in a language, back to her own language — the
 * ways people actually say it: with greetings, "SK", punctuation, politeness,
 * any case, and in several of the app's languages. Each must be taken by the
 * RULE (no model). Then the negatives: real questions that share the words
 * must NOT trigger anything. (The model's tools for what the rules miss are
 * tested in shell-controls.test.ts and turn-intent.test.ts.)
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/intent-paraphrase.test.ts
 */
import { describe, expect, it } from "vitest";
import { isWalkthroughRequest, routeByRules } from "../rules";
import { parseLanguageCommand, targetCode } from "../language";
import { walkCommand, type WalkCommand } from "../client/walkthrough";
import { ALL_FLAGS, NOW, SCHOOL_ID, TEACHER_ID, makeCtx } from "./fixtures";
import { buildContext } from "../context";

const teacher = makeCtx({ role: "teacher" });

// ── the tour start ──────────────────────────────────────────────────────────

const TOUR_START = [
  // the founder's phrase and its frames
  "Hi SK, show me around?",
  "show me around",
  "SHOW ME AROUND!!",
  "“Show me around”",
  "Hey SK! Give me a tour.",
  "give me the tour please",
  "Can you take me on a tour?",
  "Can I get a tour?",
  "tour please",
  "Could you walk me through the app?",
  "walk me through SketchCast",
  "SK, show me how this works",
  "How does this app work?",
  "show me what you can do",
  "Give me a quick demo, please.",
  "quick tour",
  "Start the walkthrough",
  "guide me",
  "Onboarding",
  "Hello! I'd like a tour of the app",
  "OK so, show me the ropes",
  "Please give me an overview of the app",
  "I want a demo",
  "um, can we do the tour again?",
  "Take me around",
  // Malay (Rumi + Jawi)
  "Hai SK, tunjukkan sekeliling",
  "Boleh beri saya lawatan?",
  "bagaimana aplikasi ini berfungsi?",
  "تونجوقکن سکليليڠ",
  // Arabic
  "مرحبا، خذني في جولة",
  "السلام عليكم، ابدأ الجولة من فضلك",
  "كيف يعمل التطبيق؟",
  // French
  "Bonjour SK, fais-moi visiter",
  "Comment fonctionne l'application ?",
  // Spanish
  "Hola, dame un recorrido por favor",
  "¿Cómo funciona la app?",
  // Portuguese
  "Olá, me mostra o app",
  "quero um tour",
  // Hindi / Marathi / Telugu
  "नमस्ते SK, मुझे सब दिखाओ",
  "टूर शुरू करो",
  "नमस्कार, टूर दाखवा",
  "నమస్తే, నాకు అన్నీ చూపించు",
];

const NOT_TOUR = [
  "show me around the cell membrane",
  "Hi SK, show me around the cell membrane?",
  "what is a tour in geography",
  "what is a tour of duty",
  "how do I continue a lesson?",
  "what can you do in the diary?",
  "give me a demo of photosynthesis",
  "tour the solar system with me",
  "explain the Tour de France",
  "how does photosynthesis work?",
  "how does this work?",
  "can you guide me on fractions",
  "show me my analytics",
  "skip the tour",
  "continue",
];

describe("tour start: every phrasing is the rule's tour (no model)", () => {
  it(`${TOUR_START.length} phrasings`, () => {
    expect(TOUR_START.length).toBeGreaterThanOrEqual(25);
    for (const t of TOUR_START) {
      expect(routeByRules(t, teacher, NOW).intent, t).toBe("tour");
      expect(isWalkthroughRequest(t), t).toBe(true);
    }
  });
  it("for every role", () => {
    for (const role of ["teacher", "student", "parent", "school_admin"]) {
      for (const t of ["Hi SK, show me around?", "Can I get a tour?", "How does this app work?"]) {
        expect(routeByRules(t, makeCtx({ role }), NOW).intent, `${role}: ${t}`).toBe("tour");
      }
    }
  });
  it("real questions that share the words are never the tour", () => {
    for (const t of NOT_TOUR) {
      expect(routeByRules(t, teacher, NOW).intent, t).not.toBe("tour");
      expect(isWalkthroughRequest(t), t).toBe(false);
    }
  });
});

// ── the tour controls (a tour is running in her tab) ────────────────────────

const CONTROLS: Record<WalkCommand, string[]> = {
  resume: [
    "continue", "Continue the tour", "Hi SK, please continue with the tour?", "resume the tour", "keep going", "carry on", "go on with the tour",
    "OK, resume", "resume please", "let's keep going", "Continue the tour, thanks!", "RESUME!", "yes, continue",
    "sambung", "teruskan lawatan", "تابع الجولة", "continuer la visite", "continúa el recorrido", "continua o tour", "टूर जारी रखें", "కొనసాగించు",
  ],
  next: [
    "next", "next one", "Next please!", "go to the next one", "next stop", "OK next", "SK, next", "the next step", "move on", "show me the next one",
    "Hi SK, next part of the tour please", "go forward", "next!",
    "seterusnya", "التالي", "suivant", "siguiente", "próximo", "अगला", "पुढे", "తదుపరి",
  ],
  back: [
    "back", "go back", "Previous", "go back one", "back please", "the previous stop", "take me back", "go back to the last one", "one step back",
    "Hi SK, go back in the tour?", "BACK", "ok go back",
    "kembali", "السابق", "retour", "atrás", "voltar", "पीछे", "मागे", "వెనుకకు",
  ],
  pause: [
    "pause", "pause the tour", "hold on", "wait", "wait a sec", "hold on a moment", "pause it please", "Hi SK, pause the tour?", "Pause!", "ok wait",
    "just a second, pause", "wait a minute",
    "jeda", "tunggu", "توقف", "انتظر", "attends", "espera", "pausa", "रुको", "थांबा", "ఆగు",
  ],
  skip: [
    "skip", "skip the tour", "end the tour", "stop the tour", "skip it", "exit the tour", "close the tour", "finish the tour", "quit the tour",
    "Hi SK, can you end the tour please?", "skip this tour please", "Stop the tour!",
    "langkau lawatan", "tamatkan lawatan", "إنهاء الجولة", "تخطى الجولة", "terminer la visite", "saltar el recorrido", "pular o tour", "टूर छोड़ें", "वगळा", "దాటవేయి",
  ],
};

const NOT_CONTROLS = [
  "how do I continue a lesson?", "don't skip the tour", "what's next in the lesson plan for 7B", "stop the video", "go back to the library",
  "continue the video", "what comes next in photosynthesis?", "how long is the tour?", "where can I pause a video?",
];

describe("tour controls: every phrasing moves the running tour (no model)", () => {
  for (const [cmd, list] of Object.entries(CONTROLS) as Array<[WalkCommand, string[]]>) {
    it(`${cmd}: ${list.length} phrasings`, () => {
      expect(list.length).toBeGreaterThanOrEqual(15);
      for (const t of list) {
        // The panel's own check (the short forms) …
        expect(walkCommand(t), t).toBe(cmd);
        // … and the server's backstop for any phrasing that names the tour.
        if (/tour|lawatan|الجولة|visite|recorrido|टूर/u.test(t)) expect(walkCommand(t, { loose: true }), `loose: ${t}`).toBe(cmd);
      }
    });
  }
  it("questions and other moves are not tour commands", () => {
    for (const t of NOT_CONTROLS) expect(walkCommand(t), t).toBeNull();
  });
  it("with NO tour running, 'continue the tour' starts one (the rule), a bare 'continue' does not", () => {
    expect(routeByRules("Hi SK, please continue with the tour?", teacher, NOW).intent).toBe("tour");
    expect(routeByRules("continue", teacher, NOW).intent).not.toBe("tour");
  });
});

// ── the answer language ─────────────────────────────────────────────────────

const SWITCH: Array<[string, string]> = [
  ["switch to Arabic", "ar"],
  ["Hi SK, speak in Malay please", "ms"],
  ["can you talk to me in French?", "fr"],
  ["reply in Hindi from now on", "hi"],
  ["change the language to Spanish", "es"],
  ["Please switch to Portuguese.", "pt"],
  ["speak Marathi", "mr"],
  ["use Telugu", "te"],
  ["I want to switch to Chinese", "zh"],
  ["Can we switch the language to Jawi?", "ms-arab"],
  ["Hey SK, answer in Arabic from now on, thanks", "ar"],
  ["from now on, speak English", "en"],
  ["SPEAK ARABIC!", "ar"],
  ["talk to me in Malay", "ms"],
  ["switch language to Hindi", "hi"],
  ["tukar ke bahasa Arab", "ar"],
  ["tukar bahasa ke Inggeris", "en"],
  ["تحدث بالعربية", "ar"],
  ["غير اللغة إلى الإنجليزية", "en"],
  ["parle anglais", "en"],
  ["habla en español", "es"],
  ["cambia a inglés", "en"],
  ["fala português", "pt"],
  ["muda para inglês", "en"],
  ["हिंदी में बात करो", "hi"],
];

const REPEAT: Array<[string, string]> = [
  ["say that in Malay", "ms"],
  ["Hi SK, can you say that again in Arabic?", "ar"],
  ["repeat that in French please", "fr"],
  ["explain that in Hindi", "hi"],
  ["now in Spanish", "es"],
  ["in Portuguese please", "pt"],
  ["translate that into Chinese", "zh"],
  ["Malay please", "ms"],
  ["tell me that in Telugu", "te"],
  ["could you repeat your answer in Marathi?", "mr"],
  ["say it again in English, thanks", "en"],
  ["OK, SAY THAT IN ARABIC", "ar"],
  ["SK, in Jawi please", "ms-arab"],
  ["ulang dalam bahasa Arab", "ar"],
  ["terangkan semula dalam bahasa Melayu", "ms"],
  ["أعد ذلك بالعربية", "ar"],
  ["قل ذلك بالفرنسية", "fr"],
  ["répète en anglais", "en"],
  ["dilo en español", "es"],
  ["repete isso em inglês", "en"],
  ["इसे हिंदी में दोहराओ", "hi"],
  ["मराठीत पुन्हा सांगा", "mr"],
  ["తెలుగులో మళ్ళీ చెప్పండి", "te"],
  ["请用中文再说一遍", "zh"],
  ["你好，用英文说吧", "en"],
];

const BACK_TO_MINE = [
  "back to my language",
  "use my language",
  "Hi SK, go back to my language please",
  "switch back to my language",
  "return to my language",
  "speak in my language",
  "reply in my own language",
  "OK, back to my language!",
  "talk to me in my language",
  "switch to my language, thanks",
  "Hey, use my language?",
  "BACK TO MY LANGUAGE",
  "go back to English",
  "Hi SK, switch back to English please",
  "back to English",
  "kembali ke bahasa saya",
  "guna bahasa saya",
  "عد إلى لغتي",
  "استخدم لغتي",
  "utilise ma langue",
  "habla mi idioma",
  "fala a minha língua",
  "मेरी भाषा में बोलो",
  "నా భాషలో మాట్లాడండి",
  "用我的语言",
];

const NOT_LANGUAGE = [
  "explain photosynthesis in detail",
  "what is the Malay word for cell?",
  "how do you say cell in Arabic?",
  "talk to me about cells",
  "use the diary",
  "speak slowly please",
  "in 7B, who is behind?",
  "back to the library",
  "how many Arabic books do I have?",
];

describe("the answer language: every phrasing is the rule's command (no model)", () => {
  it(`switch: ${SWITCH.length} phrasings`, () => {
    expect(SWITCH.length).toBeGreaterThanOrEqual(15);
    for (const [t, code] of SWITCH) {
      const c = parseLanguageCommand(t);
      expect(c?.kind, t).toBe("back");
      expect(c && targetCode(c.target, "en"), t).toBe(code);
      expect(routeByRules(t, teacher, NOW).intent, t).toBe("lang");
    }
  });
  it(`repeat: ${REPEAT.length} phrasings`, () => {
    expect(REPEAT.length).toBeGreaterThanOrEqual(15);
    for (const [t, code] of REPEAT) {
      const c = parseLanguageCommand(t);
      expect(c?.kind, t).toBe("repeat");
      expect(c && targetCode(c.target, "en"), t).toBe(code);
      expect(routeByRules(t, teacher, NOW).intent, t).toBe("lang");
    }
  });
  it(`back to her own (the page's) language: ${BACK_TO_MINE.length} phrasings`, () => {
    expect(BACK_TO_MINE.length).toBeGreaterThanOrEqual(15);
    for (const t of BACK_TO_MINE) {
      const c = parseLanguageCommand(t);
      expect(c?.kind, t).toBe("back");
      // The page is in English: every one lands on English.
      expect(c && targetCode(c.target, "en"), t).toBe("en");
      // … and on a Malay page "my language" is Malay.
      if (c && "mine" in c.target) expect(targetCode(c.target, "ms"), t).toBe("ms");
    }
  });
  it("questions that name a language are not commands", () => {
    for (const t of NOT_LANGUAGE) {
      expect(parseLanguageCommand(t), t).toBeNull();
      expect(routeByRules(t, teacher, NOW).intent, t).not.toBe("lang");
    }
  });
});

// ── the other rules keep their meaning through a frame ──────────────────────

describe("every other no-model rule survives a greeting, 'SK' and politeness", () => {
  it("navigation", () => {
    for (const t of ["Hi SK, open the diary please", "Hey SK, can you open my analytics?", "SK, take me to the kits, thanks!", "Hello, could you show me my timetable?"]) {
      expect(routeByRules(t, teacher, NOW).intent, t).toBe("navigate");
    }
    expect(routeByRules("Hi SK, open the diary for 7B please", teacher, NOW)).toMatchObject({ intent: "navigate", target: "diary", classQuery: "7b" });
  });
  it("start a lesson keeps the kit's own casing", () => {
    expect(routeByRules("Hi SK, please start the lesson on Plant and Animal Cells", teacher, NOW)).toMatchObject({ intent: "navigate", target: "board", filters: { autostart: true }, kitQuery: "Plant and Animal Cells" });
  });
  it("teacher actions (and a question is still never an action)", () => {
    expect(routeByRules("Hi SK, post a notice to 7B: bring your hats", teacher, NOW)).toMatchObject({ intent: "act", action: "diary.note" });
    expect(routeByRules("Hey SK, please remind the parents about Friday", teacher, NOW)).toMatchObject({ intent: "act", action: "parents.remind" });
    expect(routeByRules("OK SK, mark the next one", teacher, NOW)).toMatchObject({ intent: "act", action: "marking.next" });
    expect(routeByRules("Hi SK, can you post a notice to 7B?", teacher, NOW).intent).toBe("ask");
  });
  it("Board moves with a session open", () => {
    const board = buildContext({
      user: { id: TEACHER_ID, email: "t@school.example" },
      role: "teacher",
      schoolId: SCHOOL_ID,
      hat: "teacher",
      coordinatorScope: [],
      plan: "school",
      staff: false,
      flags: ALL_FLAGS,
      collector: { path: "/present", board: { sessionId: "s1", manifestId: "m", k: 2, segments: [0, 1, 2, 3, 4].map((k) => ({ k, heading: `S${k}` })) } },
      now: NOW,
    });
    expect(routeByRules("Hi SK, pause please", board, NOW)).toMatchObject({ intent: "teach", move: "pause" });
    expect(routeByRules("Hey SK! Next slide, thanks.", board, NOW)).toMatchObject({ intent: "teach", move: "slide", args: { k: 3 } });
    expect(routeByRules("SK, can you go to slide 4?", board, NOW)).toMatchObject({ intent: "teach", move: "slide", args: { k: 3 } });
  });
  it("a student's tutor moves", () => {
    const student = makeCtx({ role: "student" });
    expect(routeByRules("Hi SK, pause please", student, NOW)).toMatchObject({ intent: "tutor", capability: "tutor.play", args: { action: "pause" } });
    expect(routeByRules("Hey SK, how am I doing?", student, NOW)).toMatchObject({ intent: "tutor", capability: "tutor.progress" });
  });
  it("a greeting alone, and thanks, keep their old answers", () => {
    expect(routeByRules("Hi SK!", teacher, NOW).intent).toBe("ask");
    expect(routeByRules("thanks", teacher, NOW).intent).toBe("chat");
    expect(routeByRules("Thanks SK!", teacher, NOW).intent).toBe("chat");
  });
});

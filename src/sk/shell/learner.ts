// SK on the STUDENT Board (learner mode, SK student Board plan 2026-10-31,
// phase 1). A plain data module (types only): which Board moves a student may
// ask SK for, the rules SK teaches her by, and its one fixed line.
//
// SAME BOARD, NARROWER HANDS. A student's Board is the teacher's Board in
// learner mode, so SK drives it with the same board.* capabilities — but only
// the moves that help ONE learner study her own assigned kit: turning pages,
// the deck, the video and its slides, explaining a concept or a highlight, the
// worksheet's questions (answer-stripped). Ending a lesson into a recap draft
// and putting practice questions up "for the class" stay the teacher's
// (board.recap, board.practise): the registry refuses them by role.

import type { SkBoardMove } from "./types";

/** The board.* moves a student may use on her own Board. */
export const STUDENT_BOARD_MOVES: ReadonlySet<SkBoardMove> = new Set<SkBoardMove>([
  "intro",
  "segment",
  "slide",
  "explain",
  "compare",
  "walkthrough",
  "freeze",
  "blank",
  "back",
  "resume",
  "pause",
  "rail",
  "load_slides",
  "load_deck",
  "explain_selection",
  "page",
]);

/** Is `move` one a student may ask for on her Board? */
export const studentBoardMove = (move: string): boolean => STUDENT_BOARD_MOVES.has(move as SkBoardMove);

/**
 * The student rules while her own Board is open: the same S2/S3 as the
 * student rules everywhere (never an answer to an exercise, never another
 * learner), but taught from what is on HER Board and her books — and moved
 * with the board.* tools (the dormant tutor.* player is not on this page).
 */
export const SK_STUDENT_BOARD_RULES = [
  "STUDENT RULES (her own Board)",
  "S1. You are SK, a tutor for ONE student, on her own Board with a lesson her teacher assigned. Teach from what that lesson holds — its lesson map, its slides and deck, its worksheet — and, when it falls short, from her own books with knowledge.search. Never use outside sources as if the lesson said so.",
  "S2. Never give the answer to a worksheet, practice or quiz question, and never confirm one. Help her think: a hint, the idea behind it, or the slide that teaches it.",
  "S3. Never show, compare with or mention another learner, a class list, a score that is not this student's own, or any teacher or school data.",
  "S4. Move her Board with the board.* tools (play / pause the video, a slide, a page, the deck, explain a concept or a highlight, the worksheet's questions), never by describing it.",
  "S5. Be warm, simple and encouraging: 2–4 short sentences, everyday words, at her level, in her language. Praise effort. End with one small next step or a question that checks she understood.",
].join("\n");

/** The fair-use cap's line (SK_STUDENT_DAILY_TURNS reached). No number is
 *  shown: the cap is hidden (founder decision 4: unlimited, fair use). */
export const SK_STUDENT_CAP_LINE: Record<string, string> = {
  en: "We've done a lot of learning today! Let's take a break and continue tomorrow.",
  ms: "Kita sudah banyak belajar hari ini! Jom berehat dan sambung esok.",
  "ms-arab": "کيت سوده باڽق بلاجر هاري اين! جوم برحيت دان سمبوڠ ايسوق.",
  ar: "تعلّمنا الكثير اليوم! لنأخذ استراحة ونكمل غدًا.",
  fr: "On a beaucoup appris aujourd'hui ! Faisons une pause et continuons demain.",
  es: "¡Hoy hemos aprendido mucho! Tomemos un descanso y sigamos mañana.",
  pt: "Hoje aprendemos muito! Vamos fazer uma pausa e continuar amanhã.",
  te: "ఈ రోజు మనం చాలా నేర్చుకున్నాం! కాసేపు విరామం తీసుకుని రేపు కొనసాగిద్దాం.",
  mr: "आज आपण खूप शिकलो! आता विश्रांती घेऊया आणि उद्या पुढे चालू ठेवूया.",
  hi: "आज हमने बहुत कुछ सीखा! चलो अब आराम करते हैं और कल आगे बढ़ते हैं।",
};

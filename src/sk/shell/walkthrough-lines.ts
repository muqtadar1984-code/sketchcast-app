// 2026-10-30: SK's reply to "Show me around" (rules.ts, no model) as the
// walkthrough restarts, ten locales. The same string lives in
// src/i18n/messages/*.json at sk.walkthrough.ui.startLine (the tour's own
// copy); walkthrough-rule.test.ts holds the two equal.

export const WALKTHROUGH_START: Record<string, string> = {
  en: "Here's the tour. I'll show you around.",
  ms: "Ini panduannya. Saya akan tunjukkan sekeliling.",
  "ms-arab": "اين ڤندوانڽ. ساي اکن تونجوقکن سکليليڠ.",
  ar: "هذه هي الجولة. سأعرّفك بالمكان.",
  fr: "Voici la visite. Je vous fais faire le tour.",
  es: "Aquí empieza el recorrido. Te enseño todo.",
  pt: "Este é o tour. Vou te mostrar tudo.",
  te: "ఇదిగో టూర్. నేను మీకు అన్నీ చూపిస్తాను.",
  mr: "हा आहे टूर. मी तुम्हाला सगळे फिरून दाखवतो.",
  hi: "यह रहा टूर। मैं आपको सब कुछ दिखाता हूँ।",
};

/** 2026-10-30: the one line the model gets while a guided tour is on in her
 *  tab (founder: "Hi, continue with the tour?" got "I don't have a tour to
 *  continue here"). English, like the rest of the system prompt. */
export function walkPromptLine(w: { paused: boolean; stop: string; index: number; total: number }): string {
  const where = w.stop ? `stop "${w.stop}"${w.total ? ` (${w.index + 1} of ${w.total})` : ""}` : "a stop";
  return `A guided tour of the app is ${w.paused ? "paused" : "running"} at ${where}. The user can say "continue the tour", "next", "back" or "skip the tour" to move it; if they ask about the tour, tell them that — never say there is no tour.`;
}

// The corner avatar's SPEECH BUBBLE — the pure rules (founder 2026-10-30:
// "get rid of this boxed approach … just keep the avatar to the bottom right
// … show the thought bubble on what the avatar is saying").
//
// What the bubble shows, one message at a time:
//   speech   — the sentence SK is saying NOW (the speech coordinator's
//              onCurrent); fades SPEECH_LINGER_MS after the voice stops.
//   reply    — a new answer while read-aloud is OFF: its first sentences, with
//              "More" (opens the conversation) when there is more; fades after
//              its reading time (55 ms a character, at least 4 s).
//   greeting — the warm start's greeting, once per tab session on a home page.
//   error    — in the Shell's existing wording; reading time like a reply.
//   confirm  — a confirmation card arrived while the text is hidden: "I need
//              your confirmation" + Show. It stays until the card is shown or
//              settled (the card has its own expiry).
//   hearing  — (2026-10-30) while the mic listens and she is speaking, the
//              words so far in a muted "you're saying…" style, so she can see
//              SK is still listening; a tap on the avatar ends her turn and
//              sends it. Not a message: it shows over the others and leaves
//              them as they were (hearingPreview).
// Hovering or focusing the bubble holds it open (the clock restarts when she
// leaves); × closes the message. While a tour runs the bubble is pinned open
// with the tour's caption and controls (the Shell renders those).
//
// PURE: the clock comes in on each event (`at`), the Shell owns the timer —
// bubbleFadeAt() says when, an `expire` event closes that message.

export type BubbleKind = "speech" | "reply" | "greeting" | "error" | "confirm";

export type BubbleMsg = {
  /** New per message: an `expire` or × meant for an older one never closes this. */
  id: number;
  kind: BubbleKind;
  text: string;
  /** A reply cut short: "More" opens the conversation. */
  more: boolean;
  /** The answer's language and direction (the `lang` event), when known. */
  lang?: string;
  dir?: "ltr" | "rtl";
  /** The turn a reply belongs to: its later text updates the SAME message. */
  key?: string;
  /** Speech still playing (no fade yet). */
  speaking: boolean;
  /** When the fade clock started: the last change, or the end of the speech. */
  since: number;
};

export type BubbleState = {
  msg: BubbleMsg | null;
  /** Closed by ×, by its fade, or never opened. */
  closed: boolean;
  /** Hovered or focused: no fade while she is on it. */
  hold: boolean;
  seq: number;
};

export const BUBBLE_INITIAL: BubbleState = { msg: null, closed: true, hold: false, seq: 0 };

/** After the voice stops, the last sentence stays this long. */
export const SPEECH_LINGER_MS = 4000;
/** Text-only messages: reading time per character, with a floor. */
export const BUBBLE_READ_MS_PER_CHAR = 55;
export const BUBBLE_READ_MIN_MS = 4000;
/** The greeting opens SK on a page: at least this long before it fades. */
export const GREETING_MIN_MS = 10000;
/** A text-only reply shows its first sentences (and at most this many characters). */
export const PREVIEW_SENTENCES = 2;
export const PREVIEW_MAX_CHARS = 240;
/** The greeting is shown once per tab session (sessionStorage). */
export const GREETED_KEY = "sk.greeted";

export type BubbleEvent =
  | { type: "sentence"; text: string; lang?: string; at: number }
  | { type: "speechEnd"; at: number }
  | { type: "reply"; key: string; text: string; lang?: string; dir?: "ltr" | "rtl"; at: number }
  | { type: "greeting"; text: string; at: number }
  | { type: "error"; text: string; at: number }
  | { type: "confirm"; text: string; at: number }
  | { type: "confirmDone" }
  | { type: "hold"; on: boolean; at: number }
  | { type: "close" }
  | { type: "expire"; id: number }
  | { type: "clear" };

/** How long a text-only message stays: 55 ms a character, at least 4 s. */
export function bubbleReadingMs(text: string): number {
  return Math.max(BUBBLE_READ_MIN_MS, BUBBLE_READ_MS_PER_CHAR * String(text ?? "").trim().length);
}

const SENTENCE_END = /(?<=[.!?؟।])\s+/u;

/** The first sentences of a reply, and whether there is more after them. */
export function replyPreview(text: string, sentences: number = PREVIEW_SENTENCES, maxChars: number = PREVIEW_MAX_CHARS): { text: string; more: boolean } {
  const full = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { text: "", more: false };
  const parts = full.split(SENTENCE_END).filter(Boolean);
  let head = parts.slice(0, Math.max(1, sentences)).join(" ");
  if (head.length > maxChars) {
    const cut = head.slice(0, maxChars);
    const sp = cut.lastIndexOf(" ");
    head = `${(sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return { text: head, more: head.length < full.length };
}

function fresh(s: BubbleState, msg: Omit<BubbleMsg, "id">): BubbleState {
  const seq = s.seq + 1;
  return { ...s, seq, closed: false, msg: { ...msg, id: seq } };
}

export function bubbleReduce(s: BubbleState, e: BubbleEvent): BubbleState {
  const m = s.msg;
  switch (e.type) {
    case "sentence": {
      if (!e.text.trim()) return s;
      // A confirmation waiting stays in the bubble (the voice still plays).
      if (m?.kind === "confirm" && !s.closed) return s;
      // The next sentence of the same speech: the same message (a × stays closed).
      if (m?.kind === "speech" && m.speaking) return { ...s, msg: { ...m, text: e.text, lang: e.lang ?? m.lang, since: e.at } };
      return fresh(s, { kind: "speech", text: e.text, more: false, lang: e.lang, speaking: true, since: e.at });
    }
    case "speechEnd":
      if (m?.kind !== "speech" || !m.speaking) return s;
      return { ...s, msg: { ...m, speaking: false, since: e.at } };
    case "reply": {
      const p = replyPreview(e.text);
      if (!p.text) return s;
      if (m?.kind === "confirm" && !s.closed) return s;
      if (m?.kind === "reply" && m.key === e.key) return { ...s, msg: { ...m, text: p.text, more: p.more, lang: e.lang ?? m.lang, dir: e.dir ?? m.dir, since: e.at } };
      return fresh(s, { kind: "reply", key: e.key, text: p.text, more: p.more, lang: e.lang, dir: e.dir, speaking: false, since: e.at });
    }
    case "greeting": {
      if (!e.text.trim()) return s;
      // Never over something she is reading or hearing.
      if (m && !s.closed) return s;
      const p = replyPreview(e.text, 3);
      return fresh(s, { kind: "greeting", text: p.text, more: p.more, speaking: false, since: e.at });
    }
    case "error":
      if (!e.text.trim()) return s;
      return fresh(s, { kind: "error", text: e.text, more: false, speaking: false, since: e.at });
    case "confirm":
      return fresh(s, { kind: "confirm", text: e.text, more: false, speaking: false, since: e.at });
    case "confirmDone":
      return m?.kind === "confirm" ? { ...s, msg: null, closed: true } : s;
    case "hold":
      if (e.on) return { ...s, hold: true };
      // She left the bubble: its clock starts again from now.
      return { ...s, hold: false, msg: m && !m.speaking ? { ...m, since: e.at } : m };
    case "close":
      return { ...s, closed: true };
    case "expire":
      return m && m.id === e.id ? { ...s, closed: true } : s;
    case "clear":
      return { ...s, msg: null, closed: true };
  }
}

/** When the open message fades (epoch ms), or null when nothing will fade it:
 *  nothing open, a tour pinning the bubble, her pointer or focus on it, a
 *  confirmation waiting, or SK still speaking. */
export function bubbleFadeAt(s: BubbleState, opts: { tour?: boolean } = {}): number | null {
  const m = s.msg;
  if (!m || s.closed || s.hold || opts.tour || m.kind === "confirm" || m.speaking) return null;
  if (m.kind === "speech") return m.since + SPEECH_LINGER_MS;
  // The greeting is how SK starts (founder 2026-10-30): it stays a while longer.
  if (m.kind === "greeting") return m.since + Math.max(GREETING_MIN_MS, bubbleReadingMs(m.text));
  return m.since + bubbleReadingMs(m.text);
}

/** Whether the bubble is open: always while a tour runs, else an open message. */
export function bubbleOpen(s: BubbleState, opts: { tour?: boolean } = {}): boolean {
  return !!opts.tour || (!!s.msg && !s.closed);
}

/** The greeting shows once per tab session where SK is allowed to greet
 *  (any page with the corner avatar, not the Board or the lesson player — the
 *  launcher decides `home`), never over a tour. */
export function shouldGreet(input: { home: boolean; greeted: boolean; tour: boolean; text: string | null | undefined }): boolean {
  return input.home && !input.greeted && !input.tour && !!input.text?.trim();
}

// ── 2026-10-30: "you're saying…" — the running transcript while she speaks ──

/** The bubble shows at most this much of what she is saying: the END of it. */
export const HEARING_MAX_CHARS = 160;

/** What the bubble shows of her words while the mic listens, or null when it
 *  shows none (not listening, nothing heard yet, or a tour pins the bubble).
 *  A long utterance shows its tail, cut at a word, after "…". */
export function hearingPreview(text: string | null | undefined, opts: { listening: boolean; tour?: boolean }, max: number = HEARING_MAX_CHARS): string | null {
  if (!opts.listening || opts.tour) return null;
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const tail = t.slice(t.length - max);
  const sp = tail.indexOf(" ");
  return `…${(sp >= 0 && sp < max * 0.4 ? tail.slice(sp + 1) : tail).trimStart()}`;
}

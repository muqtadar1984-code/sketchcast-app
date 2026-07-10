"use client";

import { useEffect, useRef, useState } from "react";
import CoachRecap from "./coach-recap";
import TutorBoard, { type TutorBoardHandle } from "./tutor-board";

type Msg = { role: "student" | "coach"; content: string; videoUrl?: string };

// Phase 2 "Draw" mode — behind its own client flag (baked at BUILD time, so a
// fresh Vercel build is needed after enabling it).
const SKETCH_ON = process.env.NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH === "true";
// Phase 1 persistent TAL board (ERE). When on, Coach teaches on ONE board that
// mutates turn-to-turn instead of the per-reply clip; text is the graceful
// fallback. Its own build-time flag, so it lights up independently of Draw mode.
const BOARD_ON = process.env.NEXT_PUBLIC_FEATURE_AI_TUTOR_TAL === "true";

// Browser speech-to-text for the mic button (free, client-side). Not in the
// standard DOM lib types, so keep a minimal shape and feature-detect it.
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
function speechRecognitionCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// "Ask Coach" — the AI tutor surface. Streams grounded, thread-aware answers, can
// speak them aloud, and (in Draw mode) answers by drawing an animated whiteboard
// clip. Access is fenced server-side (owner / assigned student / verified parent);
// this panel only renders and streams.
export default function AskCoach({
  generationId,
  studentId,
  chapterLabel,
  onClose,
}: {
  generationId: string;
  studentId?: string; // present only for the assigned student → shows their recap
  chapterLabel: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [readAloud, setReadAloud] = useState(true); // read answers aloud by default
  const [drawMode, setDrawMode] = useState(SKETCH_ON); // Draw by default when enabled
  const [maximized, setMaximized] = useState(false); // board takes ~70%, chat ~30% (BOARD_ON)
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<SpeechRec | null>(null);
  const boardRef = useRef<TutorBoardHandle>(null);

  // Feature-detect the mic after mount (deferred set → no SSR/hydration mismatch).
  useEffect(() => {
    const id = setTimeout(() => setMicSupported(!!speechRecognitionCtor()), 0);
    return () => clearTimeout(id);
  }, []);

  // Load the panel-open greeting + readiness.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tutor?generationId=${encodeURIComponent(generationId)}`);
        const data = await res.json();
        if (cancelled) return;
        setReady(!!data.ready);
        if (data.greeting) setMessages([{ role: "coach", content: data.greeting }]);
        else if (data.upgrade) setError("The AI Coach is a Pro+ feature — ask your teacher or parent to upgrade.");
        else if (!data.ready) setError("The coach isn't ready for this lesson yet.");
      } catch {
        if (!cancelled) {
          setReady(false);
          setError("Couldn't reach the coach. Try again in a moment.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generationId]);

  // Autoscroll to the newest message; stop speech/polling/mic when the panel closes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);
  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
      if (pollRef.current) clearInterval(pollRef.current);
      recognitionRef.current?.stop();
    },
    [],
  );

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function speakBrowser(text: string) {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1.05; // a touch warmer
    synth.cancel();
    synth.speak(u);
  }

  // Mic → speech-to-text into the input box (free, client-side).
  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (e) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        setInput(t);
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => {
        setListening(false);
        recognitionRef.current = null;
        inputRef.current?.focus();
      };
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
    }
  }

  // Read a logged coach message aloud (browser voice, or a premium clip when the
  // server returns one). `text` is the local fallback the browser speaks.
  async function speak(messageId: string, text: string) {
    try {
      const res = await fetch("/api/tutor/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, generationId }),
      });
      const v = await res.json();
      if (v?.provider === "elevenlabs" && v.audioUrl) {
        void new Audio(v.audioUrl).play().catch(() => {});
        return;
      }
      speakBrowser(text);
    } catch {
      /* voice is best-effort */
    }
  }

  // The recent thread, so the coach has memory of the conversation. A drawn turn is
  // represented so the model knows a diagram was given for that step. The opening
  // GREETING (a coach message before any student turn) is excluded — it isn't part
  // of the Q&A, and including it would make every first question look "contextual"
  // and needlessly bypass the answer cache.
  function threadHistory(): Msg[] {
    const firstStudent = messages.findIndex((m) => m.role === "student");
    const thread = firstStudent === -1 ? [] : messages.slice(firstStudent);
    return thread
      .filter((m) => m.content || m.videoUrl)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.videoUrl ? "(I drew a diagram to explain that.)" : m.content }));
  }

  // Update the trailing coach placeholder in place.
  const patchLastCoach = (patch: Partial<Msg>) =>
    setMessages((m) => {
      const c = [...m];
      const i = c.length - 1;
      if (i >= 0 && c[i].role === "coach") c[i] = { ...c[i], ...patch };
      return c;
    });

  async function doAsk(q: string, history: Msg[]) {
    try {
      const res = await fetch("/api/tutor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, generationId, history }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "The coach is unavailable right now.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
      let coachId = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          let ev = "";
          let data = "";
          for (const line of evt.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) {
              const raw = line.slice(5);
              data += raw.startsWith(" ") ? raw.slice(1) : raw; // keep the chunk's own spacing
            }
          }
          if (ev === "text") {
            full += data;
            patchLastCoach({ content: full });
          } else if (ev === "mid") {
            coachId = data;
          } else if (ev === "error") {
            setError(data || "The coach had trouble answering.");
          }
        }
      }
      if (!full) setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
      if (coachId && readAloud && full) void speak(coachId, full);
    } catch (e) {
      setError((e as Error).message);
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    }
  }

  function pollSketchIntoMessage(sketchId: string): Promise<void> {
    return new Promise((resolve) => {
      stopPolling();
      let ticks = 0;
      pollRef.current = setInterval(async () => {
        if (++ticks > 40) {
          // ~2 min guard
          patchLastCoach({ content: "That sketch is taking a while — try again, or turn Draw off for a quick answer." });
          stopPolling();
          resolve();
          return;
        }
        try {
          const res = await fetch(`/api/tutor/sketch?sketchId=${encodeURIComponent(sketchId)}&generationId=${encodeURIComponent(generationId)}`);
          const d = await res.json();
          if (d.status === "done" && d.url) {
            patchLastCoach({ content: "", videoUrl: d.url });
            stopPolling();
            resolve();
          } else if (d.status === "error") {
            patchLastCoach({ content: "Couldn't draw that one — try asking in words." });
            stopPolling();
            resolve();
          }
        } catch {
          /* transient — keep polling */
        }
      }, 3000);
    });
  }

  async function doSketch(q: string, history: Msg[]) {
    try {
      const res = await fetch("/api/tutor/sketch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId, concept: q, history }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        patchLastCoach({ content: d?.error || "Couldn't start that sketch." });
        return;
      }
      if (d.status === "done" && d.url) patchLastCoach({ content: "", videoUrl: d.url });
      else if (d.status === "pending" && d.sketchId) await pollSketchIntoMessage(d.sketchId);
      else patchLastCoach({ content: "Couldn't draw that — try again." });
    } catch {
      patchLastCoach({ content: "Couldn't reach the coach to draw that." });
    }
  }

  // The persistent board (ERE) is the coach's main teaching surface when enabled:
  // it draws on ONE board that mutates each turn and narrates. Returns false when
  // the board declines this turn (no grounding / engine failure) so we fall back
  // to the existing text stream — the board is an enhancement, never a hard dep.
  async function doBoard(q: string): Promise<boolean> {
    const r = await boardRef.current?.ask(q);
    if (!r || r.mode !== "board") return false;
    // Show the spoken narration as the coach's transcript line (the diagram is on
    // the board above); keep a gentle default if the turn was purely visual.
    patchLastCoach({ content: r.narration?.trim() || "✏️ (shown on the board above)" });
    return true;
  }

  async function submit() {
    const q = input.trim();
    if (!q || busy || ready === false) return;
    setInput("");
    setError(null);
    setBusy(true);
    const history = threadHistory();
    const drawing = drawMode && SKETCH_ON;
    setMessages((m) => [
      ...m,
      { role: "student", content: q },
      { role: "coach", content: BOARD_ON ? "🖍️ Coach is teaching on the board…" : drawing ? "🖍️ Coach is drawing this out…" : "" },
    ]);
    try {
      // Board first when enabled; on decline, degrade to the existing draw/text path.
      if (BOARD_ON && (await doBoard(q))) return;
      if (BOARD_ON && !drawing) patchLastCoach({ content: "" }); // clear the board placeholder before the text stream
      if (drawing) await doSketch(q, history);
      else await doAsk(q, history);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  // Board pane can be maximized to a two-pane split (board ~70% / chat ~30%);
  // only meaningful when the persistent board is on.
  const twoPane = BOARD_ON && maximized;

  const messageList = (
    <>
      {ready === null && <p className="text-sm text-[#98A0A9]">Waking the coach…</p>}
      {messages.map((m, i) => (
        <div key={i} className={m.role === "student" ? "flex justify-end" : "flex justify-start"}>
          {m.videoUrl ? (
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm p-1.5 bg-[#F4F6F3]">
              <video src={m.videoUrl} controls playsInline className="rounded-xl w-full" />
              <p className="text-[11px] text-[#98A0A9] px-2 py-1">Here&apos;s a quick sketch.</p>
            </div>
          ) : (
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                m.role === "student"
                  ? "bg-[#E2F4F1] text-[#0C4E47] rounded-br-sm"
                  : "bg-[#F4F6F3] text-[#14181F] rounded-bl-sm"
              }`}
            >
              {m.content || <span className="text-[#98A0A9]">…</span>}
            </div>
          )}
        </div>
      ))}
      {error && <p className="text-xs text-[#B42318]">{error}</p>}
    </>
  );

  const inputBar = (
    <div className="px-4 py-3 border-t border-[#EEF0EC]">
      {studentId && <CoachRecap studentId={studentId} generationId={generationId} />}
      <form
        className="flex items-center gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {micSupported && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={ready === false}
            aria-pressed={listening}
            title={listening ? "Stop listening" : "Speak your question"}
            className={`h-9 w-9 rounded-lg border text-base shrink-0 disabled:opacity-40 ${
              listening ? "border-[#B42318] text-[#B42318] animate-pulse" : "border-[#E6E8E4] text-[#5B6470]"
            }`}
          >
            🎤
          </button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={500}
          disabled={ready === false}
          placeholder={
            listening
              ? "Listening…"
              : ready === false
                ? "Coach unavailable"
                : BOARD_ON
                  ? "Ask Coach to teach this on the board…"
                  : drawMode
                    ? "Ask Coach to draw…"
                    : "Ask about this lesson…"
          }
          className="field h-9 px-3 text-sm flex-1"
        />
        <button type="submit" disabled={busy || !input.trim() || ready === false} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
          {busy ? "…" : !BOARD_ON && drawMode && SKETCH_ON ? "Draw" : "Ask"}
        </button>
      </form>
      <p className="text-[10px] text-[#98A0A9] mt-1.5">
        {BOARD_ON
          ? "Coach teaches on the board — each follow-up builds on what's already drawn."
          : drawMode && SKETCH_ON
            ? "Draw mode: Coach answers with a quick whiteboard clip. Turn it off for instant text."
            : "Coach answers only from this lesson — it won't do graded work for you."}
      </p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={`card w-full flex flex-col ${twoPane ? "max-w-[1400px] h-[92vh]" : "max-w-lg max-h-[88vh]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5">
              <span aria-hidden>🎓</span> Ask Coach
            </div>
            <div className="text-xs text-[#98A0A9] truncate">{chapterLabel}</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {SKETCH_ON && !BOARD_ON && (
              <button
                onClick={() => setDrawMode((v) => !v)}
                aria-pressed={drawMode}
                className={`text-xs font-medium ${drawMode ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
                title="When on, Coach answers by drawing a whiteboard clip"
              >
                {drawMode ? "✏️ Draw: on" : "✏️ Draw: off"}
              </button>
            )}
            <button
              onClick={() => setReadAloud((v) => !v)}
              className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
              aria-pressed={readAloud}
            >
              {readAloud ? "🔊 Read aloud" : "🔈 Read aloud"}
            </button>
            {BOARD_ON && (
              <button
                onClick={() => setMaximized((v) => !v)}
                aria-pressed={maximized}
                title={maximized ? "Shrink the board" : "Expand the board"}
                className="text-[#98A0A9] hover:text-[#5B6470] text-base leading-none"
              >
                {maximized ? "🗗" : "🗖"}
              </button>
            )}
            <button onClick={onClose} className="text-[#98A0A9] hover:text-[#5B6470] text-lg leading-none" aria-label="Close">
              ×
            </button>
          </div>
        </div>

        {twoPane ? (
          // Maximized: whiteboard ~70% on the left, chat ~30% on the right.
          <div className="flex-1 flex min-h-0">
            <div className="w-[70%] border-r border-[#EEF0EC] bg-[#FBFBF9] p-3 min-h-0">
              <TutorBoard ref={boardRef} generationId={generationId} readAloud={readAloud} fit />
            </div>
            <div className="w-[30%] flex flex-col min-h-0">
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {messageList}
              </div>
              {inputBar}
            </div>
          </div>
        ) : (
          // Minimized: board (if any) flows above the chat in one column.
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {BOARD_ON && <TutorBoard ref={boardRef} generationId={generationId} readAloud={readAloud} />}
              {messageList}
            </div>
            {inputBar}
          </>
        )}
      </div>
    </div>
  );
}

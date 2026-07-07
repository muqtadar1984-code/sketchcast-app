"use client";

import { useEffect, useRef, useState } from "react";
import CoachRecap from "./coach-recap";

type Msg = { role: "student" | "coach"; content: string };

// Phase 2 "Draw this" — separate client flag so it stays dark until migration
// 0028 + the sketch worker are live (the /api/tutor/sketch route is authoritative).
const SKETCH_ON = process.env.NEXT_PUBLIC_FEATURE_AI_TUTOR_SKETCH === "true";

// "Ask Coach" — the Pro+ AI tutor surface. Opens on an assigned lesson, greets
// the student (personalised to their weak spots), then streams grounded answers
// from /api/tutor. Optional read-aloud uses the free browser voice by default and
// a premium clip when the server returns one. All access is fenced server-side;
// this panel only renders and streams.
export default function AskCoach({
  generationId,
  studentId,
  chapterLabel,
  onClose,
}: {
  generationId: string;
  studentId: string;
  chapterLabel: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sketch, setSketch] = useState<{ status: "idle" | "pending" | "done" | "error"; url?: string }>({ status: "idle" });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Autoscroll to the newest message; stop any speech when the panel closes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);
  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Sketch rendering lives in the batch worker, so we enqueue then poll for the
  // finished clip. Identical sketches replay instantly from the shared cache.
  function pollSketch(sketchId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/tutor/sketch?sketchId=${encodeURIComponent(sketchId)}&generationId=${encodeURIComponent(generationId)}`);
        const d = await res.json();
        if (d.status === "done" && d.url) {
          setSketch({ status: "done", url: d.url });
          stopPolling();
        } else if (d.status === "error") {
          setSketch({ status: "error" });
          stopPolling();
        }
      } catch {
        /* transient — keep polling */
      }
    }, 3000);
  }

  async function requestSketch() {
    if (sketch.status === "pending" || busy || ready === false) return;
    setError(null);
    setSketch({ status: "pending" });
    try {
      const res = await fetch("/api/tutor/sketch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId, concept: input.trim() || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSketch({ status: "idle" });
        setError(d?.error || "Couldn't start the sketch.");
        return;
      }
      if (d.status === "done" && d.url) setSketch({ status: "done", url: d.url });
      else if (d.status === "pending" && d.sketchId) pollSketch(d.sketchId);
      else setSketch({ status: "idle" });
    } catch {
      setSketch({ status: "idle" });
      setError("Couldn't reach the coach to draw that.");
    }
  }

  // messageId → the server decides voice (premium clip vs "speak in the browser");
  // `text` is what the browser path speaks locally (the reply the client already has).
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
      const synth = window.speechSynthesis;
      if (synth) {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1;
        u.pitch = 1.05; // a touch warmer
        synth.cancel();
        synth.speak(u);
      }
    } catch {
      /* voice is best-effort */
    }
  }

  async function ask() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: "student", content: q }, { role: "coach", content: "" }]);
    try {
      const res = await fetch("/api/tutor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, generationId }),
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
      const setCoach = (text: string) =>
        setMessages((m) => {
          const c = [...m];
          c[c.length - 1] = { role: "coach", content: text };
          return c;
        });

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
              // Keep the chunk's own spacing: strip only the single SSE space.
              const raw = line.slice(5);
              data += raw.startsWith(" ") ? raw.slice(1) : raw;
            }
          }
          if (ev === "text") {
            full += data;
            setCoach(full);
          } else if (ev === "mid") {
            coachId = data;
          } else if (ev === "error") {
            setError(data || "The coach had trouble answering.");
          }
        }
      }

      if (coachId && readAloud) void speak(coachId, full);
    } catch (e) {
      setError((e as Error).message);
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg flex flex-col max-h-[88vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5">
              <span aria-hidden>🎓</span> Ask Coach
            </div>
            <div className="text-xs text-[#98A0A9] truncate">{chapterLabel}</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {SKETCH_ON && (
              <button
                onClick={() => void requestSketch()}
                disabled={sketch.status === "pending" || busy || ready === false}
                className="text-xs font-medium text-[#0C8175] hover:underline disabled:opacity-40"
                title="Ask the coach to draw a quick explainer"
              >
                {sketch.status === "pending" ? "✏️ Sketching…" : "✏️ Draw this"}
              </button>
            )}
            <button
              onClick={() => setReadAloud((v) => !v)}
              className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
              aria-pressed={readAloud}
            >
              {readAloud ? "🔊 Read aloud" : "🔈 Read aloud"}
            </button>
            <button onClick={onClose} className="text-[#98A0A9] hover:text-[#5B6470] text-lg leading-none" aria-label="Close">
              ×
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {ready === null && <p className="text-sm text-[#98A0A9]">Waking the coach…</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "student" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                  m.role === "student"
                    ? "bg-[#E2F4F1] text-[#0C4E47] rounded-br-sm"
                    : "bg-[#F4F6F3] text-[#14181F] rounded-bl-sm"
                }`}
              >
                {m.content || <span className="text-[#98A0A9]">…</span>}
              </div>
            </div>
          ))}
          {sketch.status === "pending" && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm bg-[#F4F6F3] text-[#5B6470]">
                🖍️ Coach is sketching this out…
              </div>
            </div>
          )}
          {sketch.status === "done" && sketch.url && (
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-2xl rounded-bl-sm p-1.5 bg-[#F4F6F3]">
                <video src={sketch.url} controls playsInline className="rounded-xl w-full" />
                <p className="text-[11px] text-[#98A0A9] px-2 py-1">Here&apos;s a quick sketch.</p>
              </div>
            </div>
          )}
          {sketch.status === "error" && (
            <p className="text-xs text-[#B42318]">Couldn&apos;t draw that one — try asking a question instead.</p>
          )}
          {error && <p className="text-xs text-[#B42318]">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-[#EEF0EC]">
          <CoachRecap studentId={studentId} generationId={generationId} />
          <form
            className="flex items-center gap-2 mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={500}
              disabled={ready === false}
              placeholder={ready === false ? "Coach unavailable" : "Ask about this lesson…"
              }
              className="field h-9 px-3 text-sm flex-1"
            />
            <button type="submit" disabled={busy || !input.trim() || ready === false} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
              {busy ? "…" : "Ask"}
            </button>
          </form>
          <p className="text-[10px] text-[#98A0A9] mt-1.5">Coach answers only from this lesson — it won&apos;t do graded work for you.</p>
        </div>
      </div>
    </div>
  );
}

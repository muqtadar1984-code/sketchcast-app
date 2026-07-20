"use client";

import { useEffect, useRef, useState } from "react";
import { StreamSpeaker, micSupported, startDictation } from "@/utils/assistant/voice-client";

type Msg = { role: "you" | "assistant"; content: string; greeting?: boolean };

// The school-briefing assistant — leadership chat over the live analytics
// snapshot (/api/school-assistant). Adapted from the student assistant panel:
// same SSE protocol and voice affordances, different audience — starter chips
// instead of book scope, and the conversation history rides with each request
// (the briefing is stateless server-side; nothing is persisted but the audit).
// Floating launcher — the leadership "School briefing" bot lives bottom-RIGHT,
// exactly where the teaching Assistant sits on teacher/student surfaces (that
// Assistant is hidden on the School pages, so a principal is offered the school
// briefing rather than a book tutor they don't use).
export function SchoolAssistantLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="fixed bottom-4 right-4 z-40">
        <button
          onClick={() => setOpen(true)}
          className="btn-primary h-11 px-4 text-sm rounded-full shadow-lg flex items-center gap-2"
          aria-label="Ask about your school"
          data-tour="school-assistant"
        >
          <span aria-hidden>🗒️</span> School briefing
        </button>
      </div>
      {open && <SchoolAssistantPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function SchoolAssistantPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [starters, setStarters] = useState<string[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [listening, setListening] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speakerRef = useRef<StreamSpeaker | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);

  // Post-mount feature detection (avoids SSR/hydration mismatch on the mic).
  useEffect(() => {
    const id = setTimeout(() => {
      setMic(micSupported());
      setReadAloud(localStorage.getItem("schoolAssistant.readAloud") === "on");
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // Warm-start: greeting + starter chips.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/school-assistant");
        const d = await res.json();
        if (cancelled) return;
        setReady(!!d.ready);
        // Non-destructive: never clobber a conversation that somehow started
        // first (submission is also gated on ready, belt and braces).
        if (d.greeting)
          setMessages((m) => (m.length ? m : [{ role: "assistant", content: d.greeting, greeting: true }]));
        if (Array.isArray(d.starters)) setStarters(d.starters);
        if (!res.ok) setError(d.error || "The briefing isn't available right now.");
      } catch {
        if (!cancelled) {
          setReady(false);
          setError("Couldn't reach the briefing. Try again in a moment.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);
  useEffect(
    () => () => {
      speakerRef.current?.stop();
      stopMicRef.current?.();
    },
    [],
  );

  function toggleReadAloud() {
    setReadAloud((v) => {
      const nv = !v;
      localStorage.setItem("schoolAssistant.readAloud", nv ? "on" : "off");
      if (!nv) {
        speakerRef.current?.stop();
        setSpeaking(false);
      }
      return nv;
    });
  }

  function stopSpeaking() {
    speakerRef.current?.stop();
    setSpeaking(false);
  }

  function toggleMic() {
    if (listening) {
      stopMicRef.current?.();
      return;
    }
    const stop = startDictation(
      (t) => setInput(t),
      () => {
        setListening(false);
        stopMicRef.current = null;
        inputRef.current?.focus();
      },
    );
    if (stop) {
      stopMicRef.current = stop;
      setListening(true);
    }
  }

  const patchLast = (patch: Partial<Msg>) =>
    setMessages((m) => {
      const c = [...m];
      const i = c.length - 1;
      if (i >= 0 && c[i]!.role === "assistant") c[i] = { ...c[i]!, ...patch };
      return c;
    });

  async function submit(preset?: string) {
    const q = (preset ?? input).trim();
    // Gate on ready !== true (not just false): submitting while the warm-start
    // GET is still in flight would let the arriving greeting race the stream.
    if (!q || busy || ready !== true) return;
    setInput("");
    setError(null);
    setBusy(true);
    stopSpeaking();
    const speaker = new StreamSpeaker();
    speakerRef.current = speaker;
    const willSpeak = readAloud && speaker.supported;
    if (willSpeak) setSpeaking(true);

    // History = the visible conversation so far, minus the greeting (dropped by
    // identity, not position); the server re-validates and caps it.
    const history = messages
      .filter((m) => m.content && !m.greeting)
      .slice(-8)
      .map((m) => ({ role: m.role === "you" ? "user" : "assistant", content: m.content }));

    setMessages((m) => [...m, { role: "you", content: q }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/school-assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "The briefing is unavailable right now.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let full = "";
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
            else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
          }
          if (ev === "text") {
            full += data;
            patchLast({ content: full });
            if (willSpeak) speaker.push(data);
          } else if (ev === "error") {
            setError(data);
          } else if (ev === "done") {
            if (willSpeak) speaker.flush();
          }
        }
      }
      if (!full) setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    } catch (e) {
      setError((e as Error).message);
      setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
    } finally {
      setBusy(false);
      if (willSpeak) window.setTimeout(() => setSpeaking(!!window.speechSynthesis?.speaking), 400);
      inputRef.current?.focus();
    }
  }

  const showStarters = ready === true && !busy && !messages.some((m) => !m.greeting);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg flex flex-col max-h-[86vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5">
              <span aria-hidden>🗒️</span> School briefing
            </div>
            <div className="text-xs text-[#98A0A9]">Answers from your live school data</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {speaking ? (
              <button onClick={stopSpeaking} className="text-xs font-medium text-[#B42318] hover:underline" title="Stop reading aloud">
                ■ Stop
              </button>
            ) : (
              <button
                onClick={toggleReadAloud}
                aria-pressed={readAloud}
                className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
              >
                {readAloud ? "🔊 Read aloud" : "🔈 Read aloud"}
              </button>
            )}
            <button onClick={onClose} className="text-[#98A0A9] hover:text-[#5B6470] text-lg leading-none" aria-label="Close">
              ×
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {ready === null && <p className="text-sm text-[#98A0A9]">Reading the latest school data…</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "you" ? "flex justify-end" : "flex flex-col items-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                  m.role === "you" ? "bg-[#E2F4F1] text-[#0C4E47] rounded-br-sm" : "bg-[#F4F6F3] text-[#14181F] rounded-bl-sm"
                }`}
              >
                {m.content || <span className="text-[#98A0A9]">…</span>}
              </div>
            </div>
          ))}
          {showStarters && (
            <div className="flex flex-wrap gap-2 pt-1">
              {starters.map((s) => (
                <button
                  key={s}
                  onClick={() => void submit(s)}
                  className="chip font-sans bg-[#E2F4F1] text-[#0C8175] hover:bg-[#D2ECE8] cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {error && <p className="text-xs text-[#B42318]">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-[#EEF0EC]">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {mic && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={ready !== true}
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
              maxLength={600}
              disabled={ready !== true}
              placeholder={listening ? "Listening…" : ready === null ? "Loading…" : "Ask about completion, at-risk students, grading…"}
              className="field h-9 px-3 text-sm flex-1"
            />
            <button type="submit" disabled={busy || !input.trim() || ready !== true} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
              {busy ? "…" : "Ask"}
            </button>
          </form>
          <p className="text-[10px] text-[#98A0A9] mt-1.5">
            Uses only the analytics you can already see here. Every briefing is recorded in the access audit.
          </p>
        </div>
      </div>
    </div>
  );
}

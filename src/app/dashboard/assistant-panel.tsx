"use client";

import { useEffect, useRef, useState } from "react";
import { StreamSpeaker, micSupported, startDictation } from "@/utils/assistant/voice-client";

type Msg = { role: "student" | "assistant"; content: string; source?: { book: string; label: string } | null };

// The AI Teaching Assistant panel — book-first chat with mic input and
// read-aloud (browser voice, on by default, starts as the answer streams and
// can be stopped). Grounded answers carry a "from your [chapter]" tag. Warm-start
// GET on mount pre-loads the greeting + book scope so the first turn is fast.
export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [ready, setReady] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [listening, setListening] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speakerRef = useRef<StreamSpeaker | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);

  // Deferred (post-mount) so client-only feature detection can't cause an
  // SSR/hydration mismatch on the conditionally-rendered mic button.
  useEffect(() => {
    const id = setTimeout(() => {
      setMic(micSupported());
      setReadAloud(localStorage.getItem("assistant.readAloud") !== "off");
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // Warm-start: greeting + readiness before the student types.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/assistant");
        const d = await res.json();
        if (cancelled) return;
        setReady(!!d.ready);
        if (d.greeting) setMessages([{ role: "assistant", content: d.greeting }]);
        else if (!res.ok) setError("The assistant isn't available right now.");
      } catch {
        if (!cancelled) {
          setReady(false);
          setError("Couldn't reach the assistant. Try again in a moment.");
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
      localStorage.setItem("assistant.readAloud", nv ? "on" : "off");
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

  async function submit() {
    const q = input.trim();
    if (!q || busy || ready === false) return;
    setInput("");
    setError(null);
    setBusy(true);
    stopSpeaking();
    const speaker = new StreamSpeaker();
    speakerRef.current = speaker;
    const willSpeak = readAloud && speaker.supported;
    if (willSpeak) setSpeaking(true);

    setMessages((m) => [...m, { role: "student", content: q }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "The assistant is unavailable right now.");
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
          if (ev === "meta") {
            try {
              const m = JSON.parse(data);
              if (m.source) patchLast({ source: { book: m.source.book, label: m.source.label } });
            } catch {
              /* ignore */
            }
          } else if (ev === "text") {
            full += data;
            patchLast({ content: full });
            if (willSpeak) speaker.push(data);
          } else if (ev === "tool") {
            /* a quiet "checking the maths" beat — kept implicit to avoid clutter */
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
      // Speaking continues until the queue drains; reflect that in the UI.
      if (willSpeak) window.setTimeout(() => setSpeaking(!!window.speechSynthesis?.speaking), 400);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-md flex flex-col max-h-[86vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5">
              <span aria-hidden>🎓</span> AI Teaching Assistant
            </div>
            <div className="text-xs text-[#98A0A9]">Answers from your books</div>
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
          {ready === null && <p className="text-sm text-[#98A0A9]">Getting your books ready…</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "student" ? "flex justify-end" : "flex flex-col items-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                  m.role === "student" ? "bg-[#E2F4F1] text-[#0C4E47] rounded-br-sm" : "bg-[#F4F6F3] text-[#14181F] rounded-bl-sm"
                }`}
              >
                {m.content || <span className="text-[#98A0A9]">…</span>}
              </div>
              {m.source && (
                <span className="text-[10px] text-[#0C8175] mt-1 ml-1">📖 from your {m.source.label}</span>
              )}
            </div>
          ))}
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
              maxLength={600}
              disabled={ready === false}
              placeholder={listening ? "Listening…" : ready === false ? "No book yet" : "Ask about your books…"}
              className="field h-9 px-3 text-sm flex-1"
            />
            <button type="submit" disabled={busy || !input.trim() || ready === false} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
              {busy ? "…" : "Ask"}
            </button>
          </form>
          <p className="text-[10px] text-[#98A0A9] mt-1.5">
            I help you learn from your books — hints and method, never the graded answers.
          </p>
        </div>
      </div>
    </div>
  );
}

// Browser voice adapter (client) for the AI Teaching Assistant. Wraps the Web
// Speech APIs behind a small interface so a hosted TTS/STT can be swapped in
// later without touching the panel. Read-aloud starts AS the answer streams
// (sentence by sentence), and is interruptible.

// ── Read-aloud (TTS) — streaming speaker ─────────────────────────────────────

export class StreamSpeaker {
  private buf = "";
  private queue: string[] = [];
  private speaking = false;
  private stopped = false;

  get supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Feed streamed text; complete sentences are spoken as they arrive. */
  push(chunk: string): void {
    if (!this.supported || this.stopped) return;
    this.buf += chunk;
    // Flush whole sentences; keep the trailing partial in the buffer.
    const parts = this.buf.split(/(?<=[.!?])\s+/);
    this.buf = parts.pop() ?? "";
    for (const s of parts) if (s.trim()) this.enqueue(s.trim());
  }

  /** Speak whatever remains (call when the stream ends). */
  flush(): void {
    if (this.buf.trim()) this.enqueue(this.buf.trim());
    this.buf = "";
  }

  private enqueue(sentence: string): void {
    this.queue.push(sentence);
    if (!this.speaking) this.next();
  }

  private next(): void {
    if (this.stopped || !this.queue.length) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    const u = new SpeechSynthesisUtterance(this.queue.shift()!);
    u.rate = 1;
    u.pitch = 1.05;
    u.onend = () => this.next();
    u.onerror = () => this.next();
    window.speechSynthesis.speak(u);
  }

  /** Stop immediately and drop the queue. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.buf = "";
    this.speaking = false;
    if (this.supported) window.speechSynthesis.cancel();
  }
}

// ── Mic input (STT) ──────────────────────────────────────────────────────────

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

function recognitionCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function micSupported(): boolean {
  return !!recognitionCtor();
}

/** Start dictation; onText gets the (interim + final) transcript, onEnd fires
 * when recognition stops. Returns a stop() handle, or null if unsupported.
 * (Note: browser STT is weaker on some accents — acceptable for now; this
 * adapter is the swap point for a hosted STT later.) */
export function startDictation(onText: (t: string) => void, onEnd: () => void): (() => void) | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  try {
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      onText(t);
    };
    rec.onerror = onEnd;
    rec.onend = onEnd;
    rec.start();
    return () => rec.stop();
  } catch {
    return null;
  }
}

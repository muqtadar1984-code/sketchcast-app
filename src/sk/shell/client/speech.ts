// SK's voice on the Shell and the Classroom Board (Final Plan 2026-10-28 §2.6,
// lifecycle 2 — "Speech playback | client | stops when: barge-in, navigation
// away from the page, explicit stop. Playback may continue while the mic is
// off."). S1 slice E.
//
// One coordinator owns three decisions the panel used to make ad hoc:
//
//   1. WHICH VOICE. `server: true` (the panel reads NEXT_PUBLIC_SK_TTS ===
//      "polly" or "google") asks the server-backed provider first; a
//      `SpeakUnavailable` from it (the route answered 404 = SK_TTS unset, or
//      429 tts_cap = the Google voice's monthly cap) makes the browser voice
//      sticky for the rest of the session; any other failure (network, 502,
//      autoplay) falls back for THAT line only, and three such failures in a
//      row also stick. `server: false` never constructs the server provider.
//   2. THE VIDEO. A line spoken while the Board's video is playing pauses it
//      once; the video resumes only when the whole queue has drained, and only
//      if SK itself paused it. A video the teacher left paused is never
//      resumed. A Board move announced through `announceMove` runs after its
//      line and then OWNS the Board's state: SK never resumes after a move
//      (`slide` leaves the end frame paused; `intro`/`segment`/`resume` are
//      already playing — no pause/resume fight). If the teacher restarts the
//      video while SK is still talking, SK neither re-pauses nor resumes it.
//   3. BARGE-IN. `stop()` clears the queue, cancels the provider, resolves
//      every pending `say`, and does NOT resume the video: the teacher is
//      about to speak (push-to-talk pressed, hands-free started, a new
//      question sent) or asked for silence (Stop, read-aloud off, pagehide);
//      "continue" is one word away and never surprises a class.
//   4. NO GAP (2026-10-30). With the server voice, a sentence's audio is
//      requested the moment the sentence is complete in the stream, and the
//      next PREFETCH_AHEAD sentences' audio is fetched while the current one
//      plays — so sentence 2 is ready when sentence 1 ends. Every line
//      carries its own language (and so its own provider and voice): a
//      language change costs nothing extra. Barge-in aborts every prefetch;
//      the browser voice needs none (it synthesises as it speaks).
//
// PURE: providers, the Board and the clock are injected, so the suite runs in
// node on fakes. Sentence splitting is StreamSpeaker's (src/utils/assistant/
// voice-client.ts) plus the Arabic ؟ and the Devanagari ।, every sentence
// passing through speakableText so the voice never says "asterisk".

import { speakableText } from "@/utils/speakable";
import { BrowserSpeechProvider } from "@/sk/speech/browser";
import type { SpeechProvider, SpeechResult, VoiceId } from "@/sk/speech/provider";
import { PollyClientSpeechProvider, SpeakUnavailable } from "@/sk/speech/polly-client";

export type ServerSpeechMode = "polly" | "google";
export type SpeechMode = ServerSpeechMode | "browser";

/** The panel's half of provider selection: the PUBLIC flag only makes the
 * client ASK; the server's SK_TTS decides (404 → browser, sticky). */
export function speechMode(env: string | undefined | null): SpeechMode {
  const v = (env ?? "").trim().toLowerCase();
  return v === "polly" || v === "google" ? v : "browser";
}

/** The server-backed provider for one language. Polly's voices are English
 * only: any other language is read by the browser voice for it. Google has a
 * voice for every SK language, so every line goes to the server with its
 * `lang` (the route falls back to en-US for a language it has no voice for). */
export function serverProviderFor(mode: ServerSpeechMode, lang: string, look: () => "A" | "B"): SpeechProvider {
  if (mode === "google") return new PollyClientSpeechProvider(look, { lang });
  return lang.toLowerCase().startsWith("en") ? new PollyClientSpeechProvider(look) : new BrowserSpeechProvider(lang);
}

/** The slice of the Board the coordinator needs (the panel builds it over
 * SkBoardBridge.state()/run()). */
export type SpeechBoard = {
  isPlaying(): boolean;
  pause(): Promise<void>;
  resume(): Promise<void>;
};

export type WordMark = { charIndex: number; t: number; /** The sentence being spoken. */ text: string };

export type SpeechCoordinatorDeps = {
  /** Ask the server-backed provider first (NEXT_PUBLIC_SK_TTS === "polly" | "google"). */
  server: boolean;
  /** Which server voice `server` asks for — only reported by `mode` (default "polly"). */
  serverMode?: ServerSpeechMode;
  /** The server-backed provider for a language; built lazily, once per language. */
  makeProvider: (lang: string) => SpeechProvider;
  /** The browser provider for a language; built lazily, once per language. */
  fallback: (lang: string) => SpeechProvider;
  board?: SpeechBoard | null;
  /** BCP-47 tag used when `say` gives none (the page's locale). */
  defaultLang?: string;
  /** The VoiceId to request from a provider (by its id) for a language. */
  voice?: (providerId: string, lang: string) => VoiceId;
  /** Word boundaries as they happen — the future caption highlight. */
  onWord?: (mark: WordMark) => void;
  /** Flips as the queue starts and drains (the panel's Stop button). */
  onSpeaking?: (speaking: boolean) => void;
  /** The browser voice became sticky: "unavailable" = 404, "failing" = three errors. */
  onFallback?: (why: "unavailable" | "failing") => void;
};

export type SayOptions = { lang?: string };

export type SentenceStream = {
  /** Feed streamed text; complete sentences are queued as they arrive. */
  push(chunk: string): void;
  /** Queue whatever remains; resolves when it has been spoken. */
  flush(): Promise<void>;
};

export type SpeechCoordinator = {
  /** Queue a line (split into sentences). Resolves when its sentences have
   *  been spoken — or at once when read-aloud is off or they were stopped. */
  say(text: string, opts?: SayOptions): Promise<void>;
  /** A sentence-at-a-time feeder for a streamed answer. */
  stream(opts?: SayOptions): SentenceStream;
  /** Pause the video if it plays → speak `line` → run the Board move. The
   *  move then owns the Board's state: SK does not resume afterwards. */
  announceMove<T>(line: string, run: () => Promise<T>, opts?: SayOptions): Promise<T>;
  /** Barge-in / explicit stop: drop the queue, cancel the voice, never resume. */
  stop(): void;
  /** The read-aloud toggle. Off: `say` resolves at once and never touches the video. */
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** True while the queue is being spoken. */
  readonly speaking: boolean;
  /** The server mode ("polly" / "google") while it is still asked for, else "browser". */
  readonly mode: SpeechMode;
};

/** StreamSpeaker's split, widened to the Arabic question mark and the danda. */
export const SENTENCE_END = /(?<=[.!?؟।])\s+/;

/** Whole sentences, each through speakableText; markup-only sentences vanish. */
export function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(SENTENCE_END)
    .map((s) => speakableText(s))
    .filter(Boolean);
}

/** The server voice sticks to the browser after this many non-404 failures in a row. */
export const SERVER_FAILURES_TO_STICK = 3;

/** Sentences whose server audio is fetched ahead of the one playing. */
export const PREFETCH_AHEAD = 2;

/** One sentence's server audio, requested ahead of its turn. */
type Prefetch = { provider: SpeechProvider; result: Promise<SpeechResult>; abort: AbortController };

type Item = { text: string; lang: string; done: () => void; pre?: Prefetch };

export function createSpeechCoordinator(deps: SpeechCoordinatorDeps): SpeechCoordinator {
  const defaultLang = deps.defaultLang ?? "en-US";
  const voiceFor = deps.voice ?? ((id: string) => (id === "browser" ? "browser:default" : "polly:Matthew"));

  const servers = new Map<string, SpeechProvider>();
  const fallbacks = new Map<string, SpeechProvider>();
  let serverStuck = !deps.server; // false = still asking the server
  let serverFailures = 0;

  const queue: Item[] = [];
  let pumping = false;
  let enabled = true;
  /** Bumped by stop(); a line compares its own generation after every await. */
  let gen = 0;
  /** Whatever is speaking right now, for cancel(). */
  let active: SpeechProvider | null = null;
  /** Server requests in flight ahead of their turn (aborted on barge-in). */
  const prefetching = new Set<AbortController>();
  /** SK paused the video and owes it a resume when the queue drains. */
  let pausedByUs = false;
  /** The teacher restarted the video while SK talked: hands off until the queue drains. */
  let teacherTookOver = false;
  /** Outstanding announceMove()s: no resume on drain while a move is pending. */
  let holds = 0;

  const serverFor = (lang: string) => {
    let p = servers.get(lang);
    if (!p) servers.set(lang, (p = deps.makeProvider(lang)));
    return p;
  };
  const fallbackFor = (lang: string) => {
    let p = fallbacks.get(lang);
    if (!p) fallbacks.set(lang, (p = deps.fallback(lang)));
    return p;
  };

  /** Ask the server for one sentence's audio now (its turn may be later). */
  function request(item: Item): Prefetch {
    const provider = serverFor(item.lang);
    const abort = new AbortController();
    prefetching.add(abort);
    const result = provider.synthesize(item.text, voiceFor(provider.id, item.lang), { marks: ["word", "viseme"], signal: abort.signal });
    // Settled either way: no longer in flight. (This handler also keeps a
    // failed prefetch from being an unhandled rejection before its turn.)
    result.then(
      () => prefetching.delete(abort),
      () => prefetching.delete(abort),
    );
    return { provider, result, abort };
  }

  /** Start the server audio of the next PREFETCH_AHEAD queued sentences. */
  function prefetch(): void {
    if (serverStuck || !enabled) return;
    for (const item of queue.slice(0, PREFETCH_AHEAD)) item.pre ??= request(item);
  }

  /** Abort every request made ahead of its turn. */
  function dropPrefetches(): void {
    for (const a of prefetching) a.abort();
    prefetching.clear();
    for (const item of queue) delete item.pre;
  }

  const stick = (why: "unavailable" | "failing") => {
    if (serverStuck) return;
    serverStuck = true;
    // The browser voice speaks from now on: the server audio fetched ahead is not needed.
    dropPrefetches();
    deps.onFallback?.(why);
  };

  /** Speak one sentence through one provider (its audio already requested,
   *  or requested now); true when it played. Throws only what the provider
   *  threw, and only when this generation still stands. */
  async function through(p: SpeechProvider, text: string, lang: string, g: number, pending?: Promise<SpeechResult>): Promise<boolean> {
    active = p;
    try {
      const r = await (pending ?? p.synthesize(text, voiceFor(p.id, lang), { marks: ["word", "viseme"] }));
      if (g !== gen) return false;
      // The sentences after this one are fetched while it plays.
      prefetch();
      await r.play?.({ rate: 1, onWord: (w) => deps.onWord?.({ charIndex: w.charIndex, t: w.t, text }) });
      return g === gen;
    } finally {
      if (active === p) active = null;
    }
  }

  async function speakOne(item: Item, g: number): Promise<void> {
    if (!serverStuck) {
      const pre = item.pre ?? request(item);
      delete item.pre;
      try {
        await through(pre.provider, item.text, item.lang, g, pre.result);
        serverFailures = 0;
        return;
      } catch (e) {
        if (g !== gen) return; // a barge-in aborted the request: not a failure, no fallback
        if (e instanceof SpeakUnavailable || (e as { name?: unknown } | null)?.name === "SpeakUnavailable") stick("unavailable");
        else if (++serverFailures >= SERVER_FAILURES_TO_STICK) stick("failing");
        // this line still gets a voice: the browser's
      }
    }
    try {
      await through(fallbackFor(item.lang), item.text, item.lang, g);
    } catch {
      /* no voice at all: the transcript still has the words */
    }
  }

  /** Before a line: pause a playing video once — unless the teacher restarted
   *  it while SK was talking, in which case SK leaves it alone. */
  async function beforeLine(): Promise<void> {
    const b = deps.board;
    if (!b || !b.isPlaying()) return;
    if (pausedByUs) {
      // We paused it and it plays again: the teacher pressed play. Theirs now.
      pausedByUs = false;
      teacherTookOver = true;
      return;
    }
    if (teacherTookOver) return;
    await b.pause();
    pausedByUs = true;
  }

  /** After the queue drains: give the video back if (and only if) SK took it. */
  async function afterDrain(): Promise<void> {
    teacherTookOver = false;
    if (!pausedByUs || holds > 0) return;
    pausedByUs = false;
    const b = deps.board;
    if (!b || b.isPlaying()) return;
    try {
      await b.resume();
    } catch {
      /* the Board reports its own failures */
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    deps.onSpeaking?.(true);
    try {
      for (;;) {
        while (queue.length) {
          const item = queue.shift()!;
          const g = gen;
          // Keep PREFETCH_AHEAD sentences behind this one on their way.
          prefetch();
          try {
            await beforeLine();
            if (g === gen) await speakOne(item, g);
          } finally {
            item.done();
          }
        }
        await afterDrain();
        // A `say` resolves inside the loop above; its caller may queue the next
        // line while afterDrain() is still pending. Nothing may be left behind.
        if (!queue.length) break;
      }
    } finally {
      pumping = false;
      deps.onSpeaking?.(false);
    }
  }

  function enqueue(sentences: string[], lang: string): Promise<void> {
    if (!sentences.length) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let left = sentences.length;
      const done = () => {
        if (--left === 0) resolve();
      };
      for (const s of sentences) queue.push({ text: s, lang, done });
      // The first sentence's audio is requested NOW, in the same tick it was
      // complete — before the pump's await on the Board's video.
      prefetch();
      void pump();
    });
  }

  function say(text: string, opts: SayOptions = {}): Promise<void> {
    if (!enabled) return Promise.resolve();
    return enqueue(splitSentences(text), opts.lang ?? defaultLang);
  }

  function stop(): void {
    gen++;
    dropPrefetches();
    const dropped = queue.splice(0, queue.length);
    for (const it of dropped) it.done();
    try {
      active?.cancel?.();
    } catch {
      /* a provider with nothing to cancel */
    }
    // Barge-in rule: the teacher is about to speak, or asked for quiet. The
    // video stays where it is; SK's claim on it ends here.
    pausedByUs = false;
    teacherTookOver = false;
  }

  return {
    say,
    stream(opts = {}) {
      let buf = "";
      return {
        push(chunk) {
          if (!enabled) return;
          buf += chunk;
          const parts = buf.split(SENTENCE_END);
          buf = parts.pop() ?? "";
          const whole = parts.map((s) => speakableText(s)).filter(Boolean);
          if (whole.length) void enqueue(whole, opts.lang ?? defaultLang);
        },
        flush() {
          const tail = buf;
          buf = "";
          return say(tail, opts);
        },
      };
    },
    async announceMove(line, run, opts = {}) {
      holds++;
      try {
        // Queue the line FIRST (synchronously) so a text sentence that streams
        // in a moment later cannot overtake the move's own line.
        const spoken = say(line, opts);
        // The video is paused for the move even when there is nothing to say
        // (read-aloud off, an empty line): the Board was paused before SK acted
        // in S1 slice B, and that stays true. When the line speaks, the pump
        // has already paused it and this is a no-op.
        const b = deps.board;
        if (b && b.isPlaying() && !teacherTookOver) {
          await b.pause();
          pausedByUs = true;
        }
        await spoken;
        return await run();
      } finally {
        holds--;
        // The move decided the Board's state; SK has nothing to give back.
        pausedByUs = false;
        teacherTookOver = false;
      }
    },
    stop,
    setEnabled(on) {
      enabled = on;
    },
    get enabled() {
      return enabled;
    },
    get speaking() {
      return pumping;
    },
    get mode() {
      return serverStuck ? "browser" : (deps.serverMode ?? "polly");
    },
  };
}

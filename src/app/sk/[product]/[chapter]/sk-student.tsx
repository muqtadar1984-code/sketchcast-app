"use client";

// SK student client (B4 POC). Opens/resumes a session, plays the current
// asset as an Option-S segment (clip + hit map) through the board runtime,
// and sends typed questions, commands and check answers through /api/sk/*.
// The server owns the state: every response carries the session view and the
// client renders FROM it (contracts §5.4 — snapshot-authoritative). Browser
// speechSynthesis voices SK's lines through the SpeechProvider seam.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickBrowserVoice, RIG_LABELS, rigBaseForChoice, voiceGenderForChoice, type RigChoice } from "@/sk/board/avatar";
import { normaliseSegment, validateSegment, type OpentypeLike, type Segment } from "@/sk/board/engine";
import { SpikeRuntime, type HitMap, type PlayerState, type Rig } from "@/sk/board/runtime";
import { useMicSupported, useRigChoice } from "@/sk/board/use-rig-choice";
import { uuidv7 } from "@/sk/ids";
import type { SessionView } from "@/sk/loop";
import { BrowserSpeechProvider, browserSpeechAvailable } from "@/sk/speech/browser";
import type { CommandArgs, CommandName } from "@/sk/types";
import { startDictation } from "@/utils/assistant/voice-client";

type Props = { productId: string; chapter: number };
type LogLine = { at: string; who: "you" | "sk" | "sys"; text: string };

const dirname = (uri: string) => uri.slice(0, uri.lastIndexOf("/") + 1);

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** Parse an SSE body into (event, data) pairs as they arrive. */
async function* readSse(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (!dataLines.length) continue;
      try {
        yield { event, data: JSON.parse(dataLines.join("\n")) };
      } catch {
        yield { event, data: dataLines.join("\n") };
      }
    }
  }
}

export default function SkStudent({ productId, chapter }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const asideAudioRef = useRef<HTMLAudioElement>(null);
  const runtimeRef = useRef<SpikeRuntime | null>(null);
  const speechRef = useRef<BrowserSpeechProvider | null>(null);
  const fontRef = useRef<OpentypeLike | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [loaded, setLoaded] = useState<{ seg: Segment; hitmap: HitMap | null; rig: Rig | null; rigChoice: RigChoice; base: string; clipUri: string | null; assetId: string } | null>(null);
  const [player, setPlayer] = useState<PlayerState | "loading">("loading");
  const [clockMs, setClockMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState("");
  const [skText, setSkText] = useState("");
  // SK's look (founder, 2026-10-27): one tutor, two looks, default B; the
  // student's choice is remembered per browser (applied after hydration).
  const [rig, chooseRig] = useRigChoice();
  const rigRef = useRef<RigChoice>(rig); // read by speak() outside render
  useEffect(() => {
    rigRef.current = rig;
  }, [rig]);
  // Push-to-talk (founder, 2026-10-27: no continuous listening, no wake word):
  // the mic runs only while the button is held, one utterance, and the
  // transcript lands in the question box for the student to send — that send
  // is their confirmation of what was heard.
  const [listening, setListening] = useState(false);
  const stopDictationRef = useRef<(() => void) | null>(null);
  const mic = useMicSupported();

  const say = useCallback((who: LogLine["who"], text: string) => {
    if (!text) return;
    setLog((l) => [...l.slice(-80), { at: new Date().toLocaleTimeString(), who, text }]);
  }, []);
  const speak = useCallback(async (text: string) => {
    if (!text || !speechRef.current) return;
    try {
      const voices = typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      const name = pickBrowserVoice(voices, voiceGenderForChoice(rigRef.current));
      const r = await speechRef.current.synthesize(text, name ? `browser:${name}` : "browser:default", { marks: [] });
      await r.play?.({ rate: 1 });
    } catch {
      /* no voice */
    }
  }, []);

  // 1. Open or resume the session.
  useEffect(() => {
    speechRef.current = browserSpeechAvailable() ? new BrowserSpeechProvider() : null;
    let alive = true;
    (async () => {
      try {
        const v = await postJson<SessionView>("/api/sk/session", { eventId: uuidv7(), productId, chapter, resume: true });
        if (!alive) return;
        setView(v);
        say("sys", `session ${v.sessionId.slice(0, 8)}… ${v.state} at ${v.unit?.title ?? "?"} (${Math.round(v.cursor.t / 1000)} s)`);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      speechRef.current?.cancel();
    };
  }, [productId, chapter, say]);

  // 2. Load the asset the cursor names (segment + hit map + rig + font) when it changes.
  // A check or practice asset has nothing to draw: keep the unit's teaching
  // segment on the board (view.board), paused, so a session resumed mid-check
  // never sits on a blank board.
  const shown = view?.asset?.segment ? view.asset : (view?.board ?? null);
  const assetId = shown?.assetId ?? null;
  const segmentUri = shown?.segment ?? null;
  const shownHitmap = shown?.hitmap;
  const shownClip = shown?.clip;
  useEffect(() => {
    if (!assetId || !segmentUri) return;
    if (loaded?.assetId === assetId && loaded.rigChoice === rig) return;
    let alive = true;
    (async () => {
      try {
        setPlayer("loading");
        const base = dirname(segmentUri);
        const raw = normaliseSegment((await fetch(segmentUri).then((r) => r.json())) as Segment);
        // The security gate: a segment that fails validation never reaches the DOM.
        const seg = validateSegment(raw);
        const hitmapUri = shownHitmap ?? (seg.hitmap ? base + seg.hitmap : null);
        const clipUri = shownClip ?? (seg.clip ? base + seg.clip.uri : null);
        const [hitmap, rigData] = await Promise.all([
          hitmapUri ? fetch(hitmapUri).then((r) => (r.ok ? (r.json() as Promise<HitMap>) : null)) : Promise.resolve(null),
          fetch(rigBaseForChoice(rig) + "rig.json")
            .then((r) => (r.ok ? (r.json() as Promise<Rig>) : null))
            .catch(() => null),
        ]);
        if (!fontRef.current) {
          const ot = await import("opentype.js");
          fontRef.current = await new Promise<OpentypeLike>((res, rej) =>
            ot.load("/sk-s1/Caveat-Regular.ttf", (err, fnt) => (err || !fnt ? rej(err) : res(fnt as unknown as OpentypeLike))),
          );
        }
        if (!alive) return;
        setLoaded({ seg, hitmap, rig: rigData, rigChoice: rig, base, clipUri, assetId });
      } catch (e) {
        if (alive) {
          setError(`Could not load the lesson segment: ${(e as Error).message}`);
          say("sys", `REFUSED segment: ${(e as Error).message}`);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [assetId, segmentUri, shownHitmap, shownClip, loaded?.assetId, loaded?.rigChoice, rig, say]);

  // 3. Mount the runtime for the loaded asset; seek to the server's cursor.
  useEffect(() => {
    const main = videoRef.current;
    const font = fontRef.current;
    if (!loaded || !font || !hostRef.current || !main || !asideAudioRef.current || !loaded.hitmap || !loaded.clipUri) return;
    main.src = loaded.clipUri;
    const rt = new SpikeRuntime(
      hostRef.current,
      main,
      asideAudioRef.current,
      loaded.seg,
      font,
      loaded.base,
      { state: setPlayer, clock: setClockMs, log: (s) => say("sys", s) },
      { mode: "S", hitmap: loaded.hitmap, rig: loaded.rig ? { data: loaded.rig, base: rigBaseForChoice(loaded.rigChoice) } : undefined, checkpointKey: null },
    );
    runtimeRef.current = rt;
    rt.mount();
    const startAt = view?.cursor.t ?? 0;
    const onMeta = () => rt.seek(startAt);
    if (main.readyState >= 1) onMeta();
    else main.addEventListener("loadedmetadata", onMeta, { once: true });
    const id = setTimeout(() => setPlayer("ready"), 0);
    return () => {
      clearTimeout(id);
      main.removeEventListener("loadedmetadata", onMeta);
      rt.unmount();
      runtimeRef.current = null;
    };
    // The cursor is read once at mount on purpose: later ticks come from the clock itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, say]);

  const cursorNow = useCallback(() => {
    const v = view;
    if (!v) return undefined;
    return { ...v.cursor, t: Math.round(runtimeRef.current?.t ?? v.cursor.t) };
  }, [view]);

  /** Apply what the server says the board should do after a turn/command. */
  const applyBoard = useCallback(
    async (next: SessionView, board: string | undefined, previousAssetId: string | null) => {
      const rt = runtimeRef.current;
      setView(next);
      if (!rt) return;
      if (next.asset?.assetId !== previousAssetId) {
        rt.holdAfterTurn();
        return; // a new asset: the load effect remounts and seeks to next.cursor.t
      }
      if (board === "erase_aside") rt.clearLiveAside();
      if (next.openCheck || next.state === "PAUSED" || next.state === "AWAITING") rt.holdAfterTurn();
      else if (board === "seek") await rt.resumeAfterTurn(0, next.cursor.t);
      else if (next.state === "PRESENTING") await rt.resumeAfterTurn(0, next.cursor.t);
      else rt.holdAfterTurn();
      rt.setRate(next.rate);
    },
    [],
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  const sendCommand = useCallback(
    async (command: CommandName, args: CommandArgs = {}) => {
      if (!view || busy) return;
      setBusy(true);
      setError(null);
      const prevAsset = view.asset?.assetId ?? null;
      try {
        runtimeRef.current?.pauseForTurn();
        const r = await postJson<SessionView & { speech: string; board?: string; refused?: string }>("/api/sk/command", { eventId: uuidv7(), sessionId: view.sessionId, command, args, cursor: cursorNow() });
        say("you", `/${command}${Object.keys(args).length ? " " + JSON.stringify(args) : ""}`);
        say("sk", r.speech);
        setSkText(r.speech);
        void speak(r.speech);
        await applyBoard(r, r.board, prevAsset);
      } catch (e) {
        setError((e as Error).message);
        runtimeRef.current?.holdAfterTurn();
      } finally {
        setBusy(false);
      }
    },
    [view, busy, cursorNow, say, speak, applyBoard],
  );

  // ── A typed turn (question / command / answer) over SSE ───────────────────
  const sendTurn = useCallback(
    async (text: string) => {
      if (!view || busy || !text.trim()) return;
      setBusy(true);
      setError(null);
      setSkText("");
      const prevAsset = view.asset?.assetId ?? null;
      const rt = runtimeRef.current;
      rt?.pauseForTurn();
      say("you", text);
      let spoken = "";
      let next: SessionView | null = null;
      let board: string | undefined;
      try {
        const res = await fetch("/api/sk/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: uuidv7(), sessionId: view.sessionId, utterance: { text, modality: "typed" }, cursor: cursorNow() }),
        });
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error || `HTTP ${res.status}`);
        for await (const ev of readSse(res)) {
          if (ev.event === "meta") {
            const m = ev.data as { intent?: string; asideRejected?: string };
            if (m.intent) say("sys", `intent: ${m.intent}`);
            if (m.asideRejected) say("sys", `aside refused: ${m.asideRejected}`);
            rt?.answering();
          } else if (ev.event === "text") {
            spoken += String(ev.data);
            setSkText(spoken);
          } else if (ev.event === "tal") {
            const program = ev.data as { actions: Segment["actions"]; gestures: Segment["gestures"]; duration_ms: number };
            say("sys", `aside: ${program.actions.length} action(s), ${program.duration_ms} ms`);
            void rt?.playLiveAside(program);
          } else if (ev.event === "error") {
            setError((ev.data as { message?: string }).message ?? "Turn failed.");
          } else if (ev.event === "done") {
            const d = ev.data as { view: SessionView; board?: string; latency?: { totalMs: number } };
            next = d.view;
            board = d.board;
            say("sys", `done in ${d.latency?.totalMs ?? "?"} ms`);
          }
        }
        if (spoken) {
          say("sk", spoken);
          await speak(spoken);
        }
        if (next) await applyBoard(next, board, prevAsset);
        else rt?.holdAfterTurn();
      } catch (e) {
        setError((e as Error).message);
        rt?.holdAfterTurn();
      } finally {
        setBusy(false);
      }
    },
    [view, busy, cursorNow, say, speak, applyBoard],
  );

  // ── A check answer (typed) ────────────────────────────────────────────────
  const sendAnswer = useCallback(
    async (response: unknown) => {
      const oc = view?.openCheck;
      if (!view || !oc?.item || busy) return;
      setBusy(true);
      setError(null);
      const prevAsset = view.asset?.assetId ?? null;
      try {
        const r = await postJson<{ kind: string; speech?: string; feedback?: string; hint?: string; view: SessionView; outcome?: string }>("/api/sk/answer", {
          eventId: uuidv7(),
          sessionId: view.sessionId,
          itemId: oc.item.id,
          attemptNo: oc.attemptNo,
          response,
          modality: "typed",
          transcriptConfirmed: true,
        });
        say("you", typeof response === "string" ? response : JSON.stringify(response));
        const line = r.speech || r.feedback || "";
        say("sk", `${line}${r.outcome ? ` (${r.outcome})` : ""}`);
        setSkText(line);
        void speak(line);
        setAnswer("");
        await applyBoard(r.view, undefined, prevAsset);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [view, busy, say, speak, applyBoard],
  );

  // Space = barge-in while playing (push-to-talk stand-in: focuses the question box).
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && player === "playing" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        runtimeRef.current?.pauseForTurn();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  const oc = view?.openCheck ?? null;
  const item = oc?.item ?? null;
  const unitsLine = useMemo(() => (view ? `${view.unit?.title ?? "—"} · ${view.state}` : "connecting…"), [view]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="card p-2">
        <audio ref={asideAudioRef} preload="none" />
        <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
          <button className="btn-primary h-9 px-3" onClick={() => void sendCommand("continue")} disabled={!view || busy || player === "loading" || player === "playing" || !!oc}>
            ▶ Play
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => { runtimeRef.current?.pauseForTurn(); runtimeRef.current?.holdAfterTurn(); }} disabled={player !== "playing"}>
            ⏸ Pause
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("repeat")} disabled={!view || busy || !!oc}>
            ↺ Repeat
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("slower")} disabled={!view || busy}>
            🐢 Slower
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("erase")} disabled={!view || busy}>
            ⌫ Erase
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("skip", { scope: "segment" })} disabled={!view || busy}>
            ⏭ Skip
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("practise", { n: 0 })} disabled={!view || busy || !!oc} title="Mastery check for this unit">
            ✓ Check me
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("explain_again", { style: "simpler" })} disabled={!view || busy}>
            🔁 Explain again
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void sendCommand("return")} disabled={!view || busy || !view.bookmarks.length}>
            ↩ Return
          </button>
          <label className="h-9 flex items-center gap-1 text-xs text-[#667085]" title="SK's look — one tutor, two looks; the clip's own narration keeps its voice">
            SK&apos;s look
            <select className="h-9 px-2 border rounded text-sm text-[#14181F]" value={rig} onChange={(e) => chooseRig(e.target.value === "A" ? "A" : "B")} data-testid="sk-rig">
              {(["B", "A"] as RigChoice[]).map((c) => (
                <option key={c} value={c}>
                  {RIG_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-[#667085]" data-testid="status">
            {unitsLine} · {player} · {(clockMs / 1000).toFixed(1)} s · ×{view?.rate.toFixed(2) ?? "1.00"}
          </span>
        </div>
        <div className="relative w-full bg-white rounded overflow-hidden" style={{ aspectRatio: "16 / 9", maxHeight: "70vh", margin: "0 auto" }}>
          <video ref={videoRef} preload="auto" playsInline className="absolute inset-0 w-full h-full" />
          <div ref={hostRef} className="absolute inset-0 w-full h-full" data-testid="board" />
          {skText && (
            <div className="absolute left-2 right-2 bottom-2 rounded bg-white/90 px-3 py-2 text-sm shadow" data-testid="sk-text">
              <span className="font-semibold text-[#0C8175]">SK: </span>
              {skText}
            </div>
          )}
        </div>
        {item && oc && (
          <div className="mt-3 p-3 border rounded bg-[#FCFCFA]" data-testid="check">
            <div className="text-xs text-[#667085] mb-1">
              {oc.purpose === "practise" ? "Practice" : "Check"} · question {oc.index + 1} of {oc.total} · attempt {oc.attemptNo}
            </div>
            <div className="font-medium mb-2">{item.prompt}</div>
            {item.type === "mcq" && (
              <div className="flex flex-col gap-1">
                {item.options.map((o) => (
                  <button key={o} className="text-left h-9 px-3 border rounded hover:bg-white" onClick={() => void sendAnswer(o)} disabled={busy}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            {item.type === "true_false" && (
              <div className="flex gap-2">
                <button className="h-9 px-4 border rounded" onClick={() => void sendAnswer(true)} disabled={busy}>
                  True
                </button>
                <button className="h-9 px-4 border rounded" onClick={() => void sendAnswer(false)} disabled={busy}>
                  False
                </button>
              </div>
            )}
            {(item.type === "fill_blank" || item.type === "short") && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendAnswer(answer);
                }}
              >
                <input className="h-9 px-3 border rounded flex-1" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" disabled={busy} />
                <button className="btn-primary h-9 px-3" type="submit" disabled={busy || !answer.trim()}>
                  Answer
                </button>
              </form>
            )}
            {item.type === "match" && <div className="text-sm text-[#667085]">Match items are answered by typing “left = right” pairs in the question box below (POC).</div>}
          </div>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            setDraft("");
            void sendTurn(t);
          }}
        >
          <input
            ref={inputRef}
            className="h-10 px-3 border rounded flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={listening ? "Listening… release to stop" : oc ? "Type your answer, or a command (skip, explain again…)" : "Ask SK a question, or say: repeat · slower · skip · practise · go to unit 2 · explain again"}
            disabled={!view || busy}
            maxLength={600}
          />
          {mic && (
            <button
              type="button"
              className={`h-10 px-3 border rounded select-none ${listening ? "bg-[#0C8175] text-white" : ""}`}
              title="Hold to talk (push-to-talk). What SK hears goes into the box; press Send to send it."
              aria-pressed={listening}
              data-testid="sk-ptt"
              disabled={!view || busy}
              onPointerDown={(e) => {
                e.preventDefault();
                if (stopDictationRef.current) return;
                runtimeRef.current?.pauseForTurn();
                setListening(true);
                const stop = startDictation(
                  (t) => setDraft(t),
                  () => {
                    stopDictationRef.current = null;
                    setListening(false);
                  },
                );
                if (!stop) setListening(false);
                stopDictationRef.current = stop; // one utterance: ends on release, never restarts itself
              }}
              onPointerUp={() => stopDictationRef.current?.()}
              onPointerLeave={() => stopDictationRef.current?.()}
              onPointerCancel={() => stopDictationRef.current?.()}
            >
              🎤 {listening ? "Listening" : "Hold to talk"}
            </button>
          )}
          <button className="btn-primary h-10 px-4" type="submit" disabled={!view || busy || !draft.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </form>
        {error && (
          <div className="mt-2 text-sm text-[#B42318]" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="card p-3 text-xs overflow-auto" style={{ maxHeight: "80vh" }} data-testid="log">
        <div className="font-semibold mb-1">
          {view ? `${view.unit?.title ?? ""} · ${view.phase}/${view.state}` : "SK"}
        </div>
        {view && (
          <div className="mb-2 text-[#667085]">
            unit {view.cursor.unitKey} · asset {view.cursor.assetId} · bookmarks {view.bookmarks.length} · mastery{" "}
            {Object.entries(view.mastery)
              .map(([k, m]) => `${k}:${m.status}${m.independent ? "*" : ""}`)
              .join(", ") || "—"}
            {" · skipped "}
            <span data-testid="sk-skipped">{(view.skipped ?? []).join(", ") || "—"}</span>
          </div>
        )}
        {log.map((l, i) => (
          <div key={i} className={l.who === "sk" ? "text-[#0C8175]" : l.who === "you" ? "text-[#14181F]" : "text-[#98A0A9] font-mono"}>
            <span className="opacity-60">{l.at}</span> <b>{l.who}</b> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

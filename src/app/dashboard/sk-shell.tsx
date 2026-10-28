"use client";

// The SK Shell PANEL (Final Plan 2026-10-28 §2.1, stage S0): transcript with
// tool chips and a source label per SK turn, a one-line caption of SK's latest
// sentence (the Board's caption later), the job-tray and confirmation-card
// DOM hooks (empty in S0), text input, push-to-talk mic, read-aloud, Stop, a
// hands-free opt-in, and the SK-narrated onboarding on a role's first visit.
//
// Every decision with a rule behind it lives in a pure module under
// src/sk/shell/client/ and is unit-tested there; this file is the wiring:
//   collector.ts     — what the turn request says about where the user is
//   sse.ts           — the stream → SkTurnEvents
//   mic-gate.ts      — §2.6: the mic stops on blur/hidden/pagehide/idle, never resumes
//   narration.ts     — §4.6: the intro script and its abortable runner
//   memory-store.ts  — S1: the memory blob across pages (sessionStorage)
//   confirm.ts       — S1 §9.2: when a bare yes/no answers a confirm card
// S1 adds the Board: on /present the launcher hands in a bridge
// (src/app/present/sk-board-bridge.ts) whose state rides with every turn and
// which performs the `board` events the server decides; and confirm cards,
// whose token goes back to /api/sk/act by click or spoken yes.
//
// Voice reuses the Assistant's browser adapter (StreamSpeaker / startDictation)
// so a hosted TTS/STT swap later is one module, not two panels.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StreamSpeaker, micSupported, pageSpeechLang, startDictation } from "@/utils/assistant/voice-client";
import RichText from "@/components/rich-text";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import { tourForRole, type TourCopy } from "@/tour/definitions";
import type { SkActRequest, SkActResponse, SkBoardMove, SkTurnEvent, SkTurnRequest } from "@/sk/shell/types";
import { SK_INTRO_TOUR } from "@/sk/shell/tour";
import { collect, localeFromLang } from "@/sk/shell/client/collector";
import { skTurnEvents } from "@/sk/shell/client/sse";
import { createMicGate, type MicGate } from "@/sk/shell/client/mic-gate";
import { runNarration, skIntroScript } from "@/sk/shell/client/narration";
import { createMemoryStore, type MemoryStore } from "@/sk/shell/client/memory-store";
import { decideWithCards, secondsLeft } from "@/sk/shell/client/confirm";
import type { SkBoardBridge } from "@/app/present/sk-board-bridge";

export type SkShellCopy = Dictionary["sk"]["shell"];

type Label = "grounded" | "supplementary" | "declined" | "navigation";
type Entry = {
  id: string;
  who: "user" | "sk";
  text: string;
  tools?: Array<{ name: string; ok: boolean; summary: string }>;
  nav?: Array<{ path: string; label: string }>;
  /** S1: Board moves this turn performed, with the Board's own report. */
  moves?: Array<{ move: SkBoardMove; say: string; ok?: boolean; summary?: string }>;
  sources?: string[];
  label?: Label;
  /** Still streaming. */
  pending?: boolean;
};

/** S1: a confirm-tier card (§2.5, §9.2). `token` is opaque; the server decides. */
type Card = {
  id: string;
  token: string;
  action: string;
  title: string;
  params: Record<string, string | number | boolean | null>;
  expiresAt: string;
  status: "active" | "sending" | "done" | "failed" | "cancelled" | "expired";
  result?: string;
};

type ContextReply = { ready?: boolean; greeting?: string; capabilities?: string[]; memory?: string };

const LS_READ_ALOUD = "sk.readAloud";
const LS_HANDS_FREE = "sk.handsFree";
/** How long a settled card stays visible before it leaves the slot. */
const CARD_LINGER_MS = 6000;

function uuid(): string {
  const c = typeof crypto !== "undefined" ? (crypto as { randomUUID?: () => string }) : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The caption shows SK's LATEST sentence, not the whole answer. */
function lastSentence(text: string): string {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?؟।])\s+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "on";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}

function postIntroSeen(status: "completed" | "skipped") {
  try {
    const body = JSON.stringify({ tourKey: SK_INTRO_TOUR.key, version: SK_INTRO_TOUR.version, status });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/tour/seen", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/tour/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
  } catch {
    /* best-effort: the worst case is the intro offers itself once more */
  }
}

export default function SkShell({
  copy,
  tourCopy,
  role,
  hat,
  introDue,
  onIntroDone,
  onClose,
  board,
}: {
  copy: SkShellCopy;
  tourCopy: TourCopy;
  role: string | null;
  hat: string | null;
  /** Server-decided: shouldAutoStart(seen row for "sk-intro", SK_INTRO_TOUR.version). */
  introDue: boolean;
  /** The launcher flips its flag so a re-open in this session does not narrate again. */
  onIntroDone: () => void;
  onClose: () => void;
  /** S1: on /present, the Board bridge — its state rides with every turn and
   *  it performs the `board` events the server decides. */
  board?: SkBoardBridge | null;
}) {
  const router = useRouter();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  // A one-second tick: card countdowns and the Board's lesson-map status.
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState<boolean | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [narrating, setNarrating] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [handsFree, setHandsFree] = useState(false);
  const [listening, setListening] = useState(false);
  const [mic, setMic] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speakerRef = useRef<StreamSpeaker | null>(null);
  const turnRef = useRef<AbortController | null>(null);
  const narrationRef = useRef<AbortController | null>(null);
  const memoryRef = useRef<string | undefined>(undefined);
  const storeRef = useRef<MemoryStore | null>(null);
  const boardRef = useRef<SkBoardBridge | null | undefined>(board);
  const cardsRef = useRef<Card[]>([]);
  const gateRef = useRef<MicGate | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);
  const micModeRef = useRef<"ptt" | "handsFree" | null>(null);
  const dictatedRef = useRef("");
  const emptyEndsRef = useRef(0);
  const handsFreeRef = useRef(false);
  const readAloudRef = useRef(true);
  const introStartedRef = useRef(false);
  const introPostedRef = useRef(false);
  const sendRef = useRef<(text: string, modality: "text" | "voice") => Promise<void>>(async () => {});

  // ── preferences + feature detection (post-mount: no hydration mismatch) ──
  useEffect(() => {
    const id = setTimeout(() => {
      setMic(micSupported());
      const ra = readFlag(LS_READ_ALOUD, true);
      const hf = readFlag(LS_HANDS_FREE, false);
      setReadAloud(ra);
      readAloudRef.current = ra;
      setHandsFree(hf);
      handsFreeRef.current = hf;
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // ── the §2.6 mic gate: one per panel; onStop is the ONLY way dictation ends from outside ──
  useEffect(() => {
    const gate = createMicGate({
      win: window,
      doc: document,
      onStop: () => {
        micModeRef.current = null;
        stopMicRef.current?.();
        stopMicRef.current = null;
        setListening(false);
      },
    });
    gateRef.current = gate;
    return () => {
      gate.dispose();
      gateRef.current = null;
    };
  }, []);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // ── the cross-page memory store (sessionStorage) + the 1 s tick ──
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    storeRef.current = createMemoryStore(storage);
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  /** Remember the server's memory blob here AND across pages (§5.4). */
  const keepMemory = useCallback((memory: string | undefined, sessionId?: string | null) => {
    if (!memory) return;
    memoryRef.current = memory;
    storeRef.current?.save({ memory, sessionId: sessionId ?? null });
  }, []);

  // ── warm start: greeting + capabilities + memory ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({ path: window.location.pathname });
        const res = await fetch(`/api/sk/shell/context?${q.toString()}`);
        const d = (await res.json().catch(() => ({}))) as ContextReply;
        if (cancelled) return;
        if (!res.ok) {
          setReady(false);
          setError(copy.failed);
          return;
        }
        setReady(d.ready !== false);
        setCapabilities(Array.isArray(d.capabilities) ? d.capabilities : []);
        // A conversation carried over from another page (the dashboard →
        // the Board) beats the fresh blob; the server still has the last
        // word on whether it applies (signature, hat, 4-hour gap).
        const saved = storeRef.current?.load() ?? null;
        if (saved) memoryRef.current = saved.memory;
        else if (d.memory) memoryRef.current = d.memory;
        const greeting = (d.greeting && String(d.greeting).trim()) || copy.greetingFallback;
        setEntries([{ id: uuid(), who: "sk", text: greeting }]);
        setCaption(lastSentence(greeting));
      } catch {
        if (!cancelled) {
          setReady(false);
          setError(copy.failed);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [entries]);

  // Unmount: the voice, the mic and the in-flight turn all stop with the panel
  // (lifecycle 2 — playback stops on navigation away; the conversation itself
  // lives server-side in the memory blob and survives).
  useEffect(
    () => () => {
      speakerRef.current?.stop();
      turnRef.current?.abort();
      narrationRef.current?.abort();
      stopMicRef.current?.();
    },
    [],
  );

  const appendSk = useCallback((text: string, extra: Partial<Entry> = {}) => {
    setEntries((m) => [...m, { id: uuid(), who: "sk", text, ...extra }]);
    setCaption(lastSentence(text));
  }, []);

  const patchEntry = useCallback((id: string, patch: (e: Entry) => Entry) => {
    setEntries((m) => m.map((e) => (e.id === id ? patch(e) : e)));
  }, []);

  const patchCard = useCallback((id: string, patch: Partial<Card>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  /** A settled card leaves the slot after a moment. */
  const retireCard = useCallback((id: string) => {
    window.setTimeout(() => setCards((cs) => cs.filter((c) => c.id !== id)), CARD_LINGER_MS);
  }, []);

  /** Speak one line with the current read-aloud setting (a fresh speaker, so
   *  it never queues behind an answer that was stopped). */
  const speakLine = useCallback((line: string) => {
    if (!readAloudRef.current) return;
    const sp = new StreamSpeaker();
    if (!sp.supported) return;
    speakerRef.current?.stop();
    speakerRef.current = sp;
    sp.push(line);
    sp.flush();
    setSpeaking(true);
    window.setTimeout(() => setSpeaking(!!window.speechSynthesis?.speaking), 400);
  }, []);

  // ── S1: the confirm card → /api/sk/act (§2.5, §9.2). The server verifies
  // the token, consumes it atomically and performs the write; the client only
  // carries the token back and reports the outcome. ──
  const act = useCallback(
    async (card: Card, via: "click" | "voice") => {
      if (card.status !== "active") return;
      patchCard(card.id, { status: "sending" });
      setError(null);
      const req: SkActRequest = {
        turnId: uuid(),
        token: card.token,
        via,
        collector: collect({
          location: { pathname: window.location.pathname, search: window.location.search },
          now: new Date(),
          lang: document.documentElement.lang,
          board: boardRef.current?.state(),
        }),
      };
      if (memoryRef.current) req.memory = memoryRef.current;
      let reply: SkActResponse | null = null;
      try {
        const res = await fetch("/api/sk/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
        reply = (await res.json().catch(() => null)) as SkActResponse | null;
        if (!res.ok && !reply?.summary) throw new Error(copy.actFailed);
      } catch (e) {
        patchCard(card.id, { status: "failed", result: (e as Error).message || copy.actFailed });
        retireCard(card.id);
        appendSk(copy.actFailed, { label: "declined", sources: [card.action] });
        return;
      }
      if (reply?.memory) keepMemory(reply.memory);
      const ok = !!reply?.ok && reply.outcome === "done";
      const line = (reply?.summary && String(reply.summary).trim()) || (ok ? copy.cardSent : copy.actFailed);
      patchCard(card.id, { status: ok ? "done" : "failed", result: line });
      retireCard(card.id);
      appendSk(line, { label: ok ? "grounded" : "declined", sources: [card.action] });
      speakLine(line);
    },
    [appendSk, copy, keepMemory, patchCard, retireCard, speakLine],
  );

  const dismissCard = useCallback(
    (card: Card, why: "cancelled" | "expired" = "cancelled") => {
      patchCard(card.id, { status: why, result: why === "expired" ? copy.cardExpired : copy.cardCancelled });
      retireCard(card.id);
    },
    [copy, patchCard, retireCard],
  );

  // Cards expire on the server's clock; the panel stops offering them first.
  useEffect(() => {
    const now = Date.now();
    for (const c of cardsRef.current) if (c.status === "active" && secondsLeft(c.expiresAt, now) === 0) dismissCard(c, "expired");
  }, [tick, dismissCard]);

  // ── §4.6 SK-narrated onboarding, once per SK_INTRO_TOUR.version ──
  const finishIntro = useCallback(
    (status: "completed" | "skipped") => {
      if (introPostedRef.current) return; // exactly once
      introPostedRef.current = true;
      postIntroSeen(status);
      setNarrating(false);
      narrationRef.current = null;
      onIntroDone();
    },
    [onIntroDone],
  );

  useEffect(() => {
    if (!introDue || ready === null || introStartedRef.current) return;
    // Deferred like TourProvider: Strict Mode's mount/unmount/mount would
    // otherwise abort a narration that had already started and record it as
    // skipped. The flag flips INSIDE the timer so a cleared timer reschedules.
    const t = setTimeout(() => {
      introStartedRef.current = true;
      const ac = new AbortController();
      narrationRef.current = ac;
      const def = tourForRole(role, tourCopy) ?? tourForRole("teacher", tourCopy);
      const lines = skIntroScript({ copy, tourCopy, steps: def?.steps ?? [], role });
      const speaker = new StreamSpeaker();
      speakerRef.current = speaker;
      const voice = readAloudRef.current && speaker.supported;
      const silent = { push: () => {}, flush: () => {}, stop: () => {} };
      setNarrating(true);
      if (voice) setSpeaking(true);
      void runNarration(lines, voice ? speaker : silent, {
        signal: ac.signal,
        onLine: (line) => appendSk(line),
      }).then((r) => {
        finishIntro(r.completed ? "completed" : "skipped");
        if (voice) window.setTimeout(() => setSpeaking(!!window.speechSynthesis?.speaking), 400);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [introDue, ready, role, tourCopy, copy, appendSk, finishIntro]);

  function skipIntro() {
    narrationRef.current?.abort();
    speakerRef.current?.stop();
    setSpeaking(false);
  }

  // ── voice controls ──
  function toggleReadAloud() {
    const nv = !readAloudRef.current;
    readAloudRef.current = nv;
    setReadAloud(nv);
    writeFlag(LS_READ_ALOUD, nv);
    if (!nv) {
      speakerRef.current?.stop();
      setSpeaking(false);
    }
  }

  function toggleHandsFree() {
    const nv = !handsFreeRef.current;
    handsFreeRef.current = nv;
    setHandsFree(nv);
    writeFlag(LS_HANDS_FREE, nv);
    // Turning the opt-in OFF while listening hands-free ends the capture now.
    if (!nv && micModeRef.current === "handsFree") gateRef.current?.stop("manual");
  }

  /** Stop = the voice, the answer being written AND the narration. */
  function stopAll() {
    turnRef.current?.abort();
    narrationRef.current?.abort();
    speakerRef.current?.stop();
    setSpeaking(false);
  }

  /** One dictation pass. Hands-free restarts it after each utterance for as
   * long as the gate is still active; the gate's onStop is the only thing that
   * ends the loop, and nothing here ever restarts it after that (§2.6). */
  function beginDictation(mode: "ptt" | "handsFree") {
    const gate = gateRef.current;
    if (!gate?.active) return;
    const startedAt = Date.now();
    dictatedRef.current = "";
    const stop = startDictation(
      (t) => {
        dictatedRef.current = t;
        setInput(t);
        gate.touch();
      },
      () => {
        stopMicRef.current = null;
        const text = dictatedRef.current.trim();
        dictatedRef.current = "";
        if (mode === "handsFree" && micModeRef.current === "handsFree" && gate.active) {
          if (text) {
            emptyEndsRef.current = 0;
            setInput("");
            void sendRef.current(text, "voice");
          } else if (Date.now() - startedAt < 1500 && ++emptyEndsRef.current >= 3) {
            // Three immediate empty ends in a row = the browser is refusing
            // (permission, no device). Stop rather than spin.
            gate.stop("manual");
            return;
          }
          beginDictation("handsFree");
          return;
        }
        // Push-to-talk: the words stay in the box; Enter sends.
        setListening(false);
        if (mode === "ptt") inputRef.current?.focus();
      },
      { lang: pageSpeechLang() },
    );
    if (!stop) {
      gate.stop("manual");
      return;
    }
    stopMicRef.current = stop;
    setListening(true);
  }

  function pressMic() {
    if (ready === false || listening) return;
    const gate = gateRef.current;
    if (!gate) return;
    if (!gate.start({ idle: false })) return; // not visible / not focused → no capture
    micModeRef.current = "ptt";
    emptyEndsRef.current = 0;
    beginDictation("ptt");
  }
  function releaseMic() {
    if (micModeRef.current !== "ptt") return;
    gateRef.current?.stop("release");
  }
  function clickMicHandsFree() {
    if (ready === false) return;
    const gate = gateRef.current;
    if (!gate) return;
    if (micModeRef.current === "handsFree") {
      gate.stop("manual");
      return;
    }
    if (!gate.start({ idle: true })) return;
    micModeRef.current = "handsFree";
    emptyEndsRef.current = 0;
    beginDictation("handsFree");
  }

  // ── the turn ──
  const send = useCallback(
    async (text: string, modality: "text" | "voice") => {
      const q = text.trim();
      if (!q || ready === false) return;
      setError(null);
      // §9.2: with exactly one card waiting, a bare yes/no answers the CARD —
      // spoken (push-to-talk or hands-free, the only sources of a "voice"
      // turn) or typed (one deliberate act, reported as a click).
      const active = cardsRef.current.filter((c) => c.status === "active");
      if (active.length === 1) {
        const d = decideWithCards({ activeCards: 1, modality, text: q, locale: localeFromLang(document.documentElement.lang) });
        if (d.kind === "confirm") {
          setEntries((m) => [...m, { id: uuid(), who: "user", text: q }]);
          void act(active[0], modality === "voice" ? "voice" : "click");
          return;
        }
        if (d.kind === "dismiss") {
          setEntries((m) => [...m, { id: uuid(), who: "user", text: q }]);
          dismissCard(active[0]);
          appendSk(copy.cardCancelled, { label: "supplementary" });
          return;
        }
      }
      setBusy(true);
      // A new question interrupts whatever SK was saying (barge-in) and the
      // intro if it is still running.
      turnRef.current?.abort();
      narrationRef.current?.abort();
      speakerRef.current?.stop();
      const turn = new AbortController();
      turnRef.current = turn;
      const speaker = new StreamSpeaker();
      speakerRef.current = speaker;
      const willSpeak = readAloudRef.current && speaker.supported;
      if (willSpeak) setSpeaking(true);

      const skId = uuid();
      setEntries((m) => [...m, { id: uuid(), who: "user", text: q }, { id: skId, who: "sk", text: "", pending: true }]);

      const req: SkTurnRequest = {
        turnId: uuid(),
        text: q,
        modality,
        // The address bar at SEND time (an event handler, so no Suspense
        // boundary is needed for useSearchParams and a soft navigation that
        // already happened is what gets reported).
        collector: collect({
          location: { pathname: window.location.pathname, search: window.location.search },
          now: new Date(),
          lang: document.documentElement.lang,
          // The Board's state rides along so the server can decide a move.
          board: boardRef.current?.state(),
        }),
      };
      if (memoryRef.current) req.memory = memoryRef.current;

      let full = "";
      let sawDone = false;
      // Board moves run as their events arrive; the turn stays busy until the
      // Board has reported on every one of them.
      const moveRuns: Promise<void>[] = [];
      try {
        const res = await fetch("/api/sk/shell/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
          signal: turn.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j?.error || copy.failed);
        }
        for await (const ev of skTurnEvents(res.body, turn.signal)) {
          handle(ev);
        }
        if (moveRuns.length) await Promise.all(moveRuns);
      } catch (e) {
        if (!turn.signal.aborted) setError((e as Error).message || copy.failed);
      } finally {
        if (turnRef.current === turn) turnRef.current = null;
        setBusy(false);
        patchEntry(skId, (en) => {
          const empty = !en.text && !(en.nav?.length || en.tools?.length || en.moves?.length);
          // An answer that carried nothing at all: SK's fixed line (§2.3).
          return { ...en, pending: false, text: empty && sawDone ? copy.nothingOnThat : en.text };
        });
        if (willSpeak) window.setTimeout(() => setSpeaking(!!window.speechSynthesis?.speaking), 400);
        if (modality === "text") inputRef.current?.focus();
      }

      function handle(ev: SkTurnEvent) {
        switch (ev.type) {
          case "meta":
            if (ev.capabilities) setCapabilities(ev.capabilities);
            if (ev.memory) keepMemory(ev.memory, ev.sessionId);
            break;
          case "text":
            full += ev.text;
            patchEntry(skId, (en) => ({ ...en, text: full }));
            setCaption(lastSentence(full));
            if (willSpeak) speaker.push(ev.text);
            break;
          case "tool":
            patchEntry(skId, (en) => ({ ...en, tools: [...(en.tools ?? []), { name: ev.name, ok: ev.ok, summary: ev.summary }] }));
            break;
          case "navigate": {
            // Immediate tier: go now, say so in the transcript.
            router.push(ev.path);
            const line = fmt(copy.opening, { label: ev.label });
            patchEntry(skId, (en) => ({ ...en, nav: [...(en.nav ?? []), { path: ev.path, label: ev.label }] }));
            setCaption(line);
            break;
          }
          case "board": {
            // Immediate tier, decided and audited server-side: the Board
            // performs it here. The video is paused while SK speaks; a move
            // that plays (intro, segment, resume) restarts it itself.
            const b = boardRef.current;
            const say = ev.say ?? "";
            patchEntry(skId, (en) => ({
              ...en,
              text: en.text || say,
              moves: [...(en.moves ?? []), { move: ev.move, say }],
            }));
            if (say) {
              setCaption(say);
              if (willSpeak && !full) speaker.push(say);
            }
            if (!b) {
              patchEntry(skId, (en) => ({ ...en, moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: false, summary: copy.boardNotOpen } : m)) }));
              break;
            }
            moveRuns.push(
              (async () => {
                const st = b.state();
                if (st && st.paused === false && ev.move !== "pause") await b.run("pause", {});
                const r = await b.run(ev.move, ev.args ?? {});
                patchEntry(skId, (en) => ({
                  ...en,
                  moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: r.ok, summary: r.summary } : m)),
                }));
                if (!r.ok) setError(r.summary);
              })(),
            );
            break;
          }
          case "confirm": {
            // Confirm tier: a card with the resolved params and the server's
            // token. Nothing happens until Confirm (click or spoken yes).
            const card: Card = { id: uuid(), token: ev.token, action: ev.action, title: ev.title, params: ev.params ?? {}, expiresAt: ev.expiresAt, status: "active" };
            setCards((cs) => [...cs.filter((c) => c.status !== "active"), card]);
            setCaption(ev.title);
            break;
          }
          case "done":
            sawDone = true;
            if (ev.memory) keepMemory(ev.memory);
            patchEntry(skId, (en) => ({ ...en, sources: ev.sources ?? [], label: ev.label }));
            if (willSpeak) speaker.flush();
            break;
          case "error":
            setError(ev.message || copy.failed);
            break;
        }
      }
    },
    [ready, router, copy, patchEntry, act, dismissCard, appendSk, keepMemory],
  );
  // The hands-free loop sends from inside a dictation callback that outlives
  // any one render; it reaches the current `send` through this ref.
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  function submit() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    void send(q, "text");
  }

  const labelText = (l: Label) =>
    l === "grounded" ? copy.labelGrounded : l === "supplementary" ? copy.labelSupplementary : l === "declined" ? copy.labelDeclined : copy.labelNavigation;
  const labelTone = (l: Label) =>
    l === "grounded"
      ? "bg-[#E2F4F1] text-[#0C4E47]"
      : l === "navigation"
        ? "bg-[#EEF2FF] text-[#3730A3]"
        : l === "declined"
          ? "bg-[#FEF3F2] text-[#B42318]"
          : "bg-[#FFF7E6] text-[#8A5A00]";

  const showStop = busy || speaking || narrating;
  // Re-read on every render — the 1 s tick keeps them fresh while the lesson
  // map is prepared in the background and while a card counts down.
  const mapStatus = board ? board.status() : "none";
  const nowMs = Date.now() + tick * 0;
  const paramLabel = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md flex flex-col max-h-[92dvh] sm:max-h-[86dvh] rounded-b-none sm:rounded-b-2xl"
        onClick={(e) => e.stopPropagation()}
        data-sk="shell"
        data-sk-role={role ?? ""}
        data-sk-hat={hat ?? ""}
        role="dialog"
        aria-label={copy.title}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#0C8175] text-white text-[11px] font-semibold" aria-hidden>
                SK
              </span>
              <span className="truncate">{copy.title}</span>
            </div>
            {capabilities.length > 0 && (
              <div className="text-[10px] text-[#98A0A9] truncate" data-sk="capabilities">
                {capabilities.join(" · ")}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {showStop ? (
              <button onClick={stopAll} className="text-xs font-medium text-[#B42318] hover:underline" title={copy.stop}>
                ■ {copy.stop}
              </button>
            ) : (
              <button
                onClick={toggleReadAloud}
                aria-pressed={readAloud}
                className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
              >
                {readAloud ? "🔊" : "🔈"} {copy.readAloud}
              </button>
            )}
            <button onClick={onClose} className="text-[#98A0A9] hover:text-[#5B6470] text-lg leading-none" aria-label={copy.close}>
              ×
            </button>
          </div>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3" data-sk="transcript">
          {ready === null && <p className="text-sm text-[#98A0A9]">…</p>}
          {entries.map((e) => (
            <div key={e.id} className={e.who === "user" ? "flex flex-col items-end" : "flex flex-col items-start"}>
              {e.who === "user" && <span className="text-[10px] text-[#98A0A9] me-1 mb-0.5">{copy.you}</span>}
              {(e.text || e.pending) && (
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                    e.who === "user" ? "bg-[#E2F4F1] text-[#0C4E47] rounded-ee-sm" : "bg-[#F4F6F3] text-[#14181F] rounded-es-sm"
                  }`}
                >
                  {e.text ? <RichText text={e.text} /> : <span className="text-[#98A0A9]">…</span>}
                </div>
              )}
              {e.nav?.map((n, i) => (
                <div key={i} className="text-xs text-[#3730A3] mt-1 ms-1" data-sk="nav-line">
                  → {fmt(copy.opening, { label: n.label })}
                </div>
              ))}
              {e.moves?.map((m, i) => (
                <div key={i} className={`text-xs mt-1 ms-1 ${m.ok === false ? "text-[#B42318]" : "text-[#0C8175]"}`} data-sk="board-line" data-sk-move={m.move} title={m.summary}>
                  ▶ {m.move}
                  {m.ok === undefined ? " …" : m.ok ? "" : ` — ${m.summary ?? ""}`}
                </div>
              ))}
              {e.who === "sk" && (e.tools?.length || e.sources?.length) ? (
                <div className="flex flex-wrap gap-1 mt-1 ms-1" data-sk="tool-chips">
                  {(e.sources?.length ? e.sources.map((s) => ({ name: s, ok: true })) : (e.tools ?? [])).map((t, i) => (
                    <span
                      key={`${t.name}-${i}`}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full border ${t.ok ? "border-[#CFE9E4] text-[#0C8175]" : "border-[#F3C9C4] text-[#B42318]"}`}
                      title={"summary" in t ? (t as { summary?: string }).summary : undefined}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              ) : null}
              {e.who === "sk" && e.label && (
                <span className={`text-[10px] mt-1 ms-1 px-1.5 py-0.5 rounded ${labelTone(e.label)}`} data-sk="label">
                  {labelText(e.label)}
                </span>
              )}
            </div>
          ))}
          {narrating && (
            <div className="flex justify-start">
              <button onClick={skipIntro} className="text-xs font-medium text-[#5B6470] underline" data-sk="intro-skip" title={copy.introSkip}>
                {copy.skip}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-[#B42318]">{error}</p>}
        </div>

        {/* Caption — SK's latest sentence; the Board reads this line later. */}
        <div className="px-5 py-1.5 border-t border-[#EEF0EC] text-xs text-[#5B6470] truncate min-h-[1.75rem]" data-sk="caption" aria-live="polite">
          {caption}
        </div>

        {/* Job tray (jobs arrive in S2) — on the Board it also reports the lesson map. */}
        <div className="px-5 py-1 text-[10px] text-[#98A0A9] border-t border-[#EEF0EC]" data-sk="job-tray" data-sk-map={mapStatus}>
          {mapStatus === "building" ? copy.preparingMap : copy.jobTrayEmpty}
        </div>

        {/* S1: confirmation cards (§2.5). One active card at a time. */}
        <div data-sk="confirm-slot" className={cards.length ? "px-4 py-2 border-t border-[#EEF0EC] space-y-2" : "hidden"}>
          {cards.map((c) => {
            const left = secondsLeft(c.expiresAt, nowMs);
            const settled = c.status !== "active" && c.status !== "sending";
            return (
              <div key={c.id} className="rounded-xl border border-[#F3D9A4] bg-[#FFF9EC] px-3.5 py-3 text-sm" data-sk="confirm-card" data-sk-action={c.action} data-sk-status={c.status} role="group" aria-label={copy.confirmTitle}>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium text-[#14181F]">{c.title}</div>
                  {c.status === "active" && (
                    <span className="text-[10px] text-[#8A5A00] shrink-0" data-sk="confirm-expiry">
                      {fmt(copy.expiresIn, { s: left })}
                    </span>
                  )}
                </div>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {Object.entries(c.params).map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-[#98A0A9]">{paramLabel(k)}</dt>
                      <dd className="text-[#14181F] break-words">{v === null || v === undefined ? "—" : String(v)}</dd>
                    </Fragment>
                  ))}
                </dl>
                {settled ? (
                  <p className={`mt-2 text-xs ${c.status === "done" ? "text-[#0C4E47]" : "text-[#B42318]"}`}>{c.result}</p>
                ) : (
                  <div className="mt-2.5 flex items-center gap-2">
                    <button type="button" onClick={() => void act(c, "click")} disabled={c.status !== "active"} className="btn-primary h-8 px-3 text-xs disabled:opacity-50" data-sk="confirm-yes">
                      {c.status === "sending" ? copy.cardSent : copy.confirm}
                    </button>
                    <button type="button" onClick={() => dismissCard(c)} disabled={c.status !== "active"} className="h-8 px-3 text-xs rounded-lg border border-[#E6E8E4] text-[#5B6470] disabled:opacity-50" data-sk="confirm-no">
                      {copy.cancel}
                    </button>
                    {mic && <span className="text-[10px] text-[#98A0A9] ms-auto">{copy.voiceYesHint}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-[#EEF0EC]">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {mic && (
              <button
                type="button"
                disabled={ready === false}
                aria-pressed={listening}
                title={handsFree ? copy.handsFree : copy.holdToTalk}
                aria-label={handsFree ? copy.handsFree : copy.holdToTalk}
                data-sk="mic"
                data-sk-mode={handsFree ? "handsFree" : "ptt"}
                className={`h-9 w-9 rounded-lg border text-base shrink-0 select-none disabled:opacity-40 ${
                  listening ? "border-[#B42318] text-[#B42318] animate-pulse" : "border-[#E6E8E4] text-[#5B6470]"
                }`}
                style={{ touchAction: "none" }}
                onContextMenu={(e) => e.preventDefault()}
                // Hands-free: a click toggles. Push-to-talk: hold.
                onClick={handsFree ? clickMicHandsFree : undefined}
                onPointerDown={handsFree ? undefined : pressMic}
                onPointerUp={handsFree ? undefined : releaseMic}
                onPointerLeave={handsFree ? undefined : releaseMic}
                onPointerCancel={handsFree ? undefined : releaseMic}
                onKeyDown={
                  handsFree
                    ? undefined
                    : (e) => {
                        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                          e.preventDefault();
                          pressMic();
                        }
                      }
                }
                onKeyUp={
                  handsFree
                    ? undefined
                    : (e) => {
                        if (e.key === " " || e.key === "Enter") {
                          e.preventDefault();
                          releaseMic();
                        }
                      }
                }
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
              placeholder={listening ? copy.listening : copy.placeholder}
              className="field h-9 px-3 text-sm flex-1"
              data-sk="input"
            />
            <button type="submit" disabled={busy || !input.trim() || ready === false} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
              {busy ? "…" : copy.send}
            </button>
          </form>
          <div className="flex items-center justify-between mt-1.5 gap-2">
            {mic ? (
              <button
                type="button"
                onClick={toggleHandsFree}
                aria-pressed={handsFree}
                title={copy.handsFreeHint}
                data-sk="hands-free"
                className={`text-[10px] font-medium ${handsFree ? "text-[#0C8175]" : "text-[#98A0A9]"} hover:underline`}
              >
                {handsFree ? "●" : "○"} {copy.handsFree}
              </button>
            ) : (
              <span />
            )}
            {handsFree && listening && (
              // The persistent indicator §2.6 asks for while hands-free capture is on.
              <span className="text-[10px] font-medium text-[#B42318] animate-pulse" data-sk="listening">
                ● {copy.listening}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

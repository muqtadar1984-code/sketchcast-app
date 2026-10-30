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
//   transcript-store.ts — 2026-10-30: the visible turns across pages and
//                      Shell instances, so the hero and the panel are ONE
//                      conversation (same tab, same server session)
//   confirm.ts       — S1 §9.2: when a bare yes/no answers a confirm card
//   prefetch.ts      — which pages to warm (router.prefetch) so a navigate
//                      lands on a render already under way
//   tray.ts          — S2: the job tray's polling rule and state words
//   speech.ts        — S1 slice E: SK's voice — which provider (Polly when the
//                      server allows, the browser otherwise), the video paused
//                      while SK speaks and given back after, barge-in
// S1 adds the Board: on /present the launcher hands in a bridge
// (src/app/present/sk-board-bridge.ts) whose state rides with every turn and
// which performs the `board` events the server decides; and confirm cards,
// whose token goes back to /api/sk/act by click or spoken yes.
//
// Voice: SK speaks through the SpeechProvider seam (src/sk/speech) behind the
// coordinator; dictation stays on the Assistant's browser adapter
// (startDictation) so a hosted STT swap later is one module, not two panels.
//
// 2026-10-30 (founder): `variant="hero"` renders the SAME machinery inline at
// the top of a role's landing page (sk-home.tsx) instead of the floating
// panel: a still avatar, a one-line greeting, the conversation, the text box,
// and a Mic switch (prefs.ts micOn; on by default except for students). With
// the switch on SK listens hands-free through startDictation (so the
// Transcribe / browser choice applies unchanged) while the page is visible and
// focused, pauses while SK speaks (no echo) and comes back after, and resumes
// after blur / hidden / idle when she returns or interacts (mic-gate.ts
// autoResume; never on a timer). The panel variant is unchanged: push-to-talk,
// the hands-free opt-in, and a mic that never resumes by itself.

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { micSupported, pageSpeechLang, startDictation } from "@/utils/assistant/voice-client";
import { createSpeechCoordinator, serverProviderFor, speechMode, type SpeechCoordinator } from "@/sk/shell/client/speech";
import { BrowserSpeechProvider } from "@/sk/speech/browser";
import { googleVoiceFor } from "@/sk/speech/google-voices";
import { pollyVoiceFor } from "@/sk/speech/polly-marks";
import { pickBrowserVoice, readRigChoice, rigBaseForChoice, voiceGenderForChoice } from "@/sk/board/avatar";
import { useRigChoice } from "@/sk/board/use-rig-choice";
import RichText from "@/components/rich-text";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";
import { tourForRole, type TourCopy } from "@/tour/definitions";
import type { SkActRequest, SkActResponse, SkBoardMove, SkCitation, SkTurnEvent, SkTurnRequest, SkTutorMove } from "@/sk/shell/types";
import { SK_INTRO_TOUR } from "@/sk/shell/tour";
import { clockFrom, collect, localeFromLang } from "@/sk/shell/client/collector";
// S6 slice C: the preferences follow the user (workflow facts), with a
// one-time migration of this browser's localStorage values (prefs.ts).
import { PREF_KEYS, PREF_LOCAL_KEY, PREFS_MIGRATED_LOCAL_KEY, defaultMicOn, parseLocalFlag, pick, resolvePrefs, type SkPrefKey, type StoredPrefs } from "@/sk/prefs";
import { skTurnEvents } from "@/sk/shell/client/sse";
import { createMicGate, type MicGate } from "@/sk/shell/client/mic-gate";
import { runNarration, skIntroScript } from "@/sk/shell/client/narration";
import { createMemoryStore, type MemoryStore } from "@/sk/shell/client/memory-store";
import { createTranscriptStore, type TranscriptEntry, type TranscriptStore } from "@/sk/shell/client/transcript-store";
import { decideWithCards, secondsLeft } from "@/sk/shell/client/confirm";
import { pathsToPrefetch } from "@/sk/shell/client/prefetch";
import { citationChips } from "@/sk/shell/client/citations";
import { TRAY_POLL_MS, parseTray, shouldPollTray, trayStateText, trayVisible, type TrayKit } from "@/sk/shell/client/tray";
import type { SkBoardBridge } from "@/app/present/sk-board-bridge";
import type { SkTutorBridge } from "@/sk/shell/client/tutor-bridge";

export type SkShellCopy = Dictionary["sk"]["shell"];
export type SkShellVariant = "panel" | "hero";

/** The hero keeps the conversation compact: the latest turns, scrollable. */
const HERO_ENTRIES = 12;

type Label = "grounded" | "supplementary" | "declined" | "navigation";
type Entry = {
  id: string;
  who: "user" | "sk";
  text: string;
  tools?: Array<{ name: string; ok: boolean; summary: string }>;
  nav?: Array<{ path: string; label: string }>;
  /** S1: Board moves this turn performed, with the Board's own report. */
  moves?: Array<{ move: SkBoardMove | SkTutorMove; say: string; ok?: boolean; summary?: string }>;
  sources?: string[];
  /** S7 K2: the books / articles / uploads the answer came from (chips). */
  citations?: SkCitation[];
  label?: Label;
  /** Still streaming. */
  pending?: boolean;
  /** 2026-10-30: the language SK answered in (the `lang` event) — the bubble's
   *  direction and lang attribute follow it, not the page. */
  lang?: string;
  dir?: "ltr" | "rtl";
};

/** The BCP-47 tag for an answer language code (ms-arab → ms-Arab, zh → zh-CN). */
const htmlLangOf = (lang: string | undefined) => (lang === "ms-arab" ? "ms-Arab" : lang === "zh" ? "zh-CN" : lang);

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

type ContextReply = { ready?: boolean; greeting?: string; capabilities?: string[]; memory?: string; sessionId?: string; announced?: string; prefs?: StoredPrefs | null };

/** S6 slice C: this browser's stored preference values (localStorage). */
function readLocalPrefs(): StoredPrefs {
  const out: StoredPrefs = {};
  for (const k of PREF_KEYS) {
    const v = parseLocalFlag(readText(PREF_LOCAL_KEY[k]));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** S6 slice C: store a preference on the server (the user's workflow facts). */
function savePref(patch: Partial<Record<SkPrefKey, boolean>>): Promise<boolean> {
  return fetch("/api/sk/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })
    .then((r) => r.ok)
    .catch(() => false);
}

const LS_READ_ALOUD = "sk.readAloud";
/** S2: the server-signed note of kits the greeting already announced (ids only). */
const LS_ANNOUNCED = "sk.announced";
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

function readText(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeText(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
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
  tutor,
  variant = "panel",
  portalTo,
  onEngaged,
}: {
  copy: SkShellCopy;
  tourCopy: TourCopy;
  role: string | null;
  hat: string | null;
  /** Server-decided: shouldAutoStart(seen row for "sk-intro", SK_INTRO_TOUR.version). */
  introDue: boolean;
  /** The launcher flips its flag so a re-open in this session does not narrate again. */
  onIntroDone?: () => void;
  /** The panel's close; the hero has none. */
  onClose?: () => void;
  /** S1: on /present, the Board bridge — its state rides with every turn and
   *  it performs the `board` events the server decides. */
  board?: SkBoardBridge | null;
  /** S3 slice D: on /sk, the kit player bridge — its state rides with every
   *  turn and it performs the `tutor` events the server decides. */
  tutor?: SkTutorBridge | null;
  /** "panel" (default): the floating dialog. "hero": inline on a landing page. */
  variant?: SkShellVariant;
  /** The hero's place on the page (sk-home.tsx). The launcher keeps ONE Shell
   *  across pages and portals it there while a landing page shows a slot, so
   *  the conversation (and a turn still streaming) survives the move. */
  portalTo?: HTMLElement | null;
  /** Called when she sends a turn — the launcher carries an engaged
   *  conversation on into the panel when she leaves the hero's page. */
  onEngaged?: () => void;
}) {
  const router = useRouter();
  const hero = variant === "hero";
  const [rig] = useRigChoice();

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
  // S2: the job tray (SK-started kits) and whether the tab is visible.
  const [tray, setTray] = useState<TrayKit[]>([]);
  const [visible, setVisible] = useState(true);
  // The hero's Mic switch (prefs.ts micOn; default by role) and why the mic
  // cannot be used. `prefsSettled` holds the first listen back until the
  // server's preference is known, so a saved "off" never opens the mic.
  const [micOn, setMicOn] = useState(false);
  const [micNote, setMicNote] = useState<"unsupported" | "denied" | null>(null);
  const [prefsSettled, setPrefsSettled] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speechRef = useRef<SpeechCoordinator | null>(null);
  const turnRef = useRef<AbortController | null>(null);
  const narrationRef = useRef<AbortController | null>(null);
  const memoryRef = useRef<string | undefined>(undefined);
  /** 2026-10-30: the dictation language while she has chosen an answer
   *  language ("say that in Arabic"); null = the page's. */
  const dictLangRef = useRef<string | null>(null);
  /** The language Transcribe heard the last dictation in (a hint the server weighs). */
  const spokenLangRef = useRef<string | null>(null);
  const storeRef = useRef<MemoryStore | null>(null);
  const transcriptRef = useRef<TranscriptStore | null>(null);
  /** The server session the visible transcript belongs to (transcript-store.ts). */
  const sessionIdRef = useRef<string | null>(null);
  const onEngagedRef = useRef(onEngaged);
  const boardRef = useRef<SkBoardBridge | null | undefined>(board);
  const tutorRef = useRef<SkTutorBridge | null | undefined>(tutor);
  const cardsRef = useRef<Card[]>([]);
  const gateRef = useRef<MicGate | null>(null);
  const stopMicRef = useRef<(() => void) | null>(null);
  const micModeRef = useRef<"ptt" | "handsFree" | null>(null);
  const dictatedRef = useRef("");
  const emptyEndsRef = useRef(0);
  const handsFreeRef = useRef(false);
  const readAloudRef = useRef(true);
  const micOnRef = useRef(false);
  const speakingRef = useRef(false);
  /** The hero gate's onResume, current every render (the gate outlives renders). */
  const listenNowRef = useRef<() => void>(() => {});
  const introStartedRef = useRef(false);
  const introPostedRef = useRef(false);
  const sendRef = useRef<(text: string, modality: "text" | "voice") => Promise<void>>(async () => {});
  const prefetchedRef = useRef(new Set<string>());

  /** Warm the pages `navigate` can send this role to, once each per panel,
   *  as soon as the server says the panel may navigate (the context GET, then
   *  every turn's `meta`). router.prefetch is a hint: it never throws into the
   *  turn and is a no-op where the router has nothing to fetch. */
  const warmNavigation = useCallback(
    (capabilities: string[]) => {
      for (const path of pathsToPrefetch({ role, hat, capabilities, done: prefetchedRef.current })) {
        try {
          router.prefetch(path);
        } catch {
          /* a hint only */
        }
      }
    },
    [role, hat, router],
  );

  // ── preferences + feature detection (post-mount: no hydration mismatch) ──
  useEffect(() => {
    const id = setTimeout(() => {
      setMic(micSupported());
      const ra = readFlag(LS_READ_ALOUD, true);
      const hf = readFlag(LS_HANDS_FREE, false);
      setReadAloud(ra);
      readAloudRef.current = ra;
      speechRef.current?.setEnabled(ra);
      setHandsFree(hf);
      handsFreeRef.current = hf;
      // The hero's switch: this browser's copy for the first paint, else the
      // role's default; the server's value follows with the warm start.
      const mo = readFlag(PREF_LOCAL_KEY.micOn, defaultMicOn(role));
      setMicOn(mo);
      micOnRef.current = mo;
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── the §2.6 mic gate: one per panel; onStop is the ONLY way dictation ends from outside ──
  // The hero's gate can also RESUME (founder 2026-10-30): while the Mic switch
  // is on, it calls listenNow when she is back on the page or interacts with
  // it, never while SK is speaking. The panel's gate gets no onResume.
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
      ...(hero ? { onResume: () => listenNowRef.current(), canResume: () => !speakingRef.current } : {}),
    });
    gateRef.current = gate;
    return () => {
      gate.dispose();
      gateRef.current = null;
    };
  }, [hero]);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  useEffect(() => {
    tutorRef.current = tutor;
  }, [tutor]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // ── SK's voice (§2.6 lifecycle 2): one coordinator per panel ──
  // The public flag only makes the client ASK for the server voice (polly or
  // google); the server's SK_TTS decides (404 → the browser voice, sticky).
  // The Board adapter reads the bridge through its ref so a bridge that
  // arrives later is seen. Playback
  // stops on barge-in (push-to-talk, hands-free start, a new question), on
  // Stop, on read-aloud off, on pagehide and when the panel unmounts.
  useEffect(() => {
    const tts = speechMode(process.env.NEXT_PUBLIC_SK_TTS);
    const serverMode = tts === "google" ? "google" : "polly";
    const coord = createSpeechCoordinator({
      server: tts !== "browser",
      serverMode,
      // The Polly voices are English (Joanna / Matthew): an answer in another
      // language (2026-10-30: the answer language can differ from the page)
      // is read by the browser voice for that language. The Google voices
      // cover every SK language: each line goes to the server with its lang.
      makeProvider: (lang) => serverProviderFor(serverMode, lang, () => readRigChoice()),
      fallback: (lang) => new BrowserSpeechProvider(lang),
      defaultLang: pageSpeechLang(),
      board: {
        // The Board's video — or, on /sk, the student's kit video (S3 slice D).
        isPlaying: () => {
          const st = boardRef.current?.state();
          if (st) return st.paused === false;
          return tutorRef.current?.playing() ?? false;
        },
        pause: async () => {
          if (boardRef.current) await boardRef.current.run("pause", {});
          else await tutorRef.current?.run("pause", {});
        },
        resume: async () => {
          if (boardRef.current) await boardRef.current.run("resume", {});
          else await tutorRef.current?.run("play", {});
        },
      },
      // The same look → voice rule as the student page (A female, B male).
      // A browser voice is only picked when the page's language has voices;
      // otherwise the engine chooses by the utterance's lang.
      voice: (id, lang) => {
        const gender = voiceGenderForChoice(readRigChoice());
        if (id !== "browser") return serverMode === "google" ? googleVoiceFor(lang, gender) : pollyVoiceFor(gender);
        const prefix = (lang.split("-")[0] ?? "en").toLowerCase();
        const voices = typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        const pool = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
        const name = pool.length ? pickBrowserVoice(pool, gender, prefix) : null;
        return name ? `browser:${name}` : "browser:default";
      },
      onSpeaking: setSpeaking,
      onFallback: (why) => console.info(`[sk] server voice ${why}; using the browser voice`),
    });
    coord.setEnabled(readAloudRef.current);
    speechRef.current = coord;
    const onPageHide = () => coord.stop();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      coord.stop();
      if (speechRef.current === coord) speechRef.current = null;
    };
  }, []);

  // ── the cross-page memory store (sessionStorage) + the 1 s tick ──
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    storeRef.current = createMemoryStore(storage);
    transcriptRef.current = createTranscriptStore(storage);
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  /** Remember the server's memory blob here AND across pages (§5.4). */
  const keepMemory = useCallback((memory: string | undefined, sessionId?: string | null) => {
    if (!memory) return;
    memoryRef.current = memory;
    if (sessionId) sessionIdRef.current = sessionId;
    storeRef.current?.save({ memory, sessionId: sessionId ?? null });
  }, []);

  // ── S2: the job tray — her SK-started kits (/api/sk/shell/tray) ──
  // Read on open, after a lesson.prepare confirm, and every 15 s while a kit
  // is still being made AND this tab is visible (client/tray.ts shouldPollTray;
  // the visibility test is the §2.6 mic gate's). The panel being mounted IS
  // the panel being open. A failed read keeps what the tray showed.
  const loadTray = useCallback(async () => {
    try {
      const q = new URLSearchParams({ path: window.location.pathname });
      const res = await fetch(`/api/sk/shell/tray?${q.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      setTray(parseTray(await res.json().catch(() => null)));
    } catch {
      /* the tray is a convenience: keep the last state */
    }
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      const v = document.visibilityState === "visible";
      setVisible(v);
      if (v) void loadTray(); // back on the tab: one read, then the rule decides
    };
    const t = window.setTimeout(() => {
      setVisible(document.visibilityState === "visible");
      void loadTray();
    }, 0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadTray]);

  const trayPolling = shouldPollTray({ open: true, visibility: visible ? "visible" : "hidden", kits: tray });
  useEffect(() => {
    if (!trayPolling) return;
    const id = window.setInterval(() => void loadTray(), TRAY_POLL_MS);
    return () => window.clearInterval(id);
  }, [trayPolling, loadTray]);

  // ── warm start: greeting + capabilities + memory ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // POST (S2): the conversation this tab carries and the note of kits
        // already announced go WITH the warm start, so the greeting can lead
        // with "Your kit for … is ready" exactly once.
        const saved = storeRef.current?.load() ?? null;
        const res = await fetch("/api/sk/shell/context", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: window.location.pathname, memory: saved?.memory, announced: readText(LS_ANNOUNCED), tutor: tutorRef.current?.state(), clock: clockFrom(new Date()) }),
        });
        const d = (await res.json().catch(() => ({}))) as ContextReply;
        if (cancelled) return;
        if (!res.ok) {
          setReady(false);
          setError(copy.failed);
          return;
        }
        setReady(d.ready !== false);
        const caps = Array.isArray(d.capabilities) ? d.capabilities : [];
        setCapabilities(caps);
        warmNavigation(caps);
        // The server already applied the carried conversation (signature,
        // hat, 4-hour gap) and returns it — plus what the greeting announced —
        // or a fresh one; the saved blob is only the fallback.
        if (d.memory) keepMemory(d.memory, d.sessionId ?? null);
        else if (saved) memoryRef.current = saved.memory;
        sessionIdRef.current = d.sessionId ?? (d.memory ? null : saved?.sessionId ?? null);
        if (d.announced) writeText(LS_ANNOUNCED, d.announced);
        // S6 slice C: the server's preferences win; a value only this browser
        // holds is migrated up once (prefs.ts resolvePrefs). A reply without
        // prefs (unreadable) changes nothing.
        if (d.prefs !== undefined) {
          const r = resolvePrefs(d.prefs === null ? null : pick(d.prefs), readLocalPrefs(), readText(PREFS_MIGRATED_LOCAL_KEY) === "1", role);
          micOnRef.current = r.prefs.micOn;
          setMicOn(r.prefs.micOn);
          readAloudRef.current = r.prefs.readAloud;
          setReadAloud(r.prefs.readAloud);
          speechRef.current?.setEnabled(r.prefs.readAloud);
          handsFreeRef.current = r.prefs.handsFree;
          setHandsFree(r.prefs.handsFree);
          if (d.prefs !== null) {
            for (const k of PREF_KEYS) writeFlag(PREF_LOCAL_KEY[k], r.prefs[k]);
            if (Object.keys(r.migrate).length) void savePref(r.migrate).then((ok) => ok && writeText(PREFS_MIGRATED_LOCAL_KEY, "1"));
            else writeText(PREFS_MIGRATED_LOCAL_KEY, "1");
          }
        }
        setPrefsSettled(true);
        // 2026-10-30: the conversation she was having in this tab (the hero
        // on the home page, the panel on another) carries on as it was — no
        // re-greeting — when the server carried THAT session.
        const carried = transcriptRef.current?.load(sessionIdRef.current) as Entry[] | null | undefined;
        if (carried?.length) {
          setEntries(carried);
          const lastSk = [...carried].reverse().find((e) => e.who === "sk" && e.text);
          setCaption(lastSk ? lastSentence(lastSk.text) : "");
          return;
        }
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
    // One conversation per tab: every change is what the next Shell restores.
    if (entries.length) transcriptRef.current?.save(sessionIdRef.current, entries as unknown as TranscriptEntry[]);
  }, [entries]);
  useEffect(() => {
    onEngagedRef.current = onEngaged;
  }, [onEngaged]);

  // Unmount: the mic and the in-flight turn stop with the panel (the voice
  // stops in its own effect's cleanup — lifecycle 2, playback stops on
  // navigation away; the conversation itself lives server-side in the memory
  // blob and survives).
  useEffect(
    () => () => {
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

  /** Speak one line (the coordinator honours the read-aloud setting and the
   *  Board's video; a stopped answer never comes back because stop() drops the queue). */
  const speakLine = useCallback((line: string) => {
    void speechRef.current?.say(line);
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
          selection: boardRef.current?.selection(),
          tutor: tutorRef.current?.state(),
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
      // S2: a kit just started — the tray shows it now, not at the next poll.
      if (ok && card.action === "lesson.prepare") void loadTray();
      const line = (reply?.summary && String(reply.summary).trim()) || (ok ? copy.cardSent : copy.actFailed);
      patchCard(card.id, { status: ok ? "done" : "failed", result: line });
      retireCard(card.id);
      appendSk(line, { label: ok ? "grounded" : "declined", sources: [card.action] });
      speakLine(line);
    },
    [appendSk, copy, keepMemory, loadTray, patchCard, retireCard, speakLine],
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
      onIntroDone?.();
    },
    [onIntroDone],
  );

  useEffect(() => {
    if (!introDue || ready === null || introStartedRef.current) return;
    // The hero greets in text only — the §4.6 intro SPEAKS, and a browser
    // blocks audio before her first gesture. A Shell that began as the hero
    // never narrates it (not even after it moves into the panel mid-talk).
    if (hero) {
      introStartedRef.current = true;
      return;
    }
    // Deferred like TourProvider: Strict Mode's mount/unmount/mount would
    // otherwise abort a narration that had already started and record it as
    // skipped. The flag flips INSIDE the timer so a cleared timer reschedules.
    const t = setTimeout(() => {
      introStartedRef.current = true;
      const ac = new AbortController();
      narrationRef.current = ac;
      const def = tourForRole(role, tourCopy) ?? tourForRole("teacher", tourCopy);
      const lines = skIntroScript({ copy, tourCopy, steps: def?.steps ?? [], role });
      // The narration speaks through the coordinator (read-aloud off = silent
      // lines in the transcript; Skip/Stop = the runner's stop → barge-in).
      const coord = speechRef.current;
      const stream = coord?.stream();
      const speaker = {
        push: (t: string) => stream?.push(t),
        flush: () => void stream?.flush(),
        stop: () => coord?.stop(),
      };
      setNarrating(true);
      void runNarration(lines, speaker, {
        signal: ac.signal,
        onLine: (line) => appendSk(line),
      }).then((r) => {
        finishIntro(r.completed ? "completed" : "skipped");
      });
    }, 500);
    return () => clearTimeout(t);
  }, [introDue, ready, role, tourCopy, copy, appendSk, finishIntro, hero]);

  function skipIntro() {
    narrationRef.current?.abort();
    speechRef.current?.stop();
  }

  // ── voice controls ──
  function toggleReadAloud() {
    const nv = !readAloudRef.current;
    readAloudRef.current = nv;
    setReadAloud(nv);
    writeFlag(LS_READ_ALOUD, nv);
    void savePref({ readAloud: nv });
    speechRef.current?.setEnabled(nv);
    // Off = an explicit stop (§2.6): whatever SK was saying ends now.
    if (!nv) speechRef.current?.stop();
  }

  function toggleHandsFree() {
    const nv = !handsFreeRef.current;
    handsFreeRef.current = nv;
    setHandsFree(nv);
    writeFlag(LS_HANDS_FREE, nv);
    void savePref({ handsFree: nv });
    // Turning the opt-in OFF while listening hands-free ends the capture now.
    if (!nv && micModeRef.current === "handsFree") gateRef.current?.stop("manual");
  }

  // ── the hero's Mic switch (founder 2026-10-30) ──
  /** The microphone is refused: the switch goes off and STAYS off (saved, so
   *  the next visit does not ask again), with a short note. */
  const micRefused = useCallback(() => {
    micOnRef.current = false;
    setMicOn(false);
    writeFlag(PREF_LOCAL_KEY.micOn, false);
    void savePref({ micOn: false });
    setMicNote("denied");
    gateRef.current?.setAutoResume(false);
    gateRef.current?.stop("manual");
  }, []);

  /** The browser's word on the microphone, where it can say. */
  function micPermission(): Promise<PermissionState | null> {
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!perms) return Promise.resolve(null);
    return perms
      .query({ name: "microphone" as PermissionName })
      .then((st) => st.state)
      .catch(() => null);
  }

  function toggleMic() {
    if (!mic) return;
    const nv = !micOnRef.current;
    micOnRef.current = nv;
    setMicOn(nv);
    setMicNote(null);
    writeFlag(PREF_LOCAL_KEY.micOn, nv);
    void savePref({ micOn: nv });
    // The effect below starts or ends the capture; this click is the user
    // gesture a first permission prompt (and SK's voice) needs.
  }

  /** The hero gate's onResume: the page is visible and focused, SK is quiet.
   *  No barge-in here — the gate never resumes while SK speaks. */
  function listenNow() {
    const gate = gateRef.current;
    if (!gate || !micOnRef.current || micModeRef.current || ready !== true) return;
    if (!gate.start({ idle: true })) return;
    micModeRef.current = "handsFree";
    emptyEndsRef.current = 0;
    beginDictation("handsFree");
  }
  useEffect(() => {
    listenNowRef.current = listenNow;
  });

  // The hero listens while the switch is on, the browser can, the panel is
  // ready and the server's preference is known; off ends the capture now.
  useEffect(() => {
    if (!hero) return;
    const gate = gateRef.current;
    if (!gate) return;
    const want = micOn && mic && ready === true && prefsSettled;
    gate.setAutoResume(want);
    if (want) gate.resume();
    else if (micModeRef.current) gate.stop("manual");
  }, [hero, micOn, mic, ready, prefsSettled]);

  // Refused in this browser (Permissions API, where it exists) — already, or
  // in the prompt the first listen raised: the switch goes off and stays off
  // rather than failing on every visit.
  useEffect(() => {
    if (!hero || !micOn || !prefsSettled) return;
    let live = true;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (live && status?.state === "denied" && micOnRef.current) micRefused();
    };
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    perms
      ?.query({ name: "microphone" as PermissionName })
      .then((st) => {
        status = st;
        st.addEventListener("change", onChange);
        onChange();
      })
      .catch(() => {
        /* not queryable here: three refused listens pause it instead */
      });
    return () => {
      live = false;
      status?.removeEventListener("change", onChange);
    };
  }, [hero, micOn, prefsSettled, micRefused]);

  // No echo: the hero's mic pauses while SK speaks and comes back after (the
  // gate owes the resume; its canResume veto reads speakingRef).
  useEffect(() => {
    speakingRef.current = speaking;
    if (!hero) return;
    const gate = gateRef.current;
    if (!gate) return;
    if (speaking) gate.stop("speaking");
    else gate.resume();
  }, [speaking, hero]);

  /** Stop = the voice, the answer being written AND the narration. The video
   *  stays where it is (an explicit stop never resumes it; "continue" does). */
  function stopAll() {
    turnRef.current?.abort();
    narrationRef.current?.abort();
    speechRef.current?.stop();
  }

  /** One dictation pass. Hands-free restarts it after each utterance for as
   * long as the gate is still active; the gate's onStop is the only thing that
   * ends the loop, and nothing here ever restarts it after that (§2.6). */
  function beginDictation(mode: "ptt" | "handsFree") {
    const gate = gateRef.current;
    if (!gate?.active) return;
    const startedAt = Date.now();
    dictatedRef.current = "";
    spokenLangRef.current = null;
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
            // (permission, no device). Stop rather than spin. The hero pauses
            // as for idle instead (back on her next interaction, never by
            // itself) and asks the browser whether the mic is refused.
            gate.stop(hero ? "idle" : "manual");
            if (hero) void micPermission().then((st) => st === "denied" && micRefused());
            return;
          }
          beginDictation("handsFree");
          return;
        }
        // Push-to-talk: the words stay in the box; Enter sends.
        setListening(false);
        if (mode === "ptt") inputRef.current?.focus();
      },
      // Transcribe (en/ms/ar/zh) identifies which of those she speaks, so she
      // can switch by speaking; the browser recognizer listens in `lang`.
      { lang: dictLangRef.current ?? pageSpeechLang(), identify: true, onLanguage: (l) => (spokenLangRef.current = l) },
    );
    if (!stop) {
      if (hero) setMicNote("unsupported");
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
    speechRef.current?.stop(); // barge-in: the teacher is about to speak
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
    speechRef.current?.stop(); // barge-in: hands-free capture starts
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
          // §9.2: a click-only card (it spends credits) is never confirmed by
          // voice. Say so and keep the card — posting would only be refused.
          if (modality === "voice" && active[0].params.click_only === true) {
            appendSk(copy.clickOnlyHint, { label: "declined", sources: [active[0].action] });
            speakLine(copy.clickOnlyHint);
            return;
          }
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
      onEngagedRef.current?.();
      // A new question interrupts whatever SK was saying (barge-in) and the
      // intro if it is still running.
      turnRef.current?.abort();
      narrationRef.current?.abort();
      const coord = speechRef.current;
      coord?.stop();
      const turn = new AbortController();
      turnRef.current = turn;
      // The answer is spoken a sentence at a time as it streams — in the
      // answer's language (the `lang` event arrives before the text).
      let speechLang: string | null = null;
      let stream: ReturnType<SpeechCoordinator["stream"]> | undefined;
      const streamFor = () => (stream ??= coord?.stream(speechLang ? { lang: speechLang } : {}));

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
          // The Board's state rides along so the server can decide a move —
          // and, before a lesson, the bar's pick so it can start one.
          board: boardRef.current?.state(),
          selection: boardRef.current?.selection(),
          tutor: tutorRef.current?.state(),
        }),
      };
      if (memoryRef.current) req.memory = memoryRef.current;
      if (modality === "voice" && spokenLangRef.current) req.spokenLang = spokenLangRef.current;

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
        if (modality === "text") inputRef.current?.focus();
      }

      function handle(ev: SkTurnEvent) {
        switch (ev.type) {
          case "meta":
            // A turn with no `lang` event is in the page's language.
            dictLangRef.current = null;
            if (ev.capabilities) {
              setCapabilities(ev.capabilities);
              warmNavigation(ev.capabilities);
            }
            if (ev.memory) keepMemory(ev.memory, ev.sessionId);
            break;
          case "text":
            full += ev.text;
            patchEntry(skId, (en) => ({ ...en, text: full }));
            setCaption(lastSentence(full));
            streamFor()?.push(ev.text);
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
            // performs it here, in the coordinator's order: pause the video
            // (if it plays) → speak the move's line → run the move. The move
            // then owns the Board's state — SK never resumes after one; a move
            // that plays (intro, segment, resume) starts the video itself.
            const b = boardRef.current;
            const say = ev.say ?? "";
            patchEntry(skId, (en) => ({
              ...en,
              text: en.text || say,
              moves: [...(en.moves ?? []), { move: ev.move, say }],
            }));
            if (say) setCaption(say);
            if (!b) {
              patchEntry(skId, (en) => ({ ...en, moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: false, summary: copy.boardNotOpen } : m)) }));
              break;
            }
            // The streamed answer already carries the words when text came first.
            const line = full ? "" : say;
            const runMove = () => b.run(ev.move, ev.args ?? {});
            moveRuns.push(
              (async () => {
                const r = coord ? await coord.announceMove(line, runMove) : await runMove();
                patchEntry(skId, (en) => ({
                  ...en,
                  moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: r.ok, summary: r.summary } : m)),
                }));
                if (!r.ok) setError(r.summary);
                // The slides load (Board UX 2026-10-28) closes with where the
                // pages landed — known only now, so the panel says it, in her
                // language, rather than the server ahead of time. The deck
                // load brings its own line (the server's template, filled by
                // the bridge); the slides line is the fallback.
                if (r.ok && (r.done || r.loaded)) {
                  const done = r.done ?? fmt(copy.slidesLoaded, { n: r.loaded!.n, a: r.loaded!.a, b: r.loaded!.b });
                  setCaption(done);
                  speakLine(done);
                }
              })(),
            );
            break;
          }
          case "tutor": {
            // S3 slice D: a move on the student's kit player, decided and
            // audited server-side; the player performs it through the bridge
            // (same order as a Board move: speak the line, then move).
            const tb = tutorRef.current;
            const say = ev.say ?? "";
            patchEntry(skId, (en) => ({ ...en, text: en.text || say, moves: [...(en.moves ?? []), { move: ev.move, say }] }));
            if (say) setCaption(say);
            if (!tb) {
              patchEntry(skId, (en) => ({ ...en, moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: false, summary: copy.tutorNotOpen } : m)) }));
              break;
            }
            const line = full ? "" : say;
            const runMove = () => tb.run(ev.move, ev.args ?? {});
            moveRuns.push(
              (async () => {
                const r = coord ? await coord.announceMove(line, runMove) : await runMove();
                patchEntry(skId, (en) => ({ ...en, moves: (en.moves ?? []).map((m) => (m.move === ev.move && m.ok === undefined ? { ...m, ok: r.ok, summary: r.summary } : m)) }));
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
          case "lang":
            // 2026-10-30: what the text that follows is in. Dictation follows
            // only her own choice (an Arabic kit does not make her speak Arabic).
            speechLang = ev.speech;
            dictLangRef.current = ev.override ? ev.speech : null;
            patchEntry(skId, (en) => ({ ...en, lang: ev.lang, dir: ev.dir }));
            break;
          case "done":
            sawDone = true;
            if (ev.memory) keepMemory(ev.memory);
            patchEntry(skId, (en) => ({ ...en, sources: ev.sources ?? [], label: ev.label, ...(ev.citations?.length ? { citations: ev.citations } : {}) }));
            void stream?.flush();
            break;
          case "error":
            setError(ev.message || copy.failed);
            break;
        }
      }
    },
    [ready, router, copy, patchEntry, act, dismissCard, appendSk, keepMemory, warmNavigation, speakLine],
  );
  // The hands-free loop sends from inside a dictation callback that outlives
  // any one render; it reaches the current `send` through this ref.
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // "Ask SK about this" on the Board (founder 2026-10-28): the chip's click
  // arrives through the bridge's ask channel — taken at once when the panel
  // is open, or on mount when the click is what opened it — and is sent as
  // her own line, so the transcript reads what she asked. The highlighted
  // words ride in the Board state (SkBoardState.selection).
  useEffect(() => {
    const ch = board?.asks();
    if (!ch) return;
    const run = () => {
      if (ch.take() === "explain_selection") void sendRef.current(copy.explainSelection, "text");
    };
    run();
    return ch.subscribe(run);
  }, [board, copy.explainSelection]);

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
  const slideLoad = board?.loading() ?? null;
  const nowMs = Date.now() + tick * 0;
  // Card labels: the dictionary's (sk.shell.cardParams) when it has one, else the key made readable.
  const cardLabels = copy.cardParams as Record<string, string> | undefined;
  const paramLabel = (k: string) => cardLabels?.[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  // Ids are for the server, not the teacher: a card shows names, text and dates.
  // `chapter_ref` (0-based) and `click_only` are for the server too, and so is
  // a notice's raw `audience` (S5 slice D: the card says it as `seen_by`).
  const shownParams = (params: Card["params"]) => Object.entries(params).filter(([k]) => !/(?:^|_)ids?$/.test(k) && k !== "chapter_ref" && k !== "click_only" && k !== "audience");
  const paramValue = (v: Card["params"][string]) => (v === null || v === undefined ? "—" : typeof v === "boolean" ? (v ? cardLabels?.yes ?? "Yes" : cardLabels?.no ?? "No") : String(v));

  // ── the hero (founder 2026-10-30): still avatar, Mic switch, greeting ──
  const hc = copy.hero;
  const micLive = micOn && mic;
  const heroHeader = (
    <div className="px-4 sm:px-6 pt-3 pb-3 border-b border-[#EEF0EC]">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-slate-600">{copy.title}</span>
        <div className="flex items-center gap-3 shrink-0">
          {showStop ? (
            <button type="button" onClick={stopAll} className="text-xs font-medium text-[#B42318] hover:underline" title={copy.stop} data-sk="stop">
              ■ {copy.stop}
            </button>
          ) : (
            <button type="button" onClick={toggleReadAloud} aria-pressed={readAloud} className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-slate-500"} hover:underline`}>
              {readAloud ? "🔊" : "🔈"} {copy.readAloud}
            </button>
          )}
          {/* The Mic switch, top-end of the card: on by default (by role),
              one tap to turn off, remembered in her SK preferences. */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-xs font-medium text-slate-700" aria-hidden>
              {micLive ? hc.micOn : hc.micOff}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={micLive}
              aria-label={hc.micSwitch}
              title={micLive ? hc.micOn : hc.micOff}
              disabled={!mic}
              onClick={toggleMic}
              data-sk="mic-switch"
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                micLive ? "bg-[#0C8175] border-[#0C8175]" : "bg-slate-200 border-slate-300"
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${micLive ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5"}`}
              />
            </button>
          </label>
        </div>
      </div>
      <div className="mt-2 flex flex-col items-center text-center">
        {/* Still, cropped to head and shoulders. While SK speaks the ring and
            the label fade in — an opacity change, nothing moves. */}
        <div className="relative h-32 w-44 sm:h-36 sm:w-48 overflow-hidden rounded-2xl bg-[#E2F4F1]" data-sk="avatar" data-sk-look={rig}>
          <Image src={`${rigBaseForChoice(rig)}body.png`} alt="" width={727} height={1100} sizes="192px" priority className="h-full w-full object-cover object-top" />
          <span aria-hidden className={`pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-inset ring-[#0C8175] transition-opacity ${speaking ? "opacity-100" : "opacity-0"}`} />
        </div>
        <span className={`mt-1 text-[11px] font-medium text-[#0C8175] transition-opacity ${speaking ? "opacity-100" : "opacity-0"}`} aria-hidden={!speaking} data-sk="speaking">
          {hc.speaking}
        </span>
        <p className="mt-0.5 text-sm text-slate-700" data-sk="hero-greeting">
          {hc.greeting}
        </p>
      </div>
    </div>
  );
  // The line under the text box: why the mic cannot listen, the live
  // indicator (§2.6), or the quiet paused state (idle, or the tab was away).
  const heroMicLine =
    prefsSettled && !mic ? (
      <span className="text-slate-500" data-sk="mic-note" data-sk-why="unsupported">
        {hc.micUnsupported}
      </span>
    ) : micNote ? (
      <span className="text-slate-500" data-sk="mic-note" data-sk-why={micNote}>
        {micNote === "denied" ? hc.micDenied : hc.micUnsupported}
      </span>
    ) : listening ? (
      <span className="inline-flex items-center gap-1.5 font-medium text-[#B42318]" data-sk="listening">
        <span className="inline-block h-2 w-2 rounded-full bg-[#B42318]" aria-hidden />
        {copy.listening}
      </span>
    ) : micLive && prefsSettled && ready === true && !speaking ? (
      <span className="text-slate-500" data-sk="mic-paused">
        {hc.paused}
      </span>
    ) : null;

  const body = (
    <>
      {hero ? (
        heroHeader
      ) : (
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#EEF0EC]">
          <div className="min-w-0">
            <div className="font-display font-medium flex items-center gap-1.5 text-slate-900">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#0C8175] text-white text-[11px] font-semibold" aria-hidden>
                SK
              </span>
              <span className="truncate text-slate-900">{copy.title}</span>
            </div>
            {capabilities.length > 0 && (
              <div className="text-[10px] text-slate-500 truncate" data-sk="capabilities">
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
                className={`text-xs font-medium ${readAloud ? "text-[#0C8175]" : "text-slate-500"} hover:underline`}
              >
                {readAloud ? "🔊" : "🔈"} {copy.readAloud}
              </button>
            )}
            <button onClick={onClose} className="text-slate-500 hover:text-slate-700 text-lg leading-none" aria-label={copy.close}>
              ×
            </button>
          </div>
        </div>
      )}

      {/* S2 job tray: her SK-started kits, newest first, at most 3. Hidden when empty. */}
      {trayVisible(tray) && (
        <div className="px-5 py-2 border-b border-[#EEF0EC] bg-[#FAFBF9]" data-sk="kit-tray" data-sk-polling={trayPolling ? "on" : "off"}>
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 mb-1">{copy.tray.title}</div>
          <ul className="space-y-1">
            {tray.map((k) => (
              <li key={k.id} className="flex items-center gap-2 text-xs" data-sk="kit-tray-item" data-sk-state={k.state}>
                <span className="min-w-0 flex-1 truncate text-slate-900" title={k.title}>
                  {k.title}
                </span>
                <span
                  className={`shrink-0 ${k.state === "failed" ? "text-[#B42318]" : k.state === "ready" ? "text-[#0C8175] font-medium" : "text-slate-600"}`}
                >
                  {(k.state === "making" || k.state === "partial") && <span className="animate-pulse" aria-hidden>● </span>}
                  {trayStateText(k, copy.tray)}
                </span>
                {k.href && (
                  <button type="button" onClick={() => router.push(k.href as string)} className="shrink-0 text-[#0C8175] font-medium hover:underline" data-sk="kit-tray-open">
                    {copy.tray.open}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Transcript */}
      <div ref={scrollRef} className={hero ? "max-h-72 overflow-y-auto px-4 sm:px-6 py-3 space-y-3" : "flex-1 overflow-y-auto px-5 py-4 space-y-3"} data-sk="transcript">
        {ready === null && <p className="text-sm text-slate-500">…</p>}
        {(hero ? entries.slice(-HERO_ENTRIES) : entries).map((e) => (
          <div key={e.id} className={e.who === "user" ? "flex flex-col items-end" : "flex flex-col items-start"}>
            {e.who === "user" && <span className="text-[10px] text-slate-500 me-1 mb-0.5">{copy.you}</span>}
            {(e.text || e.pending) && (
              <div
                dir={e.who === "sk" && e.dir ? e.dir : undefined}
                lang={e.who === "sk" ? htmlLangOf(e.lang) : undefined}
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                  e.who === "user" ? "bg-[#E2F4F1] text-[#0C4E47] rounded-ee-sm" : "bg-[#F4F6F3] text-slate-900 rounded-es-sm"
                }`}
              >
                {e.text ? <RichText text={e.text} /> : <span className="text-slate-500">…</span>}
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
            {e.who === "sk" && e.citations?.length
              ? (() => {
                  const chips = citationChips(e.citations, copy.knowledge.chapter);
                  return chips.length ? (
                    <div className="flex flex-wrap items-center gap-1 mt-1 ms-1" data-sk="citations" role="list" aria-label={copy.knowledge.sources}>
                      <span className="text-[10px] text-slate-500">{copy.knowledge.sources}:</span>
                      {chips.map((c) => (
                        <span key={c.key} role="listitem" className="text-[10px] px-1.5 py-0.5 rounded-full border border-[#E3DAF3] bg-[#F8F5FD] text-[#4A3B78]" data-sk="citation" data-sk-kind={c.kind} title={c.text}>
                          {c.text}
                        </span>
                      ))}
                    </div>
                  ) : null;
                })()
              : null}
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

      {/* Caption — SK's latest sentence; the Board reads this line later.
          The hero shows the conversation itself, so it has no caption or
          job line: avatar, greeting, conversation, text box. */}
      {!hero && (
        <div className="px-5 py-1.5 border-t border-[#EEF0EC] text-xs text-slate-600 truncate min-h-[1.75rem]" data-sk="caption" aria-live="polite">
          {caption}
        </div>
      )}

      {/* S0's job-tray line — on the Board it reports the lesson map and the
          slides load. S2's kits have their own list above the transcript. */}
      {!hero && (
        <div className="px-5 py-1 text-[10px] text-slate-600 border-t border-[#EEF0EC]" data-sk="job-tray" data-sk-map={mapStatus}>
          {slideLoad ? fmt(copy.loadingSlides, { k: slideLoad.k, n: slideLoad.n }) : mapStatus === "building" ? copy.preparingMap : copy.jobTrayEmpty}
        </div>
      )}

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
                {shownParams(c.params).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-[#98A0A9]">{paramLabel(k)}</dt>
                    <dd className="text-[#14181F] break-words whitespace-pre-wrap">{paramValue(v)}</dd>
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
                  {c.params.click_only === true ? (
                    <span className="text-[10px] text-[#8A5A00] ms-auto" data-sk="confirm-click-only">
                      {copy.clickOnlyHint}
                    </span>
                  ) : (
                    mic && <span className="text-[10px] text-[#98A0A9] ms-auto">{copy.voiceYesHint}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={hero ? "px-4 sm:px-6 py-3 border-t border-[#EEF0EC]" : "px-4 py-3 border-t border-[#EEF0EC]"}>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {/* The hero has no push-to-talk button: its Mic switch listens. */}
          {mic && !hero && (
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
            className="field h-9 px-3 text-sm flex-1 min-w-0 bg-white text-slate-900 placeholder:text-slate-400"
            data-sk="input"
          />
          <button type="submit" disabled={busy || !input.trim() || ready === false} className="btn-primary h-9 px-4 text-sm text-white disabled:opacity-50">
            {busy ? "…" : copy.send}
          </button>
        </form>
        {hero ? (
          <div className="mt-1.5 min-h-[1rem] text-[11px]" data-sk="mic-line" aria-live="polite">
            {heroMicLine}
          </div>
        ) : (
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
        )}
      </div>
    </>
  );

  if (hero) {
    const card = (
      <HeroFrame role={role} hat={hat} title={copy.title}>
        {body}
      </HeroFrame>
    );
    return portalTo ? createPortal(card, portalTo) : card;
  }
  return (
    <PanelFrame onClose={onClose} role={role} hat={hat} title={copy.title}>
      {body}
    </PanelFrame>
  );
}

type FrameProps = { role: string | null; hat: string | null; title: string; children: ReactNode };

/** The floating dialog (S0). */
function PanelFrame({ onClose, role, hat, title, children }: FrameProps & { onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      {/* THE PANEL'S COLOURS ARE ITS OWN. It mounts on the Board too, whose page
          sets light text for a dark room, and an inherited `color` made the
          title and the typed text near-invisible there (founder, 2026-10-28).
          Near-black on the root overrides whatever the page set; color-scheme
          light keeps native controls from flipping dark with the page. */}
      <div
        className="card w-full max-w-md flex flex-col max-h-[92dvh] sm:max-h-[86dvh] rounded-b-none sm:rounded-b-2xl text-slate-900 [color-scheme:light]"
        onClick={(e) => e.stopPropagation()}
        data-sk="shell"
        data-sk-role={role ?? ""}
        data-sk-hat={hat ?? ""}
        role="dialog"
        aria-label={title}
      >
        {children}
      </div>
    </div>
  );
}

/** The home hero (2026-10-30): inline at the top of a landing page, with the
 *  same page-independent colours as the panel. */
function HeroFrame({ role, hat, title, children }: FrameProps) {
  return (
    <section
      className="card w-full max-w-2xl mx-auto mb-8 flex flex-col overflow-hidden text-slate-900 [color-scheme:light]"
      data-sk="hero"
      data-sk-role={role ?? ""}
      data-sk-hat={hat ?? ""}
      aria-label={title}
    >
      {children}
    </section>
  );
}

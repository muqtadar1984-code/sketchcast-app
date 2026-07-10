"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { SceneGraph, renderSvg, starterLibrary, type Library, type SceneGraphSnapshot, type BoardEvent } from "@/ere";

// The persistent teaching board (ERE / TAL). A PURE renderer of the server's
// authoritative board: each turn the server applies TAL and returns the new
// scene snapshot + that turn's events; we deserialise and render (animating only
// the newly-drawn objects) + narrate. No client-side re-apply, so the board can't
// drift from the server. Reduced-motion → render the final state, no animation.

export type TutorBoardHandle = { ask: (question: string) => Promise<{ mode: "board" | "text"; narration?: string }> };

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const TutorBoard = forwardRef<TutorBoardHandle, { generationId: string; readAloud: boolean; fit?: boolean }>(
  function TutorBoard({ generationId, readAloud, fit = false }, ref) {
  const [svg, setSvg] = useState("");
  const [active, setActive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const libRef = useRef<Library | null>(null);
  const lib = () => (libRef.current ??= starterLibrary());
  // A live turn has taken over the board → the (slower) open-time rehydrate must
  // not paint a now-stale snapshot over it.
  const dirtyRef = useRef(false);

  // Rehydrate an existing board when the panel opens (render statically).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tutor/turn?generationId=${encodeURIComponent(generationId)}`);
        const d = await res.json().catch(() => ({}));
        if (cancelled || dirtyRef.current) return; // a turn already rendered — don't clobber it
        const snap = d?.snapshot as SceneGraphSnapshot | null;
        if (snap && Array.isArray(snap.nodes) && snap.nodes.length) {
          setActive(true);
          setSvg(renderSvg(SceneGraph.fromJSON(snap, lib()), lib(), {}));
        }
      } catch {
        /* the board is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generationId]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const speak = useCallback(
    (text: string) => {
      if (!readAloud || !text || reducedMotion()) return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1;
      u.pitch = 1.05;
      synth.cancel();
      synth.speak(u);
    },
    [readAloud],
  );

  const render = useCallback((snapshot: SceneGraphSnapshot, events: BoardEvent[]) => {
    const graph = SceneGraph.fromJSON(snapshot, lib());
    if (reducedMotion()) {
      setSvg(renderSvg(graph, lib(), {})); // final state, no animation
      return;
    }
    // Rebase this turn's event times to ~0 so ONLY the new objects draw on now;
    // objects from prior turns render static (they carry no event this turn).
    const ts = events.map((e) => e.ts ?? 0);
    const t0 = ts.length ? Math.min(...ts) : 0;
    const rebased = events.map((e) => ({ ...e, ts: (e.ts ?? 0) - t0 }));
    setSvg(renderSvg(graph, lib(), { animate: true, events: rebased }));
  }, []); // lib() is a stable ref accessor; nothing reactive is closed over

  useImperativeHandle(
    ref,
    () => ({
      async ask(question: string): Promise<{ mode: "board" | "text"; narration?: string }> {
        dirtyRef.current = true; // from here on, the open-time rehydrate must not repaint
        setThinking(true);
        try {
          const res = await fetch("/api/tutor/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ generationId, question }),
          });
          const d = await res.json().catch(() => ({}));
          if (d?.mode !== "board" || !d.snapshot) return { mode: "text" }; // graceful fallback to chat
          setActive(true);
          render(d.snapshot as SceneGraphSnapshot, (d.events ?? []) as BoardEvent[]);
          const narration = String(d.narrationText ?? "");
          speak(narration);
          return { mode: "board", narration };
        } catch {
          return { mode: "text" };
        } finally {
          setThinking(false);
        }
      },
    }),
    [generationId, render, speak],
  );

  if (!active && !thinking) return null;

  // `fit` (maximized two-pane layout): fill the pane and centre a square board
  // that scales to the smaller of the pane's width/height. Otherwise: an inline
  // full-width square that flows with the chat (minimized layout). The child
  // <svg> is forced to fill its box in both cases ([&>svg] utilities).
  const svgFill = "[&>svg]:block [&>svg]:w-full [&>svg]:h-full";
  const board = svg ? (
    <div
      className={`${svgFill} ${fit ? "mx-auto max-w-full max-h-full" : "w-full"}`}
      style={fit ? { height: "100%", aspectRatio: "1 / 1" } : { aspectRatio: "1 / 1" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <div className="w-full grid place-items-center text-xs text-[#98A0A9]" style={{ aspectRatio: "1 / 1" }}>
      Coach is setting up the board…
    </div>
  );

  return (
    <div
      className={
        fit
          ? "h-full w-full flex items-center justify-center overflow-hidden relative"
          : "rounded-xl border border-[#EEF0EC] bg-white overflow-hidden mb-2 relative"
      }
    >
      {board}
      {thinking && active && (
        <div className="absolute top-1.5 right-2 text-[10px] text-[#0C8175] bg-white/80 rounded px-1.5 py-0.5">✎ working…</div>
      )}
    </div>
  );
});

export default TutorBoard;

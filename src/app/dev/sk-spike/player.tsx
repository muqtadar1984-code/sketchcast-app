"use client";

// SK S1 spike — thin React shell over SpikeRuntime (runtime.ts owns the DOM,
// the clock and the measurements). The shell loads the fixture + font, mounts
// the runtime once, and renders controls + the log.

import { useEffect, useRef, useState } from "react";
import type { OpentypeLike, Segment } from "./engine";
import { SpikeRuntime, type PlayerState } from "./runtime";

export default function SpikePlayer({ base }: { base: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const asideAudioRef = useRef<HTMLAudioElement>(null);
  const runtimeRef = useRef<SpikeRuntime | null>(null);
  const [seg, setSeg] = useState<Segment | null>(null);
  const [font, setFont] = useState<OpentypeLike | null>(null);
  const [state, setState] = useState<PlayerState | "loading">("loading");
  const [clockMs, setClockMs] = useState(0);
  const [log, setLog] = useState<string[]>([]);

  // Load fixture + handwriting font.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, ot] = await Promise.all([fetch(base + "segment.json").then((r) => r.json() as Promise<Segment>), import("opentype.js")]);
      const f = await new Promise<OpentypeLike>((res, rej) =>
        ot.load("/sk-s1/Caveat-Regular.ttf", (err, fnt) => (err || !fnt ? rej(err) : res(fnt as unknown as OpentypeLike))),
      );
      if (!alive) return;
      setSeg(s);
      setFont(f);
    })();
    return () => {
      alive = false;
    };
  }, [base]);

  // Mount the runtime once everything is here.
  useEffect(() => {
    if (!seg || !font || !hostRef.current || !audioRef.current || !asideAudioRef.current) return;
    const rt = new SpikeRuntime(hostRef.current, audioRef.current, asideAudioRef.current, seg, font, base, {
      state: setState,
      clock: setClockMs,
      log: (s) => setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()} ${s}`]),
    });
    runtimeRef.current = rt;
    (window as unknown as { __skRuntime?: SpikeRuntime }).__skRuntime = rt; // dev page: lets a harness read measurements
    rt.mount();
    const id = setTimeout(() => setState("ready"), 0); // after mount, not inside the effect's own render
    return () => {
      clearTimeout(id);
      rt.unmount();
      runtimeRef.current = null;
    };
  }, [seg, font, base]);

  // Space = interrupt (push-to-talk stand-in for the VAD).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && state === "playing") {
        e.preventDefault();
        void runtimeRef.current?.interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const download = () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const blob = new Blob([JSON.stringify(rt.summary(), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sk-s1-optionE-${Date.now()}.json`;
    a.click();
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="card p-2">
        <audio ref={audioRef} src={base + "audio.mp3"} preload="auto" />
        <audio ref={asideAudioRef} src={base + "aside1.mp3"} preload="auto" />
        {/* Controls ABOVE the board: the Next dev-tools badge sits bottom-left and would cover them. */}
        <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
          <button className="btn-primary h-9 px-3" onClick={() => runtimeRef.current?.play()} disabled={state === "loading" || state === "playing" || state === "answering" || state === "listening"}>
            ▶ Play
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => runtimeRef.current?.pause()} disabled={state !== "playing"}>
            ⏸ Pause
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void runtimeRef.current?.interrupt()} disabled={state !== "playing"} title="Space">
            ✋ Interrupt: “{seg?.aside.question ?? "…"}”
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => location.reload()} disabled={state === "loading"}>
            ⟳ Reload mid-segment
          </button>
          <button className="h-9 px-3 border rounded" onClick={download} disabled={state === "loading"}>
            ⤓ Measurements
          </button>
          <span className="text-xs text-[#667085]" data-testid="status">
            {state} · {(clockMs / 1000).toFixed(1)} s / {((seg?.audio.duration_ms ?? 0) / 1000).toFixed(1)} s
          </span>
        </div>
        <div ref={hostRef} className="w-full bg-white rounded" style={{ aspectRatio: "1 / 1", maxHeight: "80vh", margin: "0 auto" }} data-testid="board" />
      </div>
      <div className="card p-3 text-xs font-mono overflow-auto" style={{ maxHeight: "80vh" }} data-testid="log">
        <div className="font-semibold mb-1">log</div>
        {log.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

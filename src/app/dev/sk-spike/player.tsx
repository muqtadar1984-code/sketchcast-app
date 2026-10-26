"use client";

// SK S1 spike — thin React shell over SpikeRuntime (runtime.ts owns the DOM,
// the clock and the measurements). The shell loads the fixture + font (+ the
// hit map for Option S), mounts the runtime once, and renders controls + log.

import { useEffect, useRef, useState } from "react";
import { validateSegment, type OpentypeLike, type Segment } from "./engine";
import { SpikeRuntime, type HitMap, type Mode, type PlayerState, type Rig } from "./runtime";

// The SK characters (cut into layers by tools/sk-s1/make_rig.py): A (Malay
// woman, tudung) speaks with female voices, B (Indian man, glasses) with male
// voices — founder's choice 2026-10-27. The segment says which voice it has.
const rigBaseFor = (voiceGender: string | undefined) => (voiceGender === "male" ? "/sk-s1/sk-b/" : "/sk-s1/sk-a/");

export default function SpikePlayer({ base, mode = "E" }: { base: string; mode?: Mode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const asideAudioRef = useRef<HTMLAudioElement>(null);
  const runtimeRef = useRef<SpikeRuntime | null>(null);
  const [seg, setSeg] = useState<Segment | null>(null);
  const [font, setFont] = useState<OpentypeLike | null>(null);
  const [hitmap, setHitmap] = useState<HitMap | null>(null);
  const [rig, setRig] = useState<Rig | null>(null);
  const [state, setState] = useState<PlayerState | "loading">("loading");
  const [clockMs, setClockMs] = useState(0);
  const [log, setLog] = useState<string[]>([]);

  // Load fixture + handwriting font (+ hit map for S).
  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, ot, hm] = await Promise.all([
        fetch(base + "segment.json").then((r) => r.json() as Promise<Segment>),
        import("opentype.js"),
        mode === "S" ? fetch(base + "optionS.hitmap.json").then((r) => r.json() as Promise<HitMap>) : Promise.resolve(null),
      ]);
      const rigBase = rigBaseFor(s.voice_gender);
      const rg = await fetch(rigBase + "rig.json")
        .then((r) => (r.ok ? (r.json() as Promise<Rig>) : null))
        .catch(() => null);
      const f = await new Promise<OpentypeLike>((res, rej) =>
        ot.load("/sk-s1/Caveat-Regular.ttf", (err, fnt) => (err || !fnt ? rej(err) : res(fnt as unknown as OpentypeLike))),
      );
      if (!alive) return;
      // The security gate: a segment that fails validation never reaches the DOM.
      try {
        validateSegment(s);
      } catch (e) {
        setLog((l) => [...l, `REFUSED segment: ${(e as Error).message}`]);
        return;
      }
      setSeg(s);
      setFont(f);
      setHitmap(hm);
      setRig(rg);
    })();
    return () => {
      alive = false;
    };
  }, [base, mode]);

  // Mount the runtime once everything is here.
  useEffect(() => {
    const main = mode === "S" ? videoRef.current : audioRef.current;
    if (!seg || !font || !hostRef.current || !main || !asideAudioRef.current || (mode === "S" && !hitmap)) return;
    const rt = new SpikeRuntime(
      hostRef.current,
      main,
      asideAudioRef.current,
      seg,
      font,
      base,
      {
        state: setState,
        clock: setClockMs,
        log: (s) => setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()} ${s}`]),
      },
      { mode, hitmap: hitmap ?? undefined, rig: rig ? { data: rig, base: rigBaseFor(seg.voice_gender) } : undefined },
    );
    runtimeRef.current = rt;
    (window as unknown as { __skRuntime?: SpikeRuntime }).__skRuntime = rt; // dev page: lets a harness read measurements
    rt.mount();
    const id = setTimeout(() => setState("ready"), 0); // after mount, not inside the effect's own render
    return () => {
      clearTimeout(id);
      rt.unmount();
      runtimeRef.current = null;
    };
  }, [seg, font, hitmap, rig, base, mode]);

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
    a.download = `sk-s1-option${mode}-${Date.now()}.json`;
    a.click();
  };

  const isS = mode === "S";
  const aspect = isS ? "16 / 9" : "1 / 1";

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="card p-2">
        {!isS && <audio ref={audioRef} src={base + "audio.mp3"} preload="auto" />}
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
            {mode} · {state} · {(clockMs / 1000).toFixed(1)} s / {((seg?.audio.duration_ms ?? 0) / 1000).toFixed(1)} s
          </span>
        </div>
        <div className="relative w-full bg-white rounded overflow-hidden" style={{ aspectRatio: aspect, maxHeight: "80vh", margin: "0 auto" }}>
          {isS && <video ref={videoRef} src={base + "optionS.mp4"} preload="auto" playsInline className="absolute inset-0 w-full h-full" />}
          <div ref={hostRef} className="absolute inset-0 w-full h-full" data-testid="board" />
        </div>
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

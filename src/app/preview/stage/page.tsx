"use client";

import { useCallback, useRef, useState } from "react";
import { notFound } from "next/navigation";
import { Stage, type StageHandle, type StageMode } from "@/app/present/stage";

// The stage, on its own — DEV ONLY (notFound in production).
//
// This exists to check the one property the stage is built around: the <video>
// element is the SAME DOM NODE before and after a mode change. That is not
// something a unit test can assert and not something you can see by looking; it
// needs a reference held across the change and compared afterwards, which is
// what "Check identity" does.
//
// The clip is RECORDED HERE rather than fetched, so the freeze path — drawImage
// into a canvas, then toBlob — runs against real media on a same-origin blob
// URL. The cross-origin half is verified separately: the artifacts bucket sends
// `access-control-allow-origin: *`, and the element carries crossOrigin, which
// is what keeps the canvas untainted in production.

export default function StagePreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Harness />;
}

function Harness() {
  const stage = useRef<StageHandle | null>(null);
  const held = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [mode, setMode] = useState<StageMode>("full");
  const [log, setLog] = useState<string[]>([]);
  const say = useCallback((s: string) => setLog((l) => [s, ...l].slice(0, 8)), []);

  /** Record a few seconds of an animated canvas into a real, seekable clip. */
  const makeClip = useCallback(async () => {
    say("recording a clip…");
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const ctx = c.getContext("2d")!;
    const stream = c.captureStream(30);
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => {
      rec.onstop = () => res();
    });
    rec.start();
    // setInterval, NOT requestAnimationFrame. rAF does not run in a hidden or
    // non-compositing tab, so an rAF-driven recorder never reaches its stop
    // condition and the harness hangs with no clip and no error — which is
    // exactly what happened the first time this ran. A recorder does not need
    // frame sync anyway; it needs to draw at a steady rate and stop.
    const t0 = Date.now();
    await new Promise<void>((res) => {
      const timer = setInterval(() => {
        const k = (Date.now() - t0) / 1000;
        ctx.fillStyle = "#0C8175";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#fff";
        ctx.font = "48px system-ui, sans-serif";
        ctx.fillText(`t = ${k.toFixed(1)}s`, 40, 180);
        ctx.beginPath();
        ctx.arc(320 + Math.sin(k * 3) * 200, 300, 24, 0, Math.PI * 2);
        ctx.fill();
        if (k >= 3) {
          clearInterval(timer);
          rec.stop();
          res();
        }
      }, 33);
    });
    await done;
    const blob = new Blob(chunks, { type: chunks[0]?.type || "video/webm" });
    setSrc(URL.createObjectURL(blob));
    say(`clip ready — ${(blob.size / 1024).toFixed(0)} KB`);
  }, [say]);

  const hold = useCallback(() => {
    held.current = stage.current?.element() ?? null;
    say(held.current ? "holding a reference to the element" : "no element yet");
  }, [say]);

  const check = useCallback(() => {
    const now = stage.current?.element() ?? null;
    if (!held.current) {
      say("hold a reference first");
      return;
    }
    say(
      now === held.current
        ? `SAME element · currentTime ${stage.current?.currentTime().toFixed(2)}s — it never remounted`
        : "DIFFERENT element — the video remounted, which would reload it in class",
    );
  }, [say]);

  const doFreeze = useCallback(async () => {
    const f = await stage.current?.freeze();
    say(
      f
        ? `froze at ${f.t.toFixed(2)}s · ${f.width}×${f.height} · ${f.url.slice(0, 24)}…`
        : "nothing captured — tainted canvas or no frame",
    );
  }, [say]);

  const btn =
    "rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm text-[#C2CCC7]";

  return (
    <main className="min-h-dvh bg-[#0F1417] p-4 text-[#E7EDE9]">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#5F6F69]">
        Present mode · the stage
      </p>
      <h1 className="text-xl font-semibold tracking-tight">One element, for the whole lesson</h1>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={makeClip}>
          Make a clip
        </button>
        <button type="button" className={btn} onClick={() => void stage.current?.play()}>
          Play
        </button>
        <button type="button" className={btn} onClick={() => stage.current?.pause()}>
          Pause
        </button>
        {(["full", "corner", "away"] as StageMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-lg border px-3 py-2 text-sm ${
              mode === m
                ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                : "border-[#2A363B] bg-[#141B1F] text-[#C2CCC7]"
            }`}
          >
            {m}
          </button>
        ))}
        <button type="button" className={btn} onClick={doFreeze}>
          Freeze
        </button>
        <button type="button" className={btn} onClick={hold}>
          Hold reference
        </button>
        <button type="button" className={btn} onClick={check}>
          Check identity
        </button>
      </div>

      <ul className="mt-4 grid gap-1 font-mono text-[11px] text-[#93A09A]">
        {log.map((l, i) => (
          <li key={`${i}-${l}`}>{l}</li>
        ))}
      </ul>

      <Stage
        ref={stage}
        src={src}
        mode={mode}
        onTapToFreeze={doFreeze}
        onError={() => say("media error — this is where a re-sign would go")}
      />
    </main>
  );
}

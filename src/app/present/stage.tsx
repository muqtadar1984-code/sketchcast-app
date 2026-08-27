"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";

// The stage: one video element, for the whole lesson.
//
// THE ELEMENT IS MOUNTED ONCE AND NEVER MOVES. That is the architectural
// constraint of this file and the reason it exists as its own component. "The
// video never reloads or loses its place" is not polish — the moment a <video>
// is conditionally rendered into a different parent, React unmounts it and the
// video reloads from zero in front of thirty children. So the element is
// rendered UNCONDITIONALLY at one place in the tree, and only the style of its
// fixed-position container changes. There is no `{mode === "full" && <video/>}`
// anywhere here, and there must never be.
//
// FREEZE NEEDS CORS, AND CORS NEEDS THE ATTRIBUTE. Capturing a frame means
// drawImage(video) into a canvas, and a canvas that has drawn a cross-origin
// video is TAINTED: toBlob throws SecurityError. The artifacts bucket does send
// `access-control-allow-origin: *` (verified against a real signed URL), but the
// browser only makes it a CORS request if `crossOrigin` is on the element BEFORE
// it loads. Hence the attribute in the JSX rather than set later — assigning it
// after `src` has no effect.
//
// The capture is still wrapped: a bucket policy could change, and the failure
// must read as "the frame could not be captured" rather than as a board that
// silently stopped freezing.

export type StageMode = "full" | "corner" | "away";

export type FrozenFrame = { url: string; t: number; width: number; height: number };

export type StageHandle = {
  play: () => Promise<void>;
  pause: () => void;
  /** Pause and capture the current frame. Null when there is nothing to capture. */
  freeze: () => Promise<FrozenFrame | null>;
  seek: (t: number) => void;
  currentTime: () => number;
  duration: () => number;
  paused: () => boolean;
  /** The element itself, so a host can assert it is the same one it had before. */
  element: () => HTMLVideoElement | null;
};

export type StageProps = {
  /**
   * The signed URL. CHANGING THIS RELOADS THE VIDEO and loses its position, so a
   * host must treat it as fixed for the lesson and change it only to recover
   * from an expired URL — which the eight-hour TTL exists to make rare.
   */
  src: string | null;
  mode: StageMode;
  onEnded?: () => void;
  /** Fired when the media fails — the hook for re-signing an expired URL. */
  onError?: () => void;
  /** Tapping the video pauses and freezes it: the gesture a teacher already
   *  makes when she wants to write on what is on screen. */
  onTapToFreeze?: () => void;
};

/**
 * Where the element sits in each mode.
 *
 * `away` keeps it mounted, playable and positioned — just translated off-screen
 * with no opacity. `display: none` would be the obvious way to hide it and is
 * the wrong one: it drops the element from layout, and browsers are within
 * their rights to deprioritise or unload media that is not being displayed.
 * Nothing here may risk the video's position.
 */
function styleFor(mode: StageMode): CSSProperties {
  const base: CSSProperties = {
    position: "fixed",
    zIndex: 30,
    overflow: "hidden",
    borderRadius: 12,
    background: "#000",
    transition: "inset 260ms cubic-bezier(.22,.7,.3,1), width 260ms cubic-bezier(.22,.7,.3,1), height 260ms cubic-bezier(.22,.7,.3,1), opacity 200ms linear",
  };
  switch (mode) {
    case "full":
      return { ...base, inset: "56px 12px 12px 12px" };
    case "corner":
      return {
        ...base,
        insetInlineEnd: 16,
        insetBlockEnd: 16,
        insetBlockStart: "auto",
        insetInlineStart: "auto",
        width: "min(28vw, 360px)",
        height: "min(15.75vw, 202px)",
        boxShadow: "0 12px 32px -12px rgba(0,0,0,.7)",
      };
    default:
      return {
        ...base,
        insetInlineEnd: 16,
        insetBlockEnd: 16,
        insetBlockStart: "auto",
        insetInlineStart: "auto",
        width: "min(28vw, 360px)",
        height: "min(15.75vw, 202px)",
        opacity: 0,
        pointerEvents: "none",
        transform: "translateY(140%)",
      };
  }
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { src, mode, onEnded, onError, onTapToFreeze },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const freeze = useCallback(async (): Promise<FrozenFrame | null> => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    v.pause();
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.82));
      if (!blob) return null;
      return {
        url: URL.createObjectURL(blob),
        t: v.currentTime,
        width: c.width,
        height: c.height,
      };
    } catch {
      // Tainted canvas — the bucket stopped sending CORS, or crossOrigin was
      // lost. Say nothing was captured rather than pretend a frame was.
      return null;
    }
  }, []);

  useImperativeHandle(
    ref,
    (): StageHandle => ({
      play: async () => {
        // A rejected play() is normal — autoplay policy, or a pause landing in
        // the same tick — and must never surface as an unhandled rejection.
        await videoRef.current?.play().catch(() => {});
      },
      pause: () => videoRef.current?.pause(),
      freeze,
      seek: (t: number) => {
        const v = videoRef.current;
        if (v) v.currentTime = t;
      },
      currentTime: () => videoRef.current?.currentTime ?? 0,
      duration: () => videoRef.current?.duration ?? 0,
      paused: () => videoRef.current?.paused ?? true,
      element: () => videoRef.current,
    }),
    [freeze],
  );

  return (
    <div style={styleFor(mode)} data-stage-mode={mode}>
      {/*
        RENDERED UNCONDITIONALLY. Not behind `src &&`, not behind a mode check:
        a <video> that disappears from the tree when the src is briefly null, or
        when the stage is hidden, is a <video> that reloads when it comes back.
        An empty src is a video with nothing loaded, which is the correct
        representation of "no video chosen yet".
      */}
      <video
        ref={videoRef}
        // Must be present BEFORE the src loads, or the canvas is tainted and
        // freeze-frame is impossible. See the header.
        crossOrigin="anonymous"
        src={src ?? undefined}
        playsInline
        preload="metadata"
        controls={false}
        onEnded={onEnded}
        onError={src ? onError : undefined}
        onClick={onTapToFreeze}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      />
    </div>
  );
});

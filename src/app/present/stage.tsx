"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { VideoLike } from "./board-controller";
import { loadYouTubeApi, stagePlayerEvents, stageSource, youtubePlayerVars, YouTubeVideo, type YTPlayerLike } from "./youtube-video";

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
//
// THE STORED MP4 FIRST, YOUTUBE ONLY AS THE FALLBACK (founder 2026-10-30:
// "the quality matters in the app so lets use stored mp4 wherever possible").
// The host passes `src` whenever the lesson has a stored file, and `youtubeId`
// only for a lesson that has none; even given both, stageSource plays the
// file. On the fallback the stage mounts a YouTube IFrame player in a host
// <div> that, like the <video>, is rendered unconditionally and only
// restyled; the player is built once per id and torn down when the id
// changes. Every handle method drives whichever source is live, and element()
// hands the controller the YouTube adapter (youtube-video.ts) behind the same
// VideoLike interface. YouTube's pixels are cross-origin, so freeze() on a
// YouTube lesson pauses and returns null ("could not capture the frame"); on
// the stored file freeze-frame and the slide stills work. Captions start OFF
// on the fallback (captionsOff on ready and whenever the player loads a
// module).

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
  /** What the controller drives: the <video> element itself (so a host can
   *  assert it is the same one it had before), or the YouTube adapter. */
  element: () => VideoLike | null;
};

export type StageProps = {
  /**
   * The signed URL. CHANGING THIS RELOADS THE VIDEO and loses its position, so a
   * host must treat it as fixed for the lesson and change it only to recover
   * from an expired URL — which the eight-hour TTL exists to make rare.
   */
  src: string | null;
  /**
   * A YouTube video id, the FALLBACK: played through the IFrame Player API only
   * when `src` is empty (a lesson with no stored MP4). Like `src`, CHANGING IT
   * RELOADS the player.
   */
  youtubeId?: string | null;
  mode: StageMode;
  onEnded?: () => void;
  /** Fired when the media fails — the hook for re-signing an expired URL. */
  onError?: () => void;
  /** Tapping the video pauses and freezes it: the gesture a teacher already
   *  makes when she wants to write on what is on screen. */
  onTapToFreeze?: () => void;
  /** A short status over the video ("Moving…" while SK seeks). Null shows nothing. */
  status?: string | null;
};

/**
 * Where the element sits in each mode.
 *
 * `away` keeps it mounted, playable and positioned — just translated off-screen
 * with no opacity. `display: none` would be the obvious way to hide it and is
 * the wrong one: it drops the element from layout, and browsers are within
 * their rights to deprioritise or unload media that is not being displayed.
 * Nothing here may risk the video's position.
 *
 * ON A PHONE (below 640px) a 28vw corner video is a thumbnail — about 109px —
 * so "corner" becomes a full-width 16:9 strip pinned to the TOP, and the page
 * below starts under it (globals.css pads the body by the same 56.25vw while a
 * corner stage is mounted) and scrolls beneath it: video on top, the roll
 * below. "away" leaves upward from the same place. Only the container's style
 * changes, exactly as on a desktop; the element never moves.
 */
function styleFor(mode: StageMode, phone: boolean): CSSProperties {
  const base: CSSProperties = {
    position: "fixed",
    zIndex: 30,
    overflow: "hidden",
    borderRadius: 12,
    background: "#000",
    transition: "inset 260ms cubic-bezier(.22,.7,.3,1), width 260ms cubic-bezier(.22,.7,.3,1), height 260ms cubic-bezier(.22,.7,.3,1), opacity 200ms linear",
  };
  if (phone && mode !== "full") {
    const strip: CSSProperties = {
      ...base,
      borderRadius: 0,
      insetInlineStart: 0,
      insetInlineEnd: 0,
      insetBlockStart: "env(safe-area-inset-top, 0px)",
      insetBlockEnd: "auto",
      width: "100%",
      height: "56.25vw",
      boxShadow: "0 10px 24px -14px rgba(0,0,0,.8)",
    };
    return mode === "corner" ? strip : { ...strip, opacity: 0, pointerEvents: "none", transform: "translateY(-140%)" };
  }
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

/** Below Tailwind's `sm` — the same line globals.css draws its phone rules on.
 *  False on the server and on the first paint, so the desktop corner is what
 *  hydrates; a phone restyles one frame later (the element stays put). */
const PHONE_QUERY = "(max-width: 639px)";
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { src, youtubeId = null, mode, onEnded, onError, onTapToFreeze, status },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const source = stageSource(src, youtubeId);
  const ytHost = useRef<HTMLDivElement | null>(null);
  const yt = useRef<YouTubeVideo | null>(null);
  // the latest callbacks, read by the player's events without rebuilding it
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onEndedRef.current = onEnded;
    onErrorRef.current = onError;
  });

  // ONE YouTube player per id. The IFrame API replaces the mount <div> it is
  // given with its iframe, so the mount is created here, inside the host React
  // renders (and never reconciles the children of).
  const ytId = source === "youtube" ? youtubeId : null;
  useEffect(() => {
    const host = ytHost.current;
    if (!ytId || !host) return;
    const mount = document.createElement("div");
    mount.style.width = "100%";
    mount.style.height = "100%";
    host.appendChild(mount);
    const video = new YouTubeVideo();
    video.addEventListener("ended", () => onEndedRef.current?.());
    video.addEventListener("error", () => onErrorRef.current?.());
    yt.current = video;
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        const player: YTPlayerLike = new YT.Player(mount, {
          videoId: ytId,
          width: "100%",
          height: "100%",
          playerVars: youtubePlayerVars(window.location.origin),
          // captions off on ready (and whenever a module loads), then the
          // player is handed to the adapter — youtube-video.ts
          events: stagePlayerEvents(video, () => player),
        });
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current?.();
      });
    return () => {
      cancelled = true;
      video.destroy();
      if (yt.current === video) yt.current = null;
      host.replaceChildren();
    };
  }, [ytId]);

  const freeze = useCallback(async (): Promise<FrozenFrame | null> => {
    if (yt.current) {
      // a cross-origin iframe: its frame can never be captured
      yt.current.pause();
      return null;
    }
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
        if (yt.current) return yt.current.play();
        // A rejected play() is normal — autoplay policy, or a pause landing in
        // the same tick — and must never surface as an unhandled rejection.
        await videoRef.current?.play().catch(() => {});
      },
      pause: () => (yt.current ? yt.current.pause() : videoRef.current?.pause()),
      freeze,
      seek: (t: number) => {
        const v: VideoLike | null = yt.current ?? videoRef.current;
        if (v) v.currentTime = t;
      },
      currentTime: () => (yt.current ? yt.current.currentTime : (videoRef.current?.currentTime ?? 0)),
      duration: () => (yt.current ? yt.current.duration || 0 : (videoRef.current?.duration ?? 0)),
      paused: () => (yt.current ? yt.current.paused : (videoRef.current?.paused ?? true)),
      element: () => yt.current ?? videoRef.current,
    }),
    [freeze],
  );

  const phone = usePhoneWidth();
  return (
    <div style={styleFor(mode, phone)} data-stage-mode={mode}>
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
        src={source === "file" ? (src ?? undefined) : undefined}
        playsInline
        preload="metadata"
        controls={false}
        onEnded={onEnded}
        onError={source === "file" ? onError : undefined}
        onClick={onTapToFreeze}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      />
      {/* The YouTube host: rendered unconditionally like the <video>, shown
          only while a YouTube lesson is the source. Its child is the API's. */}
      <div
        ref={ytHost}
        data-stage-youtube={source === "youtube" ? (youtubeId ?? "") : undefined}
        style={{ position: "absolute", inset: 0, background: "#000", display: source === "youtube" ? "block" : "none" }}
      />
      {status && (
        <span
          role="status"
          className="pointer-events-none absolute end-2 top-2 rounded-lg bg-[#141B1F] px-2 py-1 font-mono text-[11px] text-[#4FD6C2]"
        >
          {status}
        </span>
      )}
    </div>
  );
});

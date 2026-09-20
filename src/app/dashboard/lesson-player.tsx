"use client";

import { useEffect, useState } from "react";

// The in-app lesson player for ADULT surfaces (the Library's content cells and
// lesson cards). Students have their own player inside student-item.tsx — it
// carries the one-part-a-day progress logic and stays separate.
//
// WHY THIS EXISTS (2026-09-20). "Watch" used to open the signed MP4 URL in a
// new tab, where the browser's own player renders a Download button in its
// menu, and right-click offers "Save video as". A lesson is the product; the
// signed URL is a playback token, not a handout. So playback happens here, on
// a <video> that (a) asks the browser to hide its download control
// (controlsList="nodownload"), (b) refuses the context menu, and (c) keeps the
// picture-in-picture and remote-playback affordances off, because each of
// those is another surface that exposes the raw URL. None of this is DRM — a
// determined person can still fetch a signed URL while it is valid — it
// removes the two-click routes that every teacher and student would otherwise
// find by accident.
//
// The founder-only "Save" link (utils/video-download.ts) is untouched: it
// signs a SEPARATE download-dispositioned URL for the allow-list.

export function LessonPlayer({
  src,
  title,
  closeLabel,
  onClose,
}: {
  src: string;
  /** Shown under the video; a composed part label can mix scripts, hence <bdi>. */
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <video
          src={src}
          controls
          autoPlay
          playsInline
          controlsList="nodownload"
          disablePictureInPicture
          disableRemotePlayback
          onContextMenu={(e) => e.preventDefault()}
          className="w-full rounded-lg bg-black"
        />
        <div className="flex items-center justify-between gap-3 mt-2">
          <p className="text-xs text-white/70 truncate"><bdi>{title}</bdi></p>
          <button type="button" onClick={onClose} className="shrink-0 text-xs text-white/90 hover:underline">
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A "Watch" control that opens the player instead of navigating. Renders a
 *  <button> styled by the caller so it sits exactly where the old <a> did;
 *  `onOpen` is where view tracking goes (it fires once per click, as the
 *  anchor's onClick did). */
export function WatchLink({
  src,
  title,
  closeLabel,
  onOpen,
  className,
  hint,
  children,
}: {
  src: string;
  title: string;
  closeLabel: string;
  onOpen?: () => void;
  className?: string;
  /** Hover title, where the old anchor had one. */
  hint?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        className={className}
        title={hint}
      >
        {children}
      </button>
      {open && <LessonPlayer src={src} title={title} closeLabel={closeLabel} onClose={() => setOpen(false)} />}
    </>
  );
}

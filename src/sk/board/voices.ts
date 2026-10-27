// SK — which narration track a segment plays (founder, 2026-10-27: the
// tutor's look and voice must agree; default look B = the man).
//
// The packager renders a chapter's clips against ONE voice (female, Aria) and
// adds a second, ALIGNED track in the other gender: same video stream, the
// other voice muxed in, its word marks remapped onto the clip's timeline
// (worker `sk/voices.py`). A segment then carries `voices`, keyed by gender,
// each entry a complete track (clip + audio + marks). The runtime never sees
// the map: `segmentForVoice` hands it a plain Segment whose clip/audio/marks
// are the chosen track's, so the clock, drift and pause code are untouched.
// Pure; no DOM.

import type { Marks, Segment, VoiceGender, VoiceTrack } from "./engine";

export type TrackChoice = {
  /** The gender of the track that plays. */
  gender: VoiceGender;
  /** True when the segment had a track for the look; false when it fell back. */
  exact: boolean;
  track: VoiceTrack;
};

const trackOf = (seg: Segment): VoiceTrack => ({ voice: undefined, audio: seg.audio, clip: seg.clip, marks: seg.marks });

/** The track for `want`: the segment's `voices[want]`, else its own (rendered)
 * narration, whatever gender that is. A segment with no `voices` is its own
 * single track (old graphs keep playing). */
export function trackFor(seg: Segment, want: VoiceGender): TrackChoice {
  const v = seg.voices?.[want];
  if (v) return { gender: want, exact: true, track: v };
  const own = seg.voice_gender ?? "female";
  // `voices` may spell the rendered track out too; prefer it (it carries the voice id).
  const ownEntry = seg.voices?.[own];
  return { gender: own, exact: own === want, track: ownEntry ?? trackOf(seg) };
}

/** `seg` with the chosen track's clip, audio and marks in place of its own
 * (plus `voice_gender` set to what actually plays). Returns `seg` itself
 * when nothing would change, so callers can compare by identity. */
export function segmentForVoice(seg: Segment, want: VoiceGender): Segment {
  const { gender, track } = trackFor(seg, want);
  const marks: Marks = track.marks ?? seg.marks;
  const clip = track.clip ?? seg.clip;
  if (gender === (seg.voice_gender ?? "female") && marks === seg.marks && clip === seg.clip && track.audio === seg.audio) return seg;
  return { ...seg, voice_gender: gender, audio: track.audio, clip, marks };
}

/** The genders a segment can speak in (its own first). */
export function availableGenders(seg: Segment): VoiceGender[] {
  const own = seg.voice_gender ?? "female";
  const out: VoiceGender[] = [own];
  for (const g of ["female", "male"] as const) if (g !== own && seg.voices?.[g]) out.push(g);
  return out;
}

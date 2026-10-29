// Microphone float samples → 16 kHz mono PCM16 (PURE). Transcribe's
// media-encoding=pcm wants signed 16-bit little-endian samples at the
// sample-rate the URL names (16000).
//
// The SAME arithmetic runs inside the AudioWorklet
// (public/worklets/pcm16-worklet.js — a worklet cannot import a bundle); the
// test suite loads that file and checks it produces exactly what this module
// does, so the two cannot drift.
//
// Method: a box filter. Output sample j covers input samples i with
// j·r ≤ i < (j+1)·r (r = inRate / outRate, any real ≥ 1) and is their mean —
// cheap anti-aliasing that is plenty for speech recognition. The position is
// carried across chunks, so a 44.1 kHz stream (r = 2.75625) does not drift.

export const PCM_TARGET_RATE = 16000;

/** One float sample in [-1, 1] → int16 (clamped, asymmetric range, rounded). */
export function floatToInt16(s: number): number {
  const c = s > 1 ? 1 : s < -1 ? -1 : Number.isNaN(s) ? 0 : s;
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
}

export type Downsampler = {
  /** Feed float samples; returns the int16 samples completed by them. */
  push(input: Float32Array): Int16Array;
};

export function createDownsampler(inRate: number, outRate: number = PCM_TARGET_RATE): Downsampler {
  if (!(inRate > 0) || !(outRate > 0)) throw new Error("pcm16: bad sample rate");
  const ratio = inRate / outRate;
  let j = 0; // next output sample index (global)
  let base = 0; // global index of rest[0]
  let rest = new Float32Array(0);
  return {
    push(input) {
      const data = new Float32Array(rest.length + input.length);
      data.set(rest);
      data.set(input, rest.length);
      const end = base + data.length;
      const out: number[] = [];
      for (;;) {
        const from = Math.ceil(j * ratio);
        let to = Math.ceil((j + 1) * ratio); // exclusive
        if (to > end) break;
        if (to <= from) to = from + 1; // upsampling: hold the nearest sample
        if (to > end) break;
        let sum = 0;
        for (let i = from; i < to; i++) sum += data[i - base]!;
        out.push(floatToInt16(sum / (to - from)));
        j++;
      }
      const keepFrom = Math.min(Math.ceil(j * ratio), end);
      rest = data.slice(keepFrom - base);
      base = keepFrom;
      return Int16Array.from(out);
    },
  };
}

/** Stateless convenience: one buffer in, one buffer out. */
export function downsampleToPcm16(input: Float32Array, inRate: number, outRate: number = PCM_TARGET_RATE): Int16Array {
  return createDownsampler(inRate, outRate).push(input);
}

/** Int16 samples → little-endian bytes (what goes in the AudioEvent payload). */
export function pcm16Bytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i]!, true);
  return out;
}

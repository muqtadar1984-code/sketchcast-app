// SK S6 slice B — microphone → 16 kHz mono PCM16, inside the AudioWorklet.
// Loaded by src/utils/assistant/transcribe-client.ts with
// audioWorklet.addModule("/worklets/pcm16-worklet.js").
//
// The downsampling is the SAME box filter as src/utils/assistant/pcm16.ts
// (createDownsampler + floatToInt16); src/utils/__tests__/transcribe.test.ts
// runs this file in a sandbox and checks the two agree sample for sample.
// Change one, change both.
//
// Posts an Int16Array (transferred) every ~100 ms of 16 kHz audio. Never
// touches the network: the main thread frames and sends.

/* global sampleRate, registerProcessor, AudioWorkletProcessor */

function floatToInt16(s) {
  const c = s > 1 ? 1 : s < -1 ? -1 : Number.isNaN(s) ? 0 : s;
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
}

class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.outRate = o.targetRate || 16000;
    this.ratio = sampleRate / this.outRate;
    this.batch = o.batchSamples || 1600;
    this.j = 0; // next output sample (global index)
    this.base = 0; // global index of rest[0]
    this.rest = new Float32Array(0);
    this.out = new Int16Array(this.batch);
    this.n = 0;
  }

  push(input) {
    const data = new Float32Array(this.rest.length + input.length);
    data.set(this.rest);
    data.set(input, this.rest.length);
    const end = this.base + data.length;
    for (;;) {
      const from = Math.ceil(this.j * this.ratio);
      let to = Math.ceil((this.j + 1) * this.ratio);
      if (to > end) break;
      if (to <= from) to = from + 1;
      if (to > end) break;
      let sum = 0;
      for (let i = from; i < to; i++) sum += data[i - this.base];
      this.out[this.n++] = floatToInt16(sum / (to - from));
      this.j++;
      if (this.n === this.batch) {
        this.port.postMessage(this.out, [this.out.buffer]);
        this.out = new Int16Array(this.batch);
        this.n = 0;
      }
    }
    const keepFrom = Math.min(Math.ceil(this.j * this.ratio), end);
    this.rest = data.slice(keepFrom - this.base);
    this.base = keepFrom;
  }

  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length && chans[0] && chans[0].length) {
      let mono = chans[0];
      if (chans.length > 1) {
        mono = new Float32Array(chans[0].length);
        for (let c = 0; c < chans.length; c++) for (let i = 0; i < mono.length; i++) mono[i] += chans[c][i] / chans.length;
      }
      this.push(mono);
    }
    return true;
  }
}

registerProcessor("sk-pcm16-capture", Pcm16Capture);

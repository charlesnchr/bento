// The browser's microphone and speaker for a call: 16 kHz PCM16 frames out of the microphone,
// 24 kHz PCM16 into the speaker, and tones laid over whatever plays. Both run in AudioWorklets on
// one AudioContext at the device's rate, resampling there.

const WORKLETS = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.frame = new Int16Array(320);
    this.n = 0;
    // A windowed-sinc low-pass at 7 kHz, so nothing above 16 kHz's 8 kHz limit folds back into speech.
    const taps = 47, cut = 7000 / sampleRate;
    this.taps = new Float32Array(taps);
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const m = k - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
      this.taps[k] = sinc * w;
      sum += this.taps[k];
    }
    for (let k = 0; k < taps; k++) this.taps[k] /= sum;
    this.history = new Float32Array(taps);
    this.at = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const taps = this.taps, h = this.history, n = taps.length;
    for (let i = 0; i < input.length; i++) {
      h[this.at] = input[i];
      this.at = (this.at + 1) % n;
      // Only the samples kept need filtering: at most one in every step.
      if (this.pos > 1) { this.pos -= 1; continue; }
      let x = 0;
      for (let k = 0, j = this.at; k < n; k++, j = j + 1 === n ? 0 : j + 1) x += taps[k] * h[j];
      while (this.pos <= 1) {
        const s = Math.max(-1, Math.min(1, x));
        this.frame[this.n++] = s < 0 ? s * 32768 : s * 32767;
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.n = 0;
        }
        this.pos += this.step;
      }
      this.pos -= 1;
    }
    return true;
  }
}

class Playback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];      // Float32Arrays at the context's rate
    this.offset = 0;
    this.cues = [];
    this.cueOffset = 0;
    this.reported = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "play") this.queue.push(m.samples);
      else if (m.type === "cue") this.cues.push(m.samples);
      else if (m.type === "flush") { this.queue = []; this.offset = 0; }
      else if (m.type === "stop") { this.queue = []; this.offset = 0; this.cues = []; this.cueOffset = 0; }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    for (let i = 0; i < out.length && this.queue.length; i++) {
      out[i] = this.queue[0][this.offset++];
      if (this.offset >= this.queue[0].length) { this.queue.shift(); this.offset = 0; }
    }
    for (let i = 0; i < out.length && this.cues.length; i++) {
      out[i] = Math.max(-1, Math.min(1, out[i] + this.cues[0][this.cueOffset++]));
      if (this.cueOffset >= this.cues[0].length) { this.cues.shift(); this.cueOffset = 0; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (currentTime - this.reported > 0.1) {
      this.reported = currentTime;
      let queued = -this.offset;
      for (const q of this.queue) queued += q.length;
      this.port.postMessage({ queued: queued / sampleRate });
    }
    return true;
  }
}
registerProcessor("capture", Capture);
registerProcessor("playback", Playback);
`;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** PCM16 little-endian at [rate], as floats at the context's rate. */
function toFloats(pcm: Uint8Array, rate: number, target: number): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(Math.floor((n * target) / rate));
  const step = rate / target;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = view.getInt16(2 * Math.min(j, n - 1), true);
    const b = view.getInt16(2 * Math.min(j + 1, n - 1), true);
    out[i] = (a + (b - a) * (x - j)) / 32768;
  }
  return out;
}

export interface MicOptions { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }

export class CallAudio {
  private context: AudioContext | null = null;
  private playback: AudioWorkletNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private micOpts: MicOptions | null = null;
  private onMicFrame: ((samples: Int16Array, level: number) => void) | null = null;
  /** Incremented on every startMic/stopMic so superseded or cancelled getUserMedia calls never leak tracks. */
  private micGen = 0;
  private opening: Promise<void> | null = null;
  private stateListener: (() => void) | null = null;
  /** Seconds of speech queued, as the worklet last said. */
  queued = 0;
  /** The microphone's level, RMS of the last frame (0 to 1). */
  level = 0;

  onAudioStateChange(listener: (() => void) | null): void {
    this.stateListener = listener;
  }

  /** True when an AudioContext exists but the browser suspended it pending a user gesture. */
  get audioSuspended(): boolean {
    return this.context != null && this.context.state !== "running";
  }

  async resumeAudio(): Promise<boolean> {
    const ctx = this.context;
    if (!ctx) return false;
    if (ctx.state === "running") return true;
    try { await ctx.resume(); } catch {}
    return (ctx.state as AudioContextState) === "running";
  }

  async open(): Promise<void> {
    if (this.opening) {
      await this.opening;
      if (this.context?.state === "suspended") await this.context.resume().catch(() => {});
      return;
    }
    if (this.context) { if (this.context.state === "suspended") await this.context.resume().catch(() => {}); return; }
    const init = (async () => {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      ctx.onstatechange = () => this.stateListener?.();
      try {
        const url = URL.createObjectURL(new Blob([WORKLETS], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        const playback = new AudioWorkletNode(ctx, "playback", { numberOfInputs: 0, outputChannelCount: [2] });
        playback.port.onmessage = (e) => { this.queued = e.data.queued; };
        playback.connect(ctx.destination);
        this.context = ctx;
        this.playback = playback;
        this.stateListener?.();
      } catch (err) {
        try { await ctx.close?.(); } catch {}
        throw err;
      } finally {
        this.opening = null;
      }
    })();
    this.opening = init;
    await init;
  }

  /** Seconds from a sample leaving the worklet to the speaker, as the browser reckons it. */
  get outputLatency(): number | null {
    if (!this.context) return null;
    return this.context.baseLatency + ((this.context as AudioContext & { outputLatency?: number }).outputLatency ?? 0);
  }

  get micActive(): boolean {
    return this.capture != null && this.stream != null && this.stream.getTracks().some((t) => t.readyState === "live");
  }

  /** Starts the microphone if it isn't already running with the same options; otherwise swaps the frame callback cleanly. */
  async ensureMic(onFrame: (samples: Int16Array, level: number) => void, options: MicOptions): Promise<void> {
    if (
      this.micActive &&
      this.micOpts &&
      this.micOpts.echoCancellation === options.echoCancellation &&
      this.micOpts.noiseSuppression === options.noiseSuppression &&
      this.micOpts.autoGainControl === options.autoGainControl
    ) {
      await this.open();
      this.onMicFrame = onFrame;
      return;
    }
    await this.startMic(onFrame, options);
  }

  async startMic(onFrame: (samples: Int16Array, level: number) => void, options: MicOptions): Promise<void> {
    this.stopMic();
    const gen = ++this.micGen;
    await this.open();
    if (gen !== this.micGen) return;
    const context = this.context!;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, ...options } });
    if (gen !== this.micGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    let source: MediaStreamAudioSourceNode | null = null;
    let capture: AudioWorkletNode | null = null;
    try {
      source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, "capture", { numberOfOutputs: 0 });
      capture.port.onmessage = (e) => {
        const frame = new Int16Array(e.data as ArrayBuffer);
        let sum = 0;
        for (const s of frame) sum += s * s;
        this.level = Math.sqrt(sum / frame.length) / 32768;
        this.onMicFrame?.(frame, this.level);
      };
      source.connect(capture);
    } catch (err) {
      source?.disconnect();
      capture?.port.close();
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    this.stream = stream;
    this.micOpts = { ...options };
    this.onMicFrame = onFrame;
    this.source = source;
    this.capture = capture;
  }

  stopMic(): void {
    this.micGen++;
    this.source?.disconnect();
    this.capture?.port.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.capture = null;
    this.stream = null;
    this.micOpts = null;
    this.onMicFrame = null;
    this.level = 0;
  }

  play(pcm64: string): void {
    if (!this.context || !this.playback) return;
    const samples = toFloats(base64ToBytes(pcm64), 24000, this.context.sampleRate);
    this.playback.port.postMessage({ type: "play", samples }, [samples.buffer]);
  }

  cue(pcm64: string): void {
    if (!this.context || !this.playback) return;
    const samples = toFloats(base64ToBytes(pcm64), 24000, this.context.sampleRate);
    this.playback.port.postMessage({ type: "cue", samples }, [samples.buffer]);
  }

  flush(): void {
    this.playback?.port.postMessage({ type: "flush" });
  }

  stopPlayback(): void {
    this.playback?.port.postMessage({ type: "stop" });
    this.queued = 0;
  }

  stop(): void {
    this.stopMic();
    this.stopPlayback();
  }
}

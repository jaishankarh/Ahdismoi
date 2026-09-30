// One shared microphone capture for the whole app: 16 kHz mono PCM16 in 512-sample frames
// (32 ms, the frame size Porcupine uses). The wake-word engine and the Gemini voice client both
// subscribe, so handing off from "wake word heard" to "talking to the model" loses no audio.
// Each frame carries its absolute sample index so a ring buffer can replay exact ranges.

export const MIC_RATE = 16000;
export const FRAME_SAMPLES = 512;

export type MicFrame = { samples: Int16Array; index: number };
type Listener = (frame: MicFrame) => void;

const CAPTURE_WORKLET = `
class RickyCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("ricky-capture", RickyCapture);
`;

class MicCapture {
  private listeners = new Set<Listener>();
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private starting: Promise<void> | null = null;
  private frame = new Int16Array(FRAME_SAMPLES);
  private frameLength = 0;
  private carry = 0;
  private sampleIndex = 0;

  /** Subscribe to frames; starts the mic on first subscriber. Returns an unsubscribe function. */
  async subscribe(listener: Listener): Promise<() => void> {
    this.listeners.add(listener);
    try {
      await this.ensureStarted();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Absolute index of the next sample to be captured. */
  get position(): number {
    return this.sampleIndex;
  }

  private ensureStarted(): Promise<void> {
    if (this.context) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const context = new AudioContext();
    const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    await context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "ricky-capture");
    const sink = context.createGain();
    sink.gain.value = 0; // keeps the graph running without echoing the mic
    source.connect(worklet).connect(sink).connect(context.destination);
    const ratio = context.sampleRate / MIC_RATE;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.push(event.data, ratio);
    if (context.state === "suspended") await context.resume();
    this.stream = stream;
    this.context = context;
    // If everyone unsubscribed while we were starting, shut down again.
    if (this.listeners.size === 0) this.stop();
  }

  private push(input: Float32Array, ratio: number): void {
    let position = this.carry;
    while (position < input.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = input[index];
      const b = index + 1 < input.length ? input[index + 1] : a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.frame[this.frameLength++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.frameLength === FRAME_SAMPLES) {
        const frame: MicFrame = { samples: this.frame, index: this.sampleIndex };
        this.sampleIndex += FRAME_SAMPLES;
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.frameLength = 0;
        for (const listener of this.listeners) listener(frame);
      }
      position += ratio;
    }
    this.carry = position - input.length;
  }

  private stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.frameLength = 0;
    this.carry = 0;
  }
}

export const mic = new MicCapture();

/** Fixed-size history of recent mic audio, addressable by absolute sample index. */
export class AudioRing {
  private buffer: Int16Array;
  private end = 0; // absolute index one past the newest stored sample

  constructor(seconds: number) {
    this.buffer = new Int16Array(Math.round(seconds * MIC_RATE));
  }

  push(frame: MicFrame): void {
    const size = this.buffer.length;
    for (let i = 0; i < frame.samples.length; i += 1) {
      this.buffer[(frame.index + i) % size] = frame.samples[i];
    }
    this.end = frame.index + frame.samples.length;
  }

  /** Samples from `from` (absolute) up to the newest sample, clamped to what is still stored. */
  since(from: number): Int16Array {
    const size = this.buffer.length;
    const start = Math.max(from, this.end - size, 0);
    const out = new Int16Array(Math.max(0, this.end - start));
    for (let i = 0; i < out.length; i += 1) out[i] = this.buffer[(start + i) % size];
    return out;
  }

  get newest(): number {
    return this.end;
  }
}

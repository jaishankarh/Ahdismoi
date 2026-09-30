// Always-on, on-device wake-word listener. Nothing leaves the computer until the wake word is heard.
// Engines:
//  - Vosk (offline speech recognizer, constrained to the wake phrase with a grammar). Free, no account.
//  - Picovoice Porcupine (dedicated wake-word engine). Needs a free AccessKey + a trained .ppn file.
// On detection it reports the absolute mic sample index where the user's command starts, so the
// caller can replay everything said after the wake word to the voice model.

import { AudioRing, FRAME_SAMPLES, mic, MIC_RATE, type MicFrame } from "../audio/mic";

export type WakeEngineId = "vosk" | "porcupine";
export type WakeDetection = { commandStart: number; engine: WakeEngineId; heard?: string };
export type WakeProgress = { phase: "downloading" | "preparing" | "loading"; received?: number; total?: number };

export type WakeListenerOptions = {
  engine: WakeEngineId;
  phrase: string;
  sensitivity: number; // 0..1
  onDetect: (detection: WakeDetection) => void;
  onProgress?: (progress: WakeProgress) => void;
  onError?: (message: string) => void;
};

interface Engine {
  feed(frame: MicFrame): void;
  reset(nextIndex: number): void;
  release(): Promise<void> | void;
}

export class WakeListener {
  private ring = new AudioRing(15);
  private engine: Engine | null = null;
  private unsubscribe: (() => void) | null = null;
  private active = true;
  private offProgress: (() => void) | null = null;

  constructor(private options: WakeListenerOptions) {}

  async start(): Promise<void> {
    this.offProgress = window.ricky.onWakeProgress((progress) => this.options.onProgress?.(progress as WakeProgress));
    try {
      this.engine =
        this.options.engine === "porcupine" ? await createPorcupine(this.options, (d) => this.detected(d)) : await createVosk(this.options, (d) => this.detected(d));
      this.unsubscribe = await mic.subscribe((frame) => {
        this.ring.push(frame);
        if (this.active) this.engine?.feed(frame);
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Pause detection while a conversation is running; resume when going back to sleep. */
  setActive(active: boolean): void {
    if (active && !this.active) this.engine?.reset(mic.position);
    this.active = active;
  }

  /** Audio captured from `from` (absolute sample index) until now. */
  audioSince(from: number): Int16Array {
    return this.ring.since(from);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.offProgress?.();
    this.offProgress = null;
    await this.engine?.release();
    this.engine = null;
  }

  private detected(detection: WakeDetection): void {
    if (!this.active) return;
    this.active = false;
    this.options.onDetect(detection);
  }
}

// ---------------- Vosk ----------------

type VoskResult = { result?: Array<{ word: string; conf: number; start: number; end: number }>; text?: string };

async function createVosk(options: WakeListenerOptions, onDetect: (d: WakeDetection) => void): Promise<Engine> {
  const { modelUrl } = await window.ricky.prepareVoskModel();
  options.onProgress?.({ phase: "loading" });
  const Vosk = await import("vosk-browser");
  const model = await Vosk.createModel(modelUrl, -1);
  const phraseWords = options.phrase.split(" ").filter(Boolean);
  const grammar = JSON.stringify([options.phrase, "[unk]"]);
  // Lower sensitivity => higher confidence required.
  const minConfidence = 0.95 - 0.5 * options.sensitivity;

  type Recognizer = InstanceType<typeof model.KaldiRecognizer>;
  let recognizer: Recognizer;
  let baseIndex = 0;
  let started = false;
  let batch = new Float32Array(FRAME_SAMPLES * 3);
  let batchLength = 0;

  const makeRecognizer = () => {
    const next = new model.KaldiRecognizer(MIC_RATE, grammar);
    next.setWords(true);
    next.on("result", (message) => {
      if (message.event !== "result") return;
      const result = message.result as VoskResult;
      const words = result.result || [];
      const match = findPhrase(words, phraseWords);
      if (!match) return;
      const confidence = match.reduce((sum, word) => sum + word.conf, 0) / match.length;
      if (confidence < minConfidence) return;
      const end = match[match.length - 1].end;
      onDetect({ engine: "vosk", commandStart: baseIndex + Math.round(end * MIC_RATE), heard: `${result.text} (${confidence.toFixed(2)})` });
    });
    next.on("error", (message) => {
      if (message.event === "error") options.onError?.(message.error);
    });
    return next;
  };
  recognizer = makeRecognizer();

  return {
    feed(frame) {
      if (!started) {
        baseIndex = frame.index;
        started = true;
      }
      for (let i = 0; i < frame.samples.length; i += 1) batch[batchLength++] = frame.samples[i] / 0x8000;
      if (batchLength >= batch.length) {
        recognizer.acceptWaveformFloat(batch, MIC_RATE);
        batch = new Float32Array(FRAME_SAMPLES * 3);
        batchLength = 0;
      }
    },
    reset(nextIndex) {
      try {
        recognizer.remove();
      } catch {
        // already gone
      }
      recognizer = makeRecognizer();
      baseIndex = nextIndex;
      started = false;
      batchLength = 0;
    },
    release() {
      try {
        recognizer.remove();
      } catch {
        // ignore
      }
      model.terminate();
    },
  };
}

function findPhrase<T extends { word: string }>(words: T[], phrase: string[]): T[] | null {
  for (let i = 0; i + phrase.length <= words.length; i += 1) {
    if (phrase.every((word, j) => normalizeWord(words[i + j].word) === normalizeWord(word))) return words.slice(i, i + phrase.length);
  }
  return null;
}

function normalizeWord(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ---------------- Porcupine ----------------

async function createPorcupine(options: WakeListenerOptions, onDetect: (d: WakeDetection) => void): Promise<Engine> {
  const assets = await window.ricky.porcupineAssets();
  options.onProgress?.({ phase: "loading" });
  const { Porcupine } = await import("@picovoice/porcupine-web");
  let lastFrameEnd = 0;
  const porcupine = await Porcupine.create(
    assets.accessKey,
    [{ label: "wake", base64: assets.keywordBase64, sensitivity: options.sensitivity }],
    () => onDetect({ engine: "porcupine", commandStart: lastFrameEnd }),
    { base64: assets.modelBase64, customWritePath: `ricky_porcupine_${assets.modelVersion}`, version: 1, forceWrite: true },
    { processErrorCallback: (error) => options.onError?.(error.message) },
  );
  if (porcupine.frameLength !== FRAME_SAMPLES || porcupine.sampleRate !== MIC_RATE) {
    await porcupine.release();
    throw new Error(`Porcupine expects ${porcupine.frameLength}-sample frames at ${porcupine.sampleRate} Hz; this build captures ${FRAME_SAMPLES} at ${MIC_RATE}.`);
  }
  let queue = Promise.resolve();
  return {
    feed(frame) {
      const samples = frame.samples;
      const end = frame.index + samples.length;
      // Porcupine.process is async; keep frames in order.
      queue = queue.then(async () => {
        lastFrameEnd = end;
        await porcupine.process(samples);
      }).catch((error) => options.onError?.(error instanceof Error ? error.message : String(error)));
    },
    reset() {
      // Porcupine is stateless between detections.
    },
    async release() {
      await queue;
      await porcupine.release();
    },
  };
}

// Gemini Live client. The WebSocket itself lives in the Electron main process (so the API key never
// reaches this page); this class captures the mic as 16 kHz PCM, plays back Gemini's 24 kHz PCM,
// handles interruptions, transcripts, and tool calls.
import type { RickyToolSpec } from "../../vite-env";
import { cleanError, MouthMeter, newEntry, runToolCalls, sanitizeToolResult, type VoiceCallbacks, type VoiceClient, type VoiceOptions } from "./common";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const CHUNK_SAMPLES = INPUT_RATE / 10; // 100 ms per message

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

type GeminiPart = { inlineData?: { mimeType?: string; data?: string }; text?: string; thought?: boolean };
type GeminiMessage = {
  serverContent?: {
    modelTurn?: { parts?: GeminiPart[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  error?: { message?: string };
};

export class GeminiLiveClient implements VoiceClient {
  private toolSpecs: RickyToolSpec[] = [];
  private jsonStringArgs: Record<string, string[]> = {};
  private unsubscribers: Array<() => void> = [];
  private micStream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private outputGain: GainNode | null = null;
  private playing = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private pending = new Int16Array(CHUNK_SAMPLES);
  private pendingLength = 0;
  private resampleCarry = 0;
  private userText = "";
  private assistantText = "";
  private toolRunning = false;
  private connected = false;
  private meter: MouthMeter;

  constructor(private callbacks: VoiceCallbacks, private options: VoiceOptions) {
    this.meter = new MouthMeter(callbacks.onMouthShape);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.callbacks.onConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Connecting to Gemini Live…");

    try {
      this.toolSpecs = await window.ricky.getToolSpecs();
      this.unsubscribers.push(
        window.ricky.onGeminiMessage((message) => void this.handleMessage(message as GeminiMessage)),
        window.ricky.onGeminiStatus(({ message }) => this.callbacks.onStatus(message)),
        window.ricky.onGeminiClosed(({ code, reason }) => {
          this.callbacks.onStatus(`Voice session ended${code ? ` (${code})` : ""}${reason ? `: ${reason}` : "."}`);
          this.disconnect();
        }),
      );

      // Set up audio before the session so no early audio is lost.
      await this.startPlayback();
      const session = await window.ricky.startVoice();
      if (session.provider !== "gemini") throw new Error("Voice provider changed; reconnect.");
      this.jsonStringArgs = session.jsonStringArgs || {};
      this.connected = true;
      await this.startMic();

      this.callbacks.onConnectionState("connected");
      this.callbacks.onMood("idle");
      this.callbacks.onStatus(`Ricky is live (${session.model}). Start talking naturally.`);
    } catch (error) {
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(cleanError(error));
      this.teardown();
    }
  }

  disconnect(): void {
    this.teardown();
    this.callbacks.onConnectionState("idle");
    this.callbacks.onMood("idle");
  }

  sendText(text: string): void {
    if (!this.connected) {
      this.callbacks.onStatus("Connect Ricky before sending a text prompt.");
      return;
    }
    this.callbacks.onTranscript(newEntry("user", text));
    window.ricky.sendGemini({ realtimeInput: { text } });
  }

  private teardown(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
    if (wasConnected) void window.ricky.stopVoice();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.stopPlayback();
    this.meter.stop();
    void this.inputContext?.close();
    void this.outputContext?.close();
    this.inputContext = null;
    this.outputContext = null;
    this.outputGain = null;
    this.pendingLength = 0;
    this.userText = "";
    this.assistantText = "";
  }

  // ---------- Microphone ----------

  private async startMic(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const context = new AudioContext();
    this.inputContext = context;
    const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    await context.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);

    const source = context.createMediaStreamSource(this.micStream);
    const worklet = new AudioWorkletNode(context, "ricky-capture");
    const sink = context.createGain();
    sink.gain.value = 0; // keep the graph pulling without echoing the mic
    source.connect(worklet).connect(sink).connect(context.destination);

    const ratio = context.sampleRate / INPUT_RATE;
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.connected) return;
      if (this.options.pauseMicWhileSpeaking && this.playing.size > 0) return;
      this.pushSamples(event.data, ratio);
    };
  }

  /** Linear-interpolation resample to 16 kHz, convert to PCM16, and send in 100 ms chunks. */
  private pushSamples(input: Float32Array, ratio: number): void {
    let position = this.resampleCarry;
    while (position < input.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = input[index];
      const b = index + 1 < input.length ? input[index + 1] : a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.pending[this.pendingLength++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.pendingLength === CHUNK_SAMPLES) {
        window.ricky.sendGemini({
          realtimeInput: { audio: { data: int16ToBase64(this.pending), mimeType: `audio/pcm;rate=${INPUT_RATE}` } },
        });
        this.pendingLength = 0;
      }
      position += ratio;
    }
    this.resampleCarry = position - input.length;
  }

  // ---------- Playback ----------

  private async startPlayback(): Promise<void> {
    const context = new AudioContext({ sampleRate: OUTPUT_RATE });
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    gain.connect(analyser).connect(context.destination);
    this.outputContext = context;
    this.outputGain = gain;
    this.nextPlayTime = 0;
    this.meter.start(analyser);
    if (context.state === "suspended") await context.resume();
  }

  private playChunk(base64: string, mimeType: string): void {
    const context = this.outputContext;
    const gain = this.outputGain;
    if (!context || !gain) return;
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] || OUTPUT_RATE);
    const samples = base64ToFloat32(base64);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = Math.max(context.currentTime + 0.02, this.nextPlayTime);
    source.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.playing.add(source);
    this.callbacks.onMood("speaking");
    source.onended = () => {
      this.playing.delete(source);
      if (this.playing.size === 0 && !this.toolRunning) this.callbacks.onMood("idle");
    };
  }

  private stopPlayback(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.nextPlayTime = 0;
  }

  // ---------- Server messages ----------

  private async handleMessage(message: GeminiMessage): Promise<void> {
    if (message.error?.message) {
      this.callbacks.onMood("error");
      this.callbacks.onStatus(message.error.message);
      return;
    }

    const content = message.serverContent;
    if (content) {
      if (content.interrupted) {
        this.stopPlayback();
        this.flushAssistant();
        this.callbacks.onMood("listening");
      }
      if (content.inputTranscription?.text) {
        if (!this.userText) this.callbacks.onMood("listening");
        this.userText += content.inputTranscription.text;
      }
      if (content.outputTranscription?.text) {
        this.flushUser();
        this.assistantText += content.outputTranscription.text;
      }
      for (const part of content.modelTurn?.parts || []) {
        if (part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("audio/")) {
          this.flushUser();
          this.playChunk(part.inlineData.data, part.inlineData.mimeType || "");
        }
      }
      if (content.turnComplete) {
        this.flushUser();
        this.flushAssistant();
        if (this.playing.size === 0 && !this.toolRunning) this.callbacks.onMood("idle");
      }
    }

    if (message.toolCall?.functionCalls?.length) {
      await this.executeFunctionCalls(message.toolCall.functionCalls);
    }

    if (message.toolCallCancellation?.ids?.length) {
      this.callbacks.onTranscript(newEntry("tool", "Gemini cancelled a pending tool call."));
    }
  }

  private flushUser(): void {
    const text = this.userText.trim();
    if (text) this.callbacks.onTranscript(newEntry("user", text));
    this.userText = "";
  }

  private flushAssistant(): void {
    const text = this.assistantText.trim();
    if (text) this.callbacks.onTranscript(newEntry("ricky", text));
    this.assistantText = "";
  }

  private async executeFunctionCalls(calls: NonNullable<GeminiMessage["toolCall"]>["functionCalls"] = []): Promise<void> {
    this.flushUser();
    this.toolRunning = true;
    this.callbacks.onMood("working");
    try {
      const completed = await runToolCalls(
        calls
          .filter((call) => call.name)
          .map((call) => ({ id: call.id || crypto.randomUUID(), name: call.name!, args: this.restoreArgs(call.name!, call.args || {}) })),
        this.toolSpecs,
        this.callbacks,
      );
      window.ricky.sendGemini({
        toolResponse: {
          functionResponses: completed.map(({ id, name, result }) => ({
            id,
            name,
            response: result.silent === true ? { ...sanitizeToolResult(result), instruction: "Done. The UI already updated; do not announce this." } : sanitizeToolResult(result),
          })),
        },
      });
    } finally {
      this.toolRunning = false;
      if (this.playing.size === 0) this.callbacks.onMood("idle");
    }
  }

  /** Gemini can't take free-form object params, so those were declared as JSON strings; parse them back. */
  private restoreArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const keys = this.jsonStringArgs[name];
    if (!keys) return args;
    const next = { ...args };
    for (const key of keys) {
      if (typeof next[key] === "string") {
        try {
          next[key] = JSON.parse(next[key] as string);
        } catch {
          next[key] = { value: next[key] };
        }
      }
    }
    return next;
  }
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const length = binary.length >> 1;
  const view = new DataView(new ArrayBuffer(length * 2));
  for (let i = 0; i < length * 2; i += 1) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

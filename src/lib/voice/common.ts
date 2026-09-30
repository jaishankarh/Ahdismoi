import type { RickyArtifact, RickyToolCall, RickyToolResult, RickyToolSpec } from "../../vite-env";

export type RickyConnectionState = "idle" | "connecting" | "connected" | "error";
export type RickyMood = "idle" | "listening" | "thinking" | "speaking" | "working" | "error" | "sleeping";

export type MouthShape = {
  open: number;
  width: number;
  round: number;
  teeth: number;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "ricky" | "system" | "tool";
  text: string;
  at: string;
};

export type VoiceCallbacks = {
  onConnectionState: (state: RickyConnectionState) => void;
  onMood: (mood: RickyMood) => void;
  onMouthShape: (shape: MouthShape) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onArtifact: (artifact: RickyArtifact) => void;
  onMode: (mode: "display" | "computer") => void;
  onStatus: (message: string) => void;
  onThumbnailReady: () => void;
  /** The model asked to end the conversation (wake-word mode). */
  onSleepRequested?: () => void;
};

export type VoiceOptions = { pauseMicWhileSpeaking: boolean };

export interface VoiceClient {
  connect(): Promise<void>;
  disconnect(): void;
  sendText(text: string): void;
  isConnected(): boolean;
  /** Wake-word mode gates the mic while "asleep". */
  setMicEnabled(enabled: boolean): void;
  /** Replay audio captured before the session was listening (Gemini only; no-op elsewhere). */
  injectAudio(samples: Int16Array): void;
}

export type PendingCall = { id: string; name: string; args: Record<string, unknown> };
export type CompletedCall = { id: string; name: string; result: RickyToolResult };

/** Runs tool calls against the main process, updating the UI along the way. Shared by every voice provider. */
export async function runToolCalls(calls: PendingCall[], toolSpecs: RickyToolSpec[], callbacks: VoiceCallbacks): Promise<CompletedCall[]> {
  const completed: CompletedCall[] = [];
  for (const call of calls) {
    const { id, name } = call;
    const args = { ...call.args };
    if (!toolSpecs.some((tool) => tool.name === name)) {
      completed.push({ id, name, result: { ok: false, error: `Tool is not available: ${name}` } });
      continue;
    }

    callbacks.onTranscript(newEntry("tool", `Running ${name}`));
    if (name === "image_generate") {
      callbacks.onArtifact({
        title: "Generating Image",
        kind: "imageLoading",
        content: typeof args.prompt === "string" ? args.prompt : "Ricky is generating an image.",
      });
    }
    if (name === "thumbnail_generate" || name === "thumbnail_edit") {
      const loadingResult = await window.ricky.executeTool({
        name: "thumbnail_loading_prepare",
        arguments: { ...args, mode: name === "thumbnail_edit" ? "edit" : "generate" },
      } satisfies RickyToolCall);
      if (typeof loadingResult.runId === "string") args.runId = loadingResult.runId;
      if (typeof loadingResult.targetId === "string") args.targetId = loadingResult.targetId;
      if (loadingResult.artifact) callbacks.onArtifact(loadingResult.artifact);
    }

    let result: RickyToolResult;
    try {
      result = await window.ricky.executeTool({ name, arguments: args } satisfies RickyToolCall);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (result.mode === "display" || result.mode === "computer") callbacks.onMode(result.mode);
    if (result.artifact) callbacks.onArtifact(result.artifact);
    if (result.thumbnailReady === true) callbacks.onThumbnailReady();
    if (result.sleep === true) callbacks.onSleepRequested?.();
    if (!result.ok && typeof result.error === "string") callbacks.onTranscript(newEntry("tool", `${name} failed: ${result.error}`));
    completed.push({ id, name, result });
  }
  return completed;
}

/** Strip bulky artifact content (images, boards) before sending a tool result back to the model. */
export function sanitizeToolResult(result: RickyToolResult): RickyToolResult {
  if (!result.artifact) return result;
  const { artifact, ...rest } = result;
  return {
    ...rest,
    artifact: {
      title: artifact.title,
      kind: artifact.kind,
      content:
        artifact.kind === "thumbnailBoard"
          ? "Thumbnail board rendered in the UI. Use the compact board field for exact numbers, selected state, and loading state."
          : artifact.kind === "image" || artifact.kind === "imageLoading"
            ? "Image rendered in the UI."
            : artifact.content.length > 1200
              ? `${artifact.content.slice(0, 1200)}...`
              : artifact.content,
      language: artifact.language,
      fullscreen: artifact.fullscreen,
    },
  };
}

/** Drives the animated mouth from an AnalyserNode attached to Ricky's voice output. */
export class MouthMeter {
  private frame = 0;
  private smoothed: MouthShape = silentMouthShape();

  constructor(private onShape: (shape: MouthShape) => void) {}

  start(analyser: AnalyserNode): void {
    this.stop();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    const samples = new Uint8Array(analyser.fftSize);
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(frequencies);
      let total = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        total += centered * centered;
      }
      const rms = Math.sqrt(total / samples.length);
      const energy = clamp01(rms * 10.5);
      const bands = getSpeechBands(frequencies);
      // Simple realtime viseme approximation: low energy rounds the mouth,
      // mid energy opens it, high energy stretches it for consonants/ee sounds.
      const target: MouthShape = {
        open: clamp01(energy * 0.75 + bands.mid * 0.45 - bands.high * 0.16),
        width: clamp01(0.28 + bands.mid * 0.55 + bands.high * 0.74 - bands.low * 0.28),
        round: clamp01(0.08 + bands.low * 0.95 + energy * 0.1 - bands.high * 0.42),
        teeth: clamp01(bands.high * 1.4 + bands.mid * 0.25 - bands.low * 0.35),
      };
      this.smoothed = smoothMouthShape(this.smoothed, target, 0.36);
      this.onShape(this.smoothed);
      this.frame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.smoothed = silentMouthShape();
    this.onShape(this.smoothed);
  }
}

export function silentMouthShape(): MouthShape {
  return { open: 0, width: 0.18, round: 0, teeth: 0 };
}

function smoothMouthShape(current: MouthShape, target: MouthShape, amount: number): MouthShape {
  return {
    open: lerp(current.open, target.open, amount),
    width: lerp(current.width, target.width, amount),
    round: lerp(current.round, target.round, amount),
    teeth: lerp(current.teeth, target.teeth, amount),
  };
}

function getSpeechBands(frequencies: Uint8Array): { low: number; mid: number; high: number } {
  const low = averageRange(frequencies, 2, 14) / 255;
  const mid = averageRange(frequencies, 14, 48) / 255;
  const high = averageRange(frequencies, 48, 110) / 255;
  return { low: clamp01(low * 2.2), mid: clamp01(mid * 2.1), high: clamp01(high * 2.8) };
}

function averageRange(values: Uint8Array, start: number, end: number): number {
  const cappedEnd = Math.min(end, values.length);
  if (start >= cappedEnd) return 0;
  let total = 0;
  for (let index = start; index < cappedEnd; index += 1) total += values[index];
  return total / (cappedEnd - start);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function newEntry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Electron wraps main-process errors as "Error invoking remote method 'x': Error: msg". Keep just msg. */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

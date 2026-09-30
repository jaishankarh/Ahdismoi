// Remembers an optional input/output override and otherwise follows the system default.
// A saved device id is used only while that device is plugged in. When it is missing, capture
// and playback fall back to the current system default and switch back if it returns.
import type { AudioPrefs } from "../../vite-env";

export type AudioRoute = {
  inputId: string;
  outputId: string;
  inputLabel: string;
  outputLabel: string;
  inputFallback: boolean;
  outputFallback: boolean;
};

type Picked = { id: string; label: string; fallback: boolean };
type SinkTarget = AudioContext | HTMLAudioElement;

const EMPTY_ROUTE: AudioRoute = {
  inputId: "",
  outputId: "",
  inputLabel: "System default",
  outputLabel: "System default",
  inputFallback: false,
  outputFallback: false,
};

let prefs: AudioPrefs = { inputId: "", outputId: "" };
let devices: MediaDeviceInfo[] = [];
let route: AudioRoute = { ...EMPTY_ROUTE };
let inputSig = "";
let outputSig = "";
let installed = false;
let chain: Promise<void> = Promise.resolve();

const listListeners = new Set<() => void>();
const inputListeners = new Set<() => void>();
const sinks = new Set<SinkTarget>();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function install(): void {
  if (installed || typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
  installed = true;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void enqueue(reload);
  });
}

function cleanLabel(label: string | undefined, fallback: string): string {
  const text = (label || "").replace(/^Default\s+-\s+/i, "").trim();
  return text || fallback;
}

function pick(preferred: string, kind: MediaDeviceKind): Picked {
  const all = devices.filter((device) => device.kind === kind);
  const system = all.find((device) => device.deviceId === "default") || all.find((device) => device.deviceId !== "communications") || all[0];
  const fallbackLabel = kind === "audioinput" ? "System default microphone" : "System default speaker";
  const systemLabel = cleanLabel(system?.label, fallbackLabel);
  if (!preferred) return { id: system?.deviceId || "", label: systemLabel, fallback: false };
  const chosen = all.find((device) => device.deviceId === preferred);
  if (chosen) return { id: chosen.deviceId, label: cleanLabel(chosen.label, kind === "audioinput" ? "Microphone" : "Speaker"), fallback: false };
  return { id: system?.deviceId || "", label: systemLabel, fallback: true };
}

function inputSignature(picked: Picked): string {
  if (!picked.id || picked.id === "default") return `default:${picked.label}`;
  return `id:${picked.id}`;
}

function outputSignature(picked: Picked): string {
  if (!picked.id || picked.id === "default") return `default:${picked.label}`;
  return `id:${picked.id}`;
}

async function applySink(target: SinkTarget, deviceId: string): Promise<void> {
  const setSinkId = (target as HTMLAudioElement).setSinkId;
  if (typeof setSinkId !== "function") return;
  const sink = !deviceId || deviceId === "default" ? "" : deviceId;
  try {
    await setSinkId.call(target, sink);
  } catch {
    if (sink) await setSinkId.call(target, "").catch(() => undefined);
  }
}

async function reload(): Promise<void> {
  try {
    if (navigator.mediaDevices?.enumerateDevices) devices = [...(await navigator.mediaDevices.enumerateDevices())];
  } catch {
    // Keep the previous list when the browser refuses a refresh.
  }
  const input = pick(prefs.inputId, "audioinput");
  const output = pick(prefs.outputId, "audiooutput");
  const nextInputSig = inputSignature(input);
  const nextOutputSig = outputSignature(output);
  const inputChanged = nextInputSig !== inputSig;
  const outputChanged = nextOutputSig !== outputSig;
  route = {
    inputId: input.id,
    outputId: output.id,
    inputLabel: input.label,
    outputLabel: output.label,
    inputFallback: input.fallback,
    outputFallback: output.fallback,
  };
  inputSig = nextInputSig;
  outputSig = nextOutputSig;
  for (const listener of listListeners) listener();
  if (outputChanged) await Promise.all([...sinks].map((target) => applySink(target, route.outputId)));
  if (inputChanged) for (const listener of inputListeners) listener();
}

export function currentRoute(): AudioRoute {
  return route;
}

export function listDevices(): MediaDeviceInfo[] {
  return devices;
}

/** Devices the user can pick. The system default is a separate empty-id option. */
export function selectableDevices(kind: MediaDeviceKind): MediaDeviceInfo[] {
  return devices.filter((device) => device.kind === kind && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications");
}

export function resolvePreference(preferred: string, kind: MediaDeviceKind): Picked {
  return pick(preferred, kind);
}

export function onDeviceList(listener: () => void): () => void {
  listListeners.add(listener);
  return () => listListeners.delete(listener);
}

export function onInputRoute(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => inputListeners.delete(listener);
}

/** Apply a saved or in-progress choice. Empty ids keep following the system default. */
export function applyAudioPrefs(next: AudioPrefs | undefined): Promise<void> {
  install();
  prefs = { inputId: String(next?.inputId || ""), outputId: String(next?.outputId || "") };
  return enqueue(reload);
}

export function refreshDevices(): Promise<void> {
  install();
  return enqueue(reload);
}

export function inputConstraints(deviceId: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return audio;
}

export async function openInput(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: inputConstraints(deviceId) });
  } catch (error) {
    if (!deviceId) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: inputConstraints("") });
  }
}

/** Point playback at the current output, including later device changes. */
export function watchOutput(target: SinkTarget): () => void {
  sinks.add(target);
  void applySink(target, route.outputId);
  return () => sinks.delete(target);
}

/** Point a short-lived sound at the current output once. */
export async function useOutput(target: SinkTarget): Promise<void> {
  await applySink(target, route.outputId);
}

/** Play a tone in one speaker of the output the user is looking at, saved or not. */
export async function playSpeakerTest(side: "left" | "right", preferredOutputId: string): Promise<void> {
  install();
  await enqueue(reload);
  const picked = pick(preferredOutputId, "audiooutput");
  const context = new AudioContext();
  try {
    if (context.state === "suspended") await context.resume();
    await applySink(context, picked.id);
    await new Promise<void>((resolve) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      const merger = context.createChannelMerger(2);
      const now = context.currentTime;
      osc.type = "sine";
      osc.frequency.value = side === "left" ? 440 : 880;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      osc.connect(gain);
      gain.connect(merger, 0, side === "left" ? 0 : 1);
      merger.connect(context.destination);
      osc.onended = () => resolve();
      osc.start(now);
      osc.stop(now + 0.6);
    });
  } finally {
    await context.close();
  }
}

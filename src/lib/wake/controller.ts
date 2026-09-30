// Wake-word mode: the app listens locally for the wake word while "asleep". When it hears it,
// it opens (or reuses) the voice session, replays what you said right after the wake word, and
// lets you talk. It goes back to sleep after a stretch of silence or when the assistant calls
// go_to_sleep (e.g. after "that's all" / "merci").

import type { WakeSettings } from "../../vite-env";
import { useOutput } from "../audio/devices";
import type { RickyMood, VoiceClient } from "../voice";
import { WakeListener, type WakeDetection, type WakeProgress } from "./listener";

export type WakeState = "off" | "starting" | "asleep" | "waking" | "awake";

type Deps = {
  /** Returns the current voice client, creating (but not connecting) one if needed. */
  ensureClient: () => VoiceClient;
  onState: (state: WakeState) => void;
  onNotice: (message: string) => void;
  log: (message: string) => void;
};

const IDLE_DISCONNECT_MS = 5 * 60 * 1000;

export class WakeController {
  private listener: WakeListener | null = null;
  private state: WakeState = "off";
  private settings: WakeSettings | null = null;
  private sleepTimer = 0;
  private disconnectTimer = 0;
  private sleepPending = false;
  private mood: RickyMood = "idle";

  constructor(private deps: Deps) {}

  get current(): WakeState {
    return this.state;
  }

  async enable(settings: WakeSettings): Promise<void> {
    if (this.state !== "off") await this.disable(false);
    this.settings = settings;
    this.setState("starting");
    const listener = new WakeListener({
      engine: settings.engine,
      phrase: settings.phrase,
      sensitivity: settings.sensitivity,
      onDetect: (detection) => void this.wake(detection),
      onProgress: (progress) => this.deps.onNotice(describeProgress(progress)),
      onError: (message) => this.deps.log(`Wake word: ${message}`),
    });
    try {
      await listener.start();
    } catch (error) {
      this.setState("off");
      throw error;
    }
    this.listener = listener;
    this.goToSleep(false);
  }

  async disable(restoreMic = true): Promise<void> {
    this.clearTimers();
    const listener = this.listener;
    this.listener = null;
    this.setState("off");
    await listener?.stop();
    if (restoreMic) this.deps.ensureClient().setMicEnabled(true);
  }

  /** Called for every mood change of the voice client. */
  onMood(mood: RickyMood): void {
    this.mood = mood;
    if (this.state !== "awake") return;
    window.clearTimeout(this.sleepTimer);
    if (mood !== "idle") return;
    if (this.sleepPending) {
      this.sleepTimer = window.setTimeout(() => this.goToSleep(true), 700);
      return;
    }
    const seconds = this.settings?.sleepAfterSeconds ?? 10;
    this.sleepTimer = window.setTimeout(() => this.goToSleep(true), seconds * 1000);
  }

  /** The assistant called go_to_sleep; sleep once it has finished talking. */
  requestSleep(): void {
    if (this.state !== "awake") return;
    this.sleepPending = true;
    if (this.mood === "idle") this.onMood("idle");
  }

  /** Wake manually (button) or from a detection. */
  async wake(detection?: WakeDetection): Promise<void> {
    if (this.state !== "asleep" || !this.listener) return;
    this.clearTimers();
    this.sleepPending = false;
    this.listener.setActive(false);
    this.setState("waking");
    playChime("wake");
    if (detection?.heard) this.deps.log(`Heard wake word: ${detection.heard}`);

    const client = this.deps.ensureClient();
    try {
      if (!client.isConnected()) {
        client.setMicEnabled(false);
        await client.connect();
        if (!client.isConnected()) throw new Error("Voice did not connect.");
      }
    } catch (error) {
      this.deps.log(`Could not start the conversation: ${error instanceof Error ? error.message : String(error)}`);
      this.goToSleep(false);
      return;
    }
    if ((this.state as WakeState) !== "waking" || !this.listener) return; // disabled meanwhile
    // Replay what was said after the wake word (while we were connecting), then go live.
    if (detection) client.injectAudio(this.listener.audioSince(detection.commandStart));
    client.setMicEnabled(true);
    this.setState("awake");
    this.onMood(this.mood);
  }

  goToSleep(withChime: boolean): void {
    if (!this.listener) return;
    this.clearTimers();
    this.sleepPending = false;
    const client = this.deps.ensureClient();
    client.setMicEnabled(false);
    this.listener.setActive(true);
    this.setState("asleep");
    if (withChime) playChime("sleep");
    // Close an idle voice session after a while so it doesn't cost anything.
    this.disconnectTimer = window.setTimeout(() => {
      if (this.state === "asleep" && client.isConnected()) {
        client.disconnect();
        this.deps.log("Closed the idle voice session. Say the wake word to start a new one.");
      }
    }, IDLE_DISCONNECT_MS);
  }

  private clearTimers(): void {
    window.clearTimeout(this.sleepTimer);
    window.clearTimeout(this.disconnectTimer);
  }

  private setState(state: WakeState): void {
    this.state = state;
    this.deps.onState(state);
  }
}

function describeProgress(progress: WakeProgress): string {
  if (progress.phase === "downloading") {
    const mb = (value = 0) => (value / 1024 / 1024).toFixed(0);
    return progress.total ? `Downloading wake-word model… ${mb(progress.received)}/${mb(progress.total)} MB` : `Downloading wake-word model… ${mb(progress.received)} MB`;
  }
  if (progress.phase === "preparing") return "Preparing wake-word model…";
  return "Loading wake-word engine…";
}

function playChime(kind: "wake" | "sleep"): void {
  void (async () => {
    try {
      const audio = new AudioContext();
      await useOutput(audio);
      const gain = audio.createGain();
      const osc = audio.createOscillator();
      const [from, to] = kind === "wake" ? [660, 990] : [880, 520];
      osc.type = "sine";
      osc.frequency.setValueAtTime(from, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(to, audio.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.2);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.22);
      window.setTimeout(() => void audio.close(), 320);
    } catch {
      // sounds are optional
    }
  })();
}

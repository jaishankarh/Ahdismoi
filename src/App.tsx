import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Ear, EarOff, Expand, History, Keyboard, Mic, MicOff, MonitorCog, PanelRight, Send, Settings } from "lucide-react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { RickyFace } from "./components/RickyFace";
import { SettingsPanel } from "./components/SettingsPanel";
import { createVoiceClient, newEntry, type MouthShape, type RickyConnectionState, type RickyMood, type TranscriptEntry, type VoiceClient } from "./lib/voice";
import { WakeController, type WakeState } from "./lib/wake/controller";
import type { RickyArtifact, RickySettings } from "./vite-env";

type RickyMode = "display" | "computer";

export default function App() {
  const [connectionState, setConnectionState] = useState<RickyConnectionState>("idle");
  const [mood, setMood] = useState<RickyMood>("idle");
  const [mode, setMode] = useState<RickyMode>("display");
  const [artifact, setArtifact] = useState<RickyArtifact | null>(null);
  const [artifactVisible, setArtifactVisible] = useState(true);
  const [artifactFullscreen, setArtifactFullscreen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [mouthShape, setMouthShape] = useState<MouthShape>({ open: 0, width: 0.18, round: 0, teeth: 0 });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    newEntry("system", "Ready. Connect voice, or turn on wake-word mode (ear button)."),
  ]);
  const [status, setStatus] = useState("Idle");
  const [textPrompt, setTextPrompt] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<RickySettings | null>(null);
  const [modeRequest, setModeRequest] = useState<string | null>(null);
  const [wakeState, setWakeState] = useState<WakeState>("off");
  const [wakeNotice, setWakeNotice] = useState("");
  const clientRef = useRef<VoiceClient | null>(null);
  const settingsRef = useRef<RickySettings | null>(null);
  const wakeRef = useRef<WakeController | null>(null);

  const isConnected = connectionState === "connected";
  const assistantName = settings?.assistantName || "Ahdismoi";
  const wakeOn = wakeState !== "off";
  settingsRef.current = settings;

  if (!wakeRef.current) {
    wakeRef.current = new WakeController({
      ensureClient: () => clientRef.current || createClient(),
      onState: (state) => {
        setWakeState(state);
        if (state === "asleep" || state === "awake") setWakeNotice("");
      },
      onNotice: setWakeNotice,
      log: addLog,
    });
  }

  useEffect(() => {
    void window.ricky.getSettings().then((bundle) => {
      setSettings(bundle.settings);
      settingsRef.current = bundle.settings;
      if (bundle.settings.wake.enabled) void startWake(bundle.settings);
      const voiceProvider = bundle.settings.tasks.voice.provider;
      if (!bundle.keys[voiceProvider]?.set) {
        addLog(`Add your ${bundle.providers[voiceProvider].label} API key in Settings (gear icon) to start.`);
      }
    });
    const offChanged = window.ricky.onModeChanged((nextMode) => applyMode(nextMode));
    const offRequest = window.ricky.onModeRequest(({ reason }) => setModeRequest(reason || ""));
    return () => {
      offChanged();
      offRequest();
      void wakeRef.current?.disable(false);
    };
  }, []);

  function addLog(message: string) {
    setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
  }

  function applyMode(nextMode: RickyMode) {
    setMode(nextMode);
    if (nextMode === "computer") {
      setModeRequest(null);
      setArtifactVisible(false);
      setArtifactFullscreen(false);
      setShowLog(false);
      setShowTypeInput(false);
      setShowSettings(false);
    } else {
      setArtifactVisible(true);
    }
  }

  function createClient(): VoiceClient {
    const current = settingsRef.current;
    const client = createVoiceClient(current?.tasks.voice.provider || "gemini", {
      onConnectionState: setConnectionState,
      onMood: (nextMood) => {
        setMood(nextMood);
        wakeRef.current?.onMood(nextMood);
      },
      onSleepRequested: () => wakeRef.current?.requestSleep(),
      onMouthShape: setMouthShape,
      onTranscript: (entry) => setTranscript((items) => [entry, ...items].slice(0, 80)),
      onArtifact: (nextArtifact) => {
        setArtifact(nextArtifact);
        setArtifactVisible(true);
        if (nextArtifact.fullscreen) setArtifactFullscreen(true);
      },
      onMode: applyMode,
      onStatus: (message) => {
        setStatus(message);
        setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
      },
      onThumbnailReady: playThumbnailReadySound,
    }, { pauseMicWhileSpeaking: current?.pauseMicWhileSpeaking === true });
    clientRef.current = client;
    return client;
  }

  async function connect() {
    if (wakeRef.current && wakeRef.current.current === "asleep") {
      await wakeRef.current.wake();
      return;
    }
    const client = clientRef.current || createClient();
    await client.connect();
  }

  function disconnect() {
    if (wakeRef.current && wakeRef.current.current === "awake") {
      wakeRef.current.goToSleep(true);
      return;
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus("Disconnected");
  }

  async function startWake(current: RickySettings) {
    try {
      // A session opened before wake mode has stale instructions; start fresh on the first wake.
      if (clientRef.current?.isConnected()) disconnect();
      await wakeRef.current!.enable(current.wake);
      addLog(`Wake-word mode is on. Say "${current.assistantName}" to start talking.`);
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);
      addLog(`Wake-word mode could not start: ${message}`);
      setWakeNotice("");
      await window.ricky.saveSettings({ wake: { enabled: false } }).then(setSettings);
    }
  }

  async function toggleWake() {
    const current = settingsRef.current || (await window.ricky.getSettings()).settings;
    if (wakeOn) {
      await wakeRef.current!.disable();
      setSettings(await window.ricky.saveSettings({ wake: { enabled: false } }));
      addLog("Wake-word mode is off.");
      return;
    }
    const saved = await window.ricky.saveSettings({ wake: { enabled: true } });
    setSettings(saved);
    settingsRef.current = saved;
    await startWake(saved);
  }

  async function onSettingsSaved(next: RickySettings) {
    const previous = settingsRef.current;
    setSettings(next);
    settingsRef.current = next;
    const wakeChanged = previous && JSON.stringify({ ...previous.wake, enabled: 0 }) !== JSON.stringify({ ...next.wake, enabled: 0 });
    const voiceChanged = previous && JSON.stringify(previous.tasks.voice) !== JSON.stringify(next.tasks.voice);
    if (voiceChanged && !clientRef.current?.isConnected()) clientRef.current = null;
    if (wakeChanged && wakeOn) await startWake(next);
  }

  const micActive = wakeOn ? wakeState === "awake" : isConnected;
  const micLabel = wakeOn ? (wakeState === "awake" ? "Go to sleep" : "Wake now") : isConnected ? "Disconnect voice" : "Connect voice";
  const faceMood: RickyMood = wakeState === "asleep" || wakeState === "starting" ? "sleeping" : mood;
  const wakeBadge =
    wakeNotice ||
    (wakeState === "starting"
      ? "Starting wake word…"
      : wakeState === "asleep"
        ? `Say “${assistantName}”`
        : wakeState === "waking"
          ? "Waking up…"
          : wakeState === "awake"
            ? "Listening — say “that's all” when done"
            : "");

  // The only path into computer mode: a user click in this window.
  async function switchMode(nextMode: RickyMode) {
    const { mode: applied } = await window.ricky.setMode(nextMode);
    applyMode(applied);
    addLog(applied === "computer" ? "Computer control is ON. Click the expand button on the mini face to turn it off." : "Display mode.");
    if (applied === "computer") clientRef.current?.sendText("[System] The user turned computer control on. Continue with their request.");
  }

  function sendTextPrompt() {
    const trimmed = textPrompt.trim();
    if (!trimmed) return;
    clientRef.current?.sendText(trimmed);
    setTextPrompt("");
    setShowTypeInput(false);
  }

  if (mode === "computer") {
    return (
      <main className="app-shell app-shell-mini">
        <section className="mini-companion" aria-label="Computer use mini mode">
          <RickyFace mood={faceMood} mouthShape={mouthShape} name={assistantName} />
          <button
            className="mini-restore-button"
            onClick={() => void switchMode("display")}
            aria-label="Turn off computer control and return to full window"
            title="Turn off computer control"
          >
            <Expand size={14} />
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="window-drag-strip" aria-hidden="true" />
      <div className="window-drag-left-zone" aria-hidden="true" />
      {showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={(next) => void onSettingsSaved(next)}
          voiceConnected={isConnected}
        />
      ) : null}
      {modeRequest ? (
        <div className="mode-request" role="alertdialog" aria-label="Computer control request">
          <MonitorCog size={16} />
          <span>{modeRequest ? `${assistantName} wants to control your computer: ${modeRequest}` : `${assistantName} wants to control your computer.`}</span>
          <button className="settings-button primary" onClick={() => void switchMode("computer")}>
            Allow computer control
          </button>
          <button className="settings-button" onClick={() => setModeRequest(null)}>
            Not now
          </button>
        </div>
      ) : null}
      <section className="companion-window">
        <section className="face-stage">
          <RickyFace mood={faceMood} mouthShape={mouthShape} name={assistantName} />
          {wakeBadge ? <div className={`wake-badge wake-${wakeState}`}>{wakeBadge}</div> : null}
        </section>

        <footer className="bottom-console">
          {showTypeInput ? (
            <section className="prompt-box">
              <input
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendTextPrompt();
                }}
                autoFocus
                placeholder={`Type to ${assistantName}...`}
              />
              <button onClick={sendTextPrompt} aria-label="Send typed prompt" title="Send typed prompt">
                <Send size={15} />
              </button>
            </section>
          ) : null}

          <section className="control-strip">
            <button
              className={micActive ? "simple-button active" : "simple-button"}
              onClick={micActive ? disconnect : () => void connect()}
              disabled={connectionState === "connecting" || wakeState === "starting" || wakeState === "waking"}
              aria-label={micLabel}
              title={micLabel}
            >
              {micActive ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button
              className={wakeOn ? "simple-button active" : "simple-button"}
              onClick={() => void toggleWake()}
              disabled={wakeState === "starting"}
              aria-label={wakeOn ? "Turn off wake-word mode" : "Turn on wake-word mode"}
              title={wakeOn ? "Wake-word mode is on. Click to turn off." : `Wake-word mode: always listen for “${assistantName}”`}
            >
              {wakeOn ? <Ear size={16} /> : <EarOff size={16} />}
            </button>
            <button
              className={showTypeInput ? "simple-button active" : "simple-button"}
              onClick={() => setShowTypeInput((value) => !value)}
              aria-label={`Type to ${assistantName}`}
              title={`Type to ${assistantName}`}
            >
              <Keyboard size={16} />
            </button>
            <button
              className={mode === "display" ? "simple-button active" : "simple-button"}
              onClick={() => void switchMode("display")}
              aria-label="Display mode"
              title="Display mode"
            >
              <PanelRight size={16} />
            </button>
            <button
              className="simple-button danger"
              onClick={() => void switchMode("computer")}
              aria-label="Turn on computer control"
              title="Turn on computer control (only you can)"
            >
              <MonitorCog size={16} />
            </button>
            <button
              className={artifactVisible ? "simple-button active" : "simple-button"}
              onClick={() => setArtifactVisible((value) => !value)}
              aria-label="Toggle artifacts"
              title="Toggle artifacts"
            >
              <BrainCircuit size={16} />
            </button>
            <button
              className={showLog ? "simple-button active" : "simple-button"}
              onClick={() => setShowLog((value) => !value)}
              aria-label="Toggle live log"
              title="Toggle live log"
            >
              <History size={16} />
            </button>
            <button
              className={showSettings ? "simple-button active" : "simple-button"}
              onClick={() => setShowSettings((value) => !value)}
              aria-label="Settings"
              title="Settings: models, API keys, computer control"
            >
              <Settings size={16} />
            </button>
          </section>
        </footer>

        {showLog ? (
          <section className="transcript">
            <div className="section-title">
              <span>Live Log</span>
              <small>{transcript.length} events</small>
            </div>
            <div className="transcript-list">
              {transcript.map((entry) => (
                <article className={`entry entry-${entry.role}`} key={entry.id}>
                  <div>
                    <strong>{entry.role === "ricky" ? assistantName : entry.role}</strong>
                    <time>{entry.at}</time>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <ArtifactPanel
        artifact={artifact}
        visible={artifactVisible}
        fullscreen={artifactFullscreen}
        onToggleVisible={() => setArtifactVisible((value) => !value)}
        onToggleFullscreen={() => setArtifactFullscreen((value) => !value)}
      />
    </main>
  );
}

function playThumbnailReadySound() {
  try {
    const AudioContextClass = window.AudioContext;
    const audio = new AudioContextClass();
    const gain = audio.createGain();
    const osc = audio.createOscillator();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, audio.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.13);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.14);
    window.setTimeout(() => void audio.close(), 220);
  } catch {
    // Audio cues are optional; ignore browsers that block short sounds.
  }
}

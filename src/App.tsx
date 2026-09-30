import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Expand, History, Keyboard, Mic, MicOff, MonitorCog, PanelRight, Send, Settings } from "lucide-react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { RickyFace } from "./components/RickyFace";
import { SettingsPanel } from "./components/SettingsPanel";
import { createVoiceClient, newEntry, type MouthShape, type RickyConnectionState, type RickyMood, type TranscriptEntry, type VoiceClient } from "./lib/voice";
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
    newEntry("system", "Ricky is ready. Connect voice, then talk naturally."),
  ]);
  const [status, setStatus] = useState("Idle");
  const [textPrompt, setTextPrompt] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<RickySettings | null>(null);
  const [modeRequest, setModeRequest] = useState<string | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);

  const isConnected = connectionState === "connected";

  useEffect(() => {
    void window.ricky.getSettings().then((bundle) => {
      setSettings(bundle.settings);
      const voiceProvider = bundle.settings.tasks.voice.provider;
      if (!bundle.keys[voiceProvider]?.set) {
        addLog(`Add your ${bundle.providers[voiceProvider].label} API key in Settings (gear icon) to start.`);
      }
    });
    const offChanged = window.ricky.onModeChanged((nextMode) => applyMode(nextMode));
    const offRequest = window.ricky.onModeRequest(({ reason }) => setModeRequest(reason || "Ricky wants to control your computer."));
    return () => {
      offChanged();
      offRequest();
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

  async function connect() {
    const current = settings || (await window.ricky.getSettings()).settings;
    const client = createVoiceClient(current.tasks.voice.provider, {
      onConnectionState: setConnectionState,
      onMood: setMood,
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
    }, { pauseMicWhileSpeaking: current.pauseMicWhileSpeaking });
    clientRef.current = client;
    await client.connect();
  }

  function disconnect() {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus("Disconnected");
  }

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
        <section className="mini-companion" aria-label="Ricky computer use mini mode">
          <RickyFace mood={mood} mouthShape={mouthShape} />
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
          onSaved={setSettings}
          voiceConnected={isConnected}
        />
      ) : null}
      {modeRequest ? (
        <div className="mode-request" role="alertdialog" aria-label="Computer control request">
          <MonitorCog size={16} />
          <span>{modeRequest.startsWith("Ricky") ? modeRequest : `Ricky wants to control your computer: ${modeRequest}`}</span>
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
          <RickyFace mood={mood} mouthShape={mouthShape} />
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
                placeholder="Type to Ricky..."
              />
              <button onClick={sendTextPrompt} aria-label="Send typed prompt" title="Send typed prompt">
                <Send size={15} />
              </button>
            </section>
          ) : null}

          <section className="control-strip">
            <button
              className={isConnected ? "simple-button active" : "simple-button"}
              onClick={isConnected ? disconnect : connect}
              disabled={connectionState === "connecting"}
              aria-label={isConnected ? "Disconnect voice" : "Connect voice"}
              title={isConnected ? "Disconnect voice" : "Connect voice"}
            >
              {isConnected ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button
              className={showTypeInput ? "simple-button active" : "simple-button"}
              onClick={() => setShowTypeInput((value) => !value)}
              aria-label="Type to Ricky"
              title="Type to Ricky"
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
                    <strong>{entry.role === "ricky" ? "Ricky" : entry.role}</strong>
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

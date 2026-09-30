import { useEffect, useState } from "react";
import type { AudioPrefs } from "../vite-env";
import { onDeviceList, openInput, playSpeakerTest, refreshDevices, resolvePreference, selectableDevices } from "../lib/audio/devices";

type Props = {
  audio: AudioPrefs;
  onChange: (audio: AudioPrefs) => void;
};

function systemOption(kind: "microphone" | "speaker", label: string): string {
  const generic = kind === "microphone" ? "System default microphone" : "System default speaker";
  if (!label || label === generic || label === "System default" || /^default$/i.test(label)) return "System default";
  return `System default (${label})`;
}

function deviceName(label: string, fallback: string): string {
  if (!label || /^default$/i.test(label) || label === "System default") return fallback;
  return label;
}

export function AudioSettings({ audio, onChange }: Props) {
  const [listVersion, setListVersion] = useState(0);
  const [level, setLevel] = useState(0);
  const [meterError, setMeterError] = useState("");
  const [testing, setTesting] = useState<"left" | "right" | null>(null);
  const [testNote, setTestNote] = useState("");

  useEffect(() => {
    let dead = false;
    void refreshDevices().then(() => {
      if (!dead) setListVersion((version) => version + 1);
    });
    const off = onDeviceList(() => {
      if (!dead) setListVersion((version) => version + 1);
    });
    return () => {
      dead = true;
      off();
    };
  }, []);

  const inputs = selectableDevices("audioinput");
  const outputs = selectableDevices("audiooutput");
  const inputRoute = resolvePreference(audio.inputId, "audioinput");
  const outputRoute = resolvePreference(audio.outputId, "audiooutput");
  const systemInput = resolvePreference("", "audioinput");
  const systemOutput = resolvePreference("", "audiooutput");
  void listVersion;

  useEffect(() => {
    let dead = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let raf = 0;
    setLevel(0);
    setMeterError("");
    void (async () => {
      try {
        stream = await openInput(inputRoute.id);
        if (dead) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        await refreshDevices();
        if (dead) return;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const bins = new Uint8Array(analyser.fftSize);
        let last = 0;
        const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (dead || now - last < 80) return;
          last = now;
          analyser.getByteTimeDomainData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i += 1) {
            const sample = (bins[i] - 128) / 128;
            sum += sample * sample;
          }
          setLevel(Math.min(1, Math.sqrt(sum / bins.length) * 3.4));
        };
        raf = requestAnimationFrame(tick);
      } catch (error) {
        if (!dead) setMeterError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
  }, [inputRoute.id]);

  async function testSide(side: "left" | "right") {
    setTesting(side);
    setTestNote(side === "left" ? "Playing a low tone in the left speaker…" : "Playing a high tone in the right speaker…");
    try {
      await playSpeakerTest(side, audio.outputId);
      setTestNote(side === "left" ? "Left speaker test finished." : "Right speaker test finished.");
    } catch (error) {
      setTestNote(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(null);
    }
  }

  return (
    <section className="settings-section">
      <h3>Audio</h3>
      <p className="settings-hint">
        System default is used until you pick a device. That choice is remembered. If the device is unplugged, the app uses the system default until it is plugged back in.
      </p>
      <div className="settings-row">
        <label className="grow">
          <span>Microphone</span>
          <select value={audio.inputId} onChange={(event) => onChange({ ...audio, inputId: event.target.value })}>
            <option value="">{systemOption("microphone", systemInput.label)}</option>
            {audio.inputId && !inputs.some((device) => device.deviceId === audio.inputId) ? <option value={audio.inputId}>Saved microphone (unplugged)</option> : null}
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || "Microphone"}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span>Speakers</span>
          <select value={audio.outputId} onChange={(event) => onChange({ ...audio, outputId: event.target.value })}>
            <option value="">{systemOption("speaker", systemOutput.label)}</option>
            {audio.outputId && !outputs.some((device) => device.deviceId === audio.outputId) ? <option value={audio.outputId}>Saved speakers (unplugged)</option> : null}
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || "Speaker"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-muted">
        In use: {deviceName(inputRoute.label, "system microphone")}
        {inputRoute.fallback ? " (saved microphone is unplugged)" : ""} · {deviceName(outputRoute.label, "system speakers")}
        {outputRoute.fallback ? " (saved speakers are unplugged)" : ""}
      </p>
      <div className="audio-meter-block">
        <span>Input level</span>
        <div className="audio-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label="Microphone level">
          <span style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        {meterError ? <p className="settings-error">{meterError}</p> : <p className="settings-muted">Speak into the microphone. The bar moves when this app is receiving audio.</p>}
      </div>
      <div className="settings-row">
        <button className="settings-button" type="button" disabled={testing !== null} onClick={() => void testSide("left")}>
          {testing === "left" ? "Playing left…" : "Test left speaker"}
        </button>
        <button className="settings-button" type="button" disabled={testing !== null} onClick={() => void testSide("right")}>
          {testing === "right" ? "Playing right…" : "Test right speaker"}
        </button>
      </div>
      {testNote ? <p className="settings-muted">{testNote}</p> : <p className="settings-muted">Left is a lower tone. Right is a higher tone.</p>}
    </section>
  );
}

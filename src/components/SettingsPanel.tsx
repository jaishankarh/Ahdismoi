import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, ExternalLink, KeyRound, LoaderCircle, X } from "lucide-react";
import { cleanError } from "../lib/voice";
import type { ComputerStatus, ProviderId, RickySettings, SettingsBundle, TaskId } from "../vite-env";

type Props = {
  onClose: () => void;
  onSaved: (settings: RickySettings) => void;
  voiceConnected: boolean;
};

type CheckState = { state: "idle" | "checking" | "ok" | "error"; message?: string };

const TASK_ORDER: TaskId[] = ["voice", "imageGenerate", "imageEdit", "search", "vision"];

export function SettingsPanel({ onClose, onSaved, voiceConnected }: Props) {
  const [bundle, setBundle] = useState<SettingsBundle | null>(null);
  const [draft, setDraft] = useState<RickySettings | null>(null);
  const [keyInputs, setKeyInputs] = useState<Partial<Record<ProviderId, string>>>({});
  const [keyMessages, setKeyMessages] = useState<Partial<Record<ProviderId, string>>>({});
  const [checks, setChecks] = useState<Partial<Record<TaskId, CheckState>>>({});
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");

  useEffect(() => {
    void window.ricky.getSettings().then((result) => {
      setBundle(result);
      setDraft(structuredClone(result.settings));
    });
    void window.ricky.computerStatus().then(setComputer).catch(() => setComputer(null));
  }, []);

  const dirty = useMemo(() => bundle && draft && JSON.stringify(bundle.settings) !== JSON.stringify(draft), [bundle, draft]);

  if (!bundle || !draft) {
    return (
      <div className="settings-overlay">
        <section className="settings-panel settings-loading">
          <LoaderCircle className="spin" size={18} /> Loading settings…
        </section>
      </div>
    );
  }

  const neededProviders = new Set(TASK_ORDER.map((task) => draft.tasks[task].provider));

  function updateTask(task: TaskId, patch: Partial<RickySettings["tasks"][TaskId]>) {
    setDraft((current) => {
      if (!current || !bundle) return current;
      const next = structuredClone(current);
      const merged = { ...next.tasks[task], ...patch };
      if (patch.provider && patch.provider !== current.tasks[task].provider) {
        merged.model = bundle.tasks[task].providers[patch.provider]?.[0] || "";
        if (task === "voice") merged.voiceName = bundle.voices[patch.provider]?.[0] || "";
      }
      next.tasks[task] = merged;
      return next;
    });
    setChecks((current) => ({ ...current, [task]: { state: "idle" } }));
    setSavedNote("");
  }

  async function saveKey(provider: ProviderId, value: string) {
    try {
      const keys = await window.ricky.setApiKey(provider, value);
      setBundle((current) => (current ? { ...current, keys } : current));
      setKeyInputs((current) => ({ ...current, [provider]: "" }));
      setKeyMessages((current) => ({ ...current, [provider]: value ? "Saved." : "Removed." }));
    } catch (error) {
      setKeyMessages((current) => ({ ...current, [provider]: cleanError(error) }));
    }
  }

  async function checkTask(task: TaskId) {
    const { provider, model } = draft!.tasks[task];
    setChecks((current) => ({ ...current, [task]: { state: "checking" } }));
    const result = await window.ricky.checkModel(provider, model);
    setChecks((current) => ({ ...current, [task]: { state: result.ok ? "ok" : "error", message: result.message } }));
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await window.ricky.saveSettings(draft!);
      setBundle((current) => (current ? { ...current, settings: saved } : current));
      setDraft(structuredClone(saved));
      onSaved(saved);
      setSavedNote(voiceConnected ? "Saved. Voice changes apply next time you connect." : "Saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-panel" role="dialog" aria-label="Settings">
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="simple-button" onClick={onClose} aria-label="Close settings" title="Close">
            <X size={15} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>Models</h3>
            <p className="settings-hint">Pick a provider and model for each job. Type any model ID; the list only shows suggestions.</p>
            {TASK_ORDER.map((task) => {
              const meta = bundle.tasks[task];
              const value = draft.tasks[task];
              const providerIds = Object.keys(meta.providers) as ProviderId[];
              const presets = meta.providers[value.provider] || [];
              const check = checks[task] || { state: "idle" };
              const listId = `models-${task}`;
              const voiceListId = `voices-${task}`;
              return (
                <article className="settings-task" key={task}>
                  <div className="settings-task-title">
                    <strong>{meta.label}</strong>
                    <small>{meta.description}</small>
                  </div>
                  <div className="settings-row">
                    <label>
                      <span>Provider</span>
                      <select value={value.provider} onChange={(event) => updateTask(task, { provider: event.target.value as ProviderId })}>
                        {providerIds.map((provider) => (
                          <option key={provider} value={provider}>
                            {bundle.providers[provider].label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grow">
                      <span>Model</span>
                      <input list={listId} value={value.model} spellCheck={false} onChange={(event) => updateTask(task, { model: event.target.value })} />
                      <datalist id={listId}>
                        {presets.map((model) => (
                          <option key={model} value={model} />
                        ))}
                      </datalist>
                    </label>
                    {task === "voice" ? (
                      <label>
                        <span>Voice</span>
                        <input list={voiceListId} value={value.voiceName || ""} spellCheck={false} onChange={(event) => updateTask(task, { voiceName: event.target.value })} />
                        <datalist id={voiceListId}>
                          {(bundle.voices[value.provider] || []).map((voice) => (
                            <option key={voice} value={voice} />
                          ))}
                        </datalist>
                      </label>
                    ) : null}
                    <button className="settings-button" onClick={() => void checkTask(task)} disabled={check.state === "checking" || !bundle.keys[value.provider]?.set} title={bundle.keys[value.provider]?.set ? "Check that this model exists (free)" : "Add an API key first"}>
                      {check.state === "checking" ? <LoaderCircle className="spin" size={13} /> : "Check"}
                    </button>
                  </div>
                  {check.state === "ok" || check.state === "error" ? (
                    <p className={check.state === "ok" ? "settings-ok" : "settings-error"}>
                      {check.state === "ok" ? <Check size={12} /> : <CircleAlert size={12} />} {check.message}
                    </p>
                  ) : null}
                  {!bundle.keys[value.provider]?.set ? <p className="settings-error"><CircleAlert size={12} /> Needs a {bundle.providers[value.provider].label} API key (below).</p> : null}
                </article>
              );
            })}
          </section>

          <section className="settings-section">
            <h3>API keys</h3>
            <p className="settings-hint">
              {bundle.encryption.strong
                ? "Keys are encrypted with your system keychain and never shown again."
                : bundle.encryption.available
                  ? "No system keyring was found, so saved keys are only obfuscated. Install gnome-keyring or KWallet, or use .env.local."
                  : "Secure storage is unavailable here. Put keys in .env.local instead."}
            </p>
            {(Object.keys(bundle.providers) as ProviderId[]).map((provider) => {
              const meta = bundle.providers[provider];
              const status = bundle.keys[provider];
              return (
                <article className={`settings-key ${neededProviders.has(provider) ? "needed" : ""}`} key={provider}>
                  <div className="settings-key-title">
                    <KeyRound size={13} />
                    <strong>{meta.label}</strong>
                    <small className={status.set ? "settings-ok" : "settings-muted"}>
                      {status.source === "saved" ? "saved" : status.source === "env" ? `from .env.local (${meta.envKey})` : neededProviders.has(provider) ? "not set · needed" : "not set"}
                    </small>
                    <a href={meta.keyUrl} target="_blank" rel="noreferrer" title="Get a key">
                      Get key <ExternalLink size={11} />
                    </a>
                  </div>
                  <div className="settings-row">
                    <input
                      className="grow"
                      type="password"
                      placeholder={status.source === "saved" ? "•••••••• (enter a new key to replace)" : "Paste API key"}
                      value={keyInputs[provider] || ""}
                      onChange={(event) => setKeyInputs((current) => ({ ...current, [provider]: event.target.value }))}
                      autoComplete="off"
                    />
                    <button className="settings-button" disabled={!keyInputs[provider]} onClick={() => void saveKey(provider, keyInputs[provider] || "")}>
                      Save
                    </button>
                    {status.source === "saved" ? (
                      <button className="settings-button" onClick={() => void saveKey(provider, "")}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {keyMessages[provider] ? <p className="settings-muted">{keyMessages[provider]}</p> : null}
                </article>
              );
            })}
          </section>

          <section className="settings-section">
            <h3>General</h3>
            <div className="settings-row">
              <label className="grow">
                <span>Your name (Ricky uses it when talking to you)</span>
                <input value={draft.userName} onChange={(event) => setDraft({ ...draft, userName: event.target.value })} placeholder="e.g. Jai" />
              </label>
            </div>
            <label className="settings-check">
              <input type="checkbox" checked={draft.pauseMicWhileSpeaking} onChange={(event) => setDraft({ ...draft, pauseMicWhileSpeaking: event.target.checked })} />
              <span>Pause the mic while Ricky talks (Gemini only). Turn on if Ricky keeps interrupting itself on speakers; you won't be able to interrupt it.</span>
            </label>
          </section>

          <section className="settings-section">
            <h3>Computer control</h3>
            {computer ? (
              <div className="settings-computer">
                <p>
                  <strong>{computer.platform}</strong>{" "}
                  {computer.ok ? <span className="settings-ok"><Check size={12} /> ready</span> : <span className="settings-error"><CircleAlert size={12} /> needs setup</span>}
                </p>
                {computer.missing.length ? <p className="settings-error">Missing: {computer.missing.join(", ")}</p> : null}
                {computer.notes.map((note) => (
                  <p className="settings-muted" key={note}>
                    {note}
                  </p>
                ))}
              </div>
            ) : (
              <p className="settings-muted">Checking…</p>
            )}
          </section>
        </div>

        <footer className="settings-footer">
          <span className="settings-muted">{savedNote}</span>
          <button className="settings-button" onClick={onClose}>
            Close
          </button>
          <button className="settings-button primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  );
}

// Settings + API key storage.
// - Non-secret settings live in <userData>/settings.json.
// - API keys live in <userData>/keys.json, encrypted with Electron safeStorage
//   (macOS Keychain / Linux Secret Service or KWallet). .env.local is a fallback.
// - Keys never leave the main process; the renderer only sees whether a key is set.

const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

const PROVIDERS = {
  gemini: { label: "Google Gemini", envKey: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI", envKey: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { label: "OpenRouter", envKey: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys" },
  exa: { label: "Exa", envKey: "EXA_API_KEY", keyUrl: "https://dashboard.exa.ai/api-keys" },
};

// Which providers each task supports, with suggested models. Any model ID can be typed in the UI;
// presets are only suggestions.
const TASKS = {
  voice: {
    label: "Voice (realtime conversation)",
    description: "The live speech-to-speech model you talk to. It also decides which tools to call.",
    providers: {
      gemini: ["gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-2.5-flash-native-audio-preview-12-2025"],
      openai: ["gpt-realtime-2"],
    },
  },
  imageGenerate: {
    label: "Image generation",
    description: "Standalone images and new YouTube thumbnails.",
    providers: {
      gemini: ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-2.5-flash-image"],
      openai: ["gpt-image-2"],
      openrouter: ["black-forest-labs/flux.2-klein-4b", "qwen/qwen-image-3", "qwen/qwen-image-3-pro", "google/gemini-3.1-flash-image"],
    },
  },
  imageEdit: {
    label: "Image editing",
    description: "Thumbnail edits and generations that use your reference photos.",
    providers: {
      gemini: ["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-2.5-flash-image"],
      openai: ["gpt-image-2"],
      openrouter: ["black-forest-labs/flux.2-klein-4b", "qwen/qwen-image-3", "google/gemini-3.1-flash-image"],
    },
  },
  search: {
    label: "Web search",
    description: "Answers questions about current events with source links.",
    providers: {
      gemini: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"],
      openai: ["gpt-5-mini", "gpt-5"],
      openrouter: ["google/gemini-3.8-flash", "qwen/qwen3.8-omni-flash", "deepseek/deepseek-chat"],
      exa: ["auto"],
    },
  },
  vision: {
    label: "Screen understanding",
    description: "Looks at screenshots in computer-use mode and finds where to click.",
    providers: {
      gemini: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"],
      openai: ["gpt-5-mini", "gpt-5"],
      openrouter: ["google/gemini-3.8-flash", "qwen/qwen3.8-omni-flash"],
    },
  },
};

const VOICE_PRESETS = {
  gemini: ["Charon", "Puck", "Kore", "Fenrir", "Aoede", "Orus", "Leda", "Zephyr"],
  openai: ["cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
};

function defaultSettings() {
  return {
    userName: "",
    tasks: {
      voice: { provider: "gemini", model: "gemini-3.8-live", voiceName: "Charon" },
      imageGenerate: { provider: "gemini", model: "gemini-3.1-flash-image" },
      imageEdit: { provider: "gemini", model: "gemini-3.1-flash-image" },
      search: { provider: "gemini", model: "gemini-3.8-flash" },
      vision: { provider: "gemini", model: "gemini-3.8-flash" },
    },
    pauseMicWhileSpeaking: false,
  };
}

let cache = null;
let keyCache = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function keysPath() {
  return path.join(app.getPath("userData"), "keys.json");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  const next = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  next.tasks = { ...base.tasks };
  for (const task of Object.keys(TASKS)) {
    const incoming = raw?.tasks?.[task];
    const merged = { ...base.tasks[task], ...(incoming && typeof incoming === "object" ? incoming : {}) };
    if (!TASKS[task].providers[merged.provider]) merged.provider = base.tasks[task].provider;
    merged.model = String(merged.model || "").trim() || TASKS[task].providers[merged.provider][0];
    next.tasks[task] = merged;
  }
  next.userName = String(next.userName || "").slice(0, 60);
  next.pauseMicWhileSpeaking = next.pauseMicWhileSpeaking === true;
  return next;
}

async function getSettings() {
  if (!cache) cache = normalizeSettings(await readJson(settingsPath(), null));
  return cache;
}

async function saveSettings(partial) {
  const current = await getSettings();
  const merged = {
    ...current,
    ...partial,
    tasks: { ...current.tasks },
  };
  for (const [task, value] of Object.entries(partial?.tasks || {})) {
    merged.tasks[task] = { ...current.tasks[task], ...value };
  }
  cache = normalizeSettings(merged);
  await writeJson(settingsPath(), cache);
  return cache;
}

function encryptionInfo() {
  const available = safeStorage.isEncryptionAvailable();
  let backend = null;
  if (process.platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function") {
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      backend = null;
    }
  }
  // On Linux without a keyring, Electron falls back to a hard-coded password ("basic_text"),
  // which is obfuscation rather than encryption. Tell the user.
  const strong = available && backend !== "basic_text";
  return { available, backend, strong };
}

async function loadKeys() {
  if (keyCache) return keyCache;
  const stored = await readJson(keysPath(), {});
  keyCache = {};
  for (const [provider, entry] of Object.entries(stored)) {
    try {
      if (entry?.enc && safeStorage.isEncryptionAvailable()) {
        keyCache[provider] = safeStorage.decryptString(Buffer.from(entry.enc, "base64"));
      }
    } catch {
      // Unreadable (e.g. keyring changed). Treat as missing.
    }
  }
  return keyCache;
}

async function setApiKey(provider, value) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider: ${provider}`);
  const keys = await loadKeys();
  const stored = await readJson(keysPath(), {});
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    delete keys[provider];
    delete stored[provider];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure storage is not available on this system. Put the key in .env.local instead.");
    }
    keys[provider] = trimmed;
    stored[provider] = { enc: safeStorage.encryptString(trimmed).toString("base64") };
  }
  await writeJson(keysPath(), stored);
}

async function getApiKey(provider) {
  const keys = await loadKeys();
  return keys[provider] || process.env[PROVIDERS[provider]?.envKey] || "";
}

async function requireApiKey(provider) {
  const key = await getApiKey(provider);
  if (!key) {
    throw new Error(`${PROVIDERS[provider]?.label || provider} API key is missing. Add it in Settings (gear icon) or ${PROVIDERS[provider]?.envKey} in .env.local.`);
  }
  return key;
}

async function keyStatus() {
  const keys = await loadKeys();
  const status = {};
  for (const [provider, meta] of Object.entries(PROVIDERS)) {
    status[provider] = {
      set: Boolean(keys[provider] || process.env[meta.envKey]),
      source: keys[provider] ? "saved" : process.env[meta.envKey] ? "env" : null,
    };
  }
  return status;
}

module.exports = {
  PROVIDERS,
  TASKS,
  VOICE_PRESETS,
  getSettings,
  saveSettings,
  setApiKey,
  getApiKey,
  requireApiKey,
  keyStatus,
  encryptionInfo,
};

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("ricky", {
  // Tools
  executeTool: (toolCall) => ipcRenderer.invoke("tools:execute", toolCall),
  getToolSpecs: () => ipcRenderer.invoke("tools:list"),

  // Voice
  startVoice: () => ipcRenderer.invoke("voice:start"),
  stopVoice: () => ipcRenderer.invoke("voice:stop"),
  sendGemini: (message) => ipcRenderer.send("voice:gemini-send", message),
  onGeminiMessage: (callback) => subscribe("voice:gemini-message", callback),
  onGeminiClosed: (callback) => subscribe("voice:gemini-closed", callback),
  onGeminiStatus: (callback) => subscribe("voice:gemini-status", callback),

  // Mode (only user clicks call setMode)
  setMode: (mode) => ipcRenderer.invoke("mode:set", mode),
  onModeChanged: (callback) => subscribe("mode:changed", callback),
  onModeRequest: (callback) => subscribe("mode:request", callback),

  // Settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),
  setApiKey: (provider, value) => ipcRenderer.invoke("settings:set-key", { provider, value }),
  checkModel: (provider, model) => ipcRenderer.invoke("settings:check-model", { provider, model }),
  computerStatus: () => ipcRenderer.invoke("computer:status"),

  // Wake word
  prepareVoskModel: () => ipcRenderer.invoke("wake:prepare-vosk"),
  clearVoskModel: () => ipcRenderer.invoke("wake:clear-vosk"),
  porcupineAssets: () => ipcRenderer.invoke("wake:porcupine-assets"),
  choosePorcupineKeyword: () => ipcRenderer.invoke("wake:choose-keyword"),
  onWakeProgress: (callback) => subscribe("wake:progress", callback),
});

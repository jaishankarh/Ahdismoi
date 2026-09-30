/// <reference types="vite/client" />

export type RickyArtifact = {
  title: string;
  kind:
    | "text"
    | "markdown"
    | "code"
    | "table"
    | "notes"
    | "mermaid"
    | "image"
    | "imageLoading"
    | "thumbnailBoard"
    | "progress";
  content: string;
  language?: string;
  fullscreen?: boolean;
};

export type RickyToolSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RickyToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type RickyToolResult = {
  ok: boolean;
  artifact?: RickyArtifact;
  mode?: "display" | "computer";
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type ProviderId = "gemini" | "openai" | "openrouter" | "exa" | "picovoice";
export type TaskId = "voice" | "imageGenerate" | "imageEdit" | "search" | "vision";

export type TaskSetting = { provider: ProviderId; model: string; voiceName?: string };

export type WakeSettings = {
  enabled: boolean;
  engine: "vosk" | "porcupine";
  phrase: string;
  sensitivity: number;
  sleepAfterSeconds: number;
  voskModelUrl: string;
  porcupineLanguage: "fr" | "en";
  porcupineKeywordName: string;
};

export type AudioPrefs = {
  /** Empty follows the system default. A device id is used only after the user picks one. */
  inputId: string;
  outputId: string;
};

export type RickySettings = {
  userName: string;
  assistantName: string;
  wake: WakeSettings;
  tasks: Record<TaskId, TaskSetting>;
  pauseMicWhileSpeaking: boolean;
  audio: AudioPrefs;
};

export type SettingsBundle = {
  settings: RickySettings;
  tasks: Record<TaskId, { label: string; description: string; providers: Partial<Record<ProviderId, string[]>> }>;
  providers: Record<ProviderId, { label: string; envKey: string; keyUrl: string }>;
  voices: Partial<Record<ProviderId, string[]>>;
  keys: Record<ProviderId, { set: boolean; source: "saved" | "env" | null }>;
  encryption: { available: boolean; backend: string | null; strong: boolean };
  platform: string;
};

export type ComputerStatus = { platform: string; ok: boolean; missing: string[]; notes: string[] };

export type VoiceStartResult =
  | { provider: "openai"; token: string; model: string }
  | { provider: "gemini"; model: string; jsonStringArgs: Record<string, string[]> };

declare global {
  interface Window {
    ricky: {
      executeTool: (toolCall: RickyToolCall) => Promise<RickyToolResult>;
      getToolSpecs: () => Promise<RickyToolSpec[]>;
      startVoice: () => Promise<VoiceStartResult>;
      stopVoice: () => Promise<boolean>;
      sendGemini: (message: Record<string, unknown>) => void;
      onGeminiMessage: (callback: (message: any) => void) => () => void;
      onGeminiClosed: (callback: (info: { code: number; reason: string }) => void) => () => void;
      onGeminiStatus: (callback: (info: { message: string }) => void) => () => void;
      setMode: (mode: "display" | "computer") => Promise<{ mode: "display" | "computer" }>;
      dismissModeRequest: () => Promise<boolean>;
      onModeChanged: (callback: (mode: "display" | "computer") => void) => () => void;
      onModeRequest: (callback: (info: { reason: string }) => void) => () => void;
      getSettings: () => Promise<SettingsBundle>;
      saveSettings: (
        partial: Partial<Omit<RickySettings, "tasks" | "wake" | "audio">> & {
          tasks?: Partial<Record<TaskId, Partial<TaskSetting>>>;
          wake?: Partial<WakeSettings>;
          audio?: Partial<AudioPrefs>;
        },
      ) => Promise<RickySettings>;
      resetSettings: () => Promise<RickySettings>;
      setApiKey: (provider: ProviderId, value: string) => Promise<SettingsBundle["keys"]>;
      checkModel: (provider: ProviderId, model: string) => Promise<{ ok: boolean; message: string }>;
      computerStatus: () => Promise<ComputerStatus>;
      prepareVoskModel: () => Promise<{ modelUrl: string; cached: boolean }>;
      clearVoskModel: () => Promise<void>;
      porcupineAssets: () => Promise<{ accessKey: string; keywordBase64: string; modelBase64: string; modelVersion: string }>;
      choosePorcupineKeyword: () => Promise<RickySettings | null>;
      onWakeProgress: (callback: (progress: unknown) => void) => () => void;
    };
  }
}

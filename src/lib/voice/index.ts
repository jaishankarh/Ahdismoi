import type { ProviderId } from "../../vite-env";
import type { VoiceCallbacks, VoiceClient, VoiceOptions } from "./common";
import { GeminiLiveClient } from "./gemini";
import { OpenAIRealtimeClient } from "./openai";

export * from "./common";

export function createVoiceClient(provider: ProviderId, callbacks: VoiceCallbacks, options: VoiceOptions): VoiceClient {
  if (provider === "openai") return new OpenAIRealtimeClient(callbacks);
  return new GeminiLiveClient(callbacks, options);
}

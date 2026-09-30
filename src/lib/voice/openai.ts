// OpenAI Realtime over WebRTC (the original RileyJarvis transport), now using the model and voice from Settings.
import type { RickyToolSpec } from "../../vite-env";
import { cleanError, MouthMeter, newEntry, parseJsonObject, runToolCalls, sanitizeToolResult, type VoiceCallbacks, type VoiceClient } from "./common";

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  response?: { output?: ResponseOutputItem[] };
  item?: { type?: string; role?: string; content?: Array<{ transcript?: string; text?: string }> };
  error?: { message?: string };
};

type ResponseOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ transcript?: string; text?: string }>;
};

const realtimeUrl = "https://api.openai.com/v1/realtime/calls";

export class OpenAIRealtimeClient implements VoiceClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private currentAssistantText = "";
  private toolSpecs: RickyToolSpec[] = [];
  private toolRunning = false;
  private meter: MouthMeter;

  constructor(private callbacks: VoiceCallbacks) {
    this.meter = new MouthMeter(callbacks.onMouthShape);
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    this.callbacks.onConnectionState("connecting");
    this.callbacks.onMood("thinking");
    this.callbacks.onStatus("Connecting to OpenAI Realtime…");

    try {
      this.toolSpecs = await window.ricky.getToolSpecs();
      const session = await window.ricky.startVoice();
      if (session.provider !== "openai") throw new Error("Voice provider changed; reconnect.");
      const pc = new RTCPeerConnection();
      const audio = document.createElement("audio");
      audio.autoplay = true;

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(event.streams[0]).connect(analyser);
        this.audioContext = context;
        this.meter.start(analyser);
      };

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(this.micStream.getAudioTracks()[0], this.micStream);

      const dc = pc.createDataChannel("oai-events");
      dc.addEventListener("open", () => {
        this.callbacks.onConnectionState("connected");
        this.callbacks.onMood("idle");
        this.callbacks.onStatus(`Live (${session.model}). Start talking naturally.`);
      });
      dc.addEventListener("message", (event) => void this.handleServerEvent(event.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch(realtimeUrl, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/sdp" },
      });
      if (!sdpResponse.ok) throw new Error(`Realtime WebRTC call failed: ${sdpResponse.status} ${await sdpResponse.text()}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });

      this.pc = pc;
      this.dc = dc;
    } catch (error) {
      this.callbacks.onConnectionState("error");
      this.callbacks.onMood("error");
      this.callbacks.onStatus(cleanError(error));
      this.disconnect(false);
    }
  }

  disconnect(resetState = true): void {
    this.dc?.close();
    this.pc?.close();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.meter.stop();
    void this.audioContext?.close();
    this.audioContext = null;
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.currentAssistantText = "";
    if (resetState) {
      this.callbacks.onConnectionState("idle");
      this.callbacks.onMood("idle");
    }
  }

  isConnected(): boolean {
    return this.dc?.readyState === "open";
  }

  setMicEnabled(enabled: boolean): void {
    // A disabled WebRTC track sends silence.
    this.micStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  injectAudio(_samples: Int16Array): void {
    // WebRTC streams live audio only; nothing to replay.
  }

  sendText(text: string): void {
    if (!this.dc || this.dc.readyState !== "open") {
      this.callbacks.onStatus("Connect voice before sending a text prompt.");
      return;
    }
    this.callbacks.onTranscript(newEntry("user", text));
    this.sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.sendEvent({ type: "response.create" });
  }

  private async handleServerEvent(raw: string): Promise<void> {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    if (!event.type) return;

    switch (event.type) {
      case "error":
        this.callbacks.onMood("error");
        this.callbacks.onStatus(event.error?.message || "Realtime API returned an error.");
        return;
      case "input_audio_buffer.speech_started":
        this.callbacks.onMood("listening");
        return;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onMood("thinking");
        return;
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.callbacks.onMood("speaking");
        return;
      case "response.output_audio.done":
      case "response.audio.done":
        if (!this.toolRunning) this.callbacks.onMood("idle");
        return;
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
        this.currentAssistantText += event.delta || "";
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript || collectText(event.item?.content);
        if (transcript) this.callbacks.onTranscript(newEntry("user", transcript));
        return;
      }
      case "response.done": {
        const output = event.response?.output || [];
        const spoken = this.currentAssistantText || output.map((item) => collectText(item.content)).filter(Boolean).join("\n");
        if (spoken) this.callbacks.onTranscript(newEntry("ricky", spoken));
        this.currentAssistantText = "";
        const functionCalls = output.filter((item) => item.type === "function_call" && item.name && item.call_id);
        if (functionCalls.length > 0) await this.executeFunctionCalls(functionCalls);
        else if (!this.toolRunning) this.callbacks.onMood("idle");
      }
    }
  }

  private async executeFunctionCalls(items: ResponseOutputItem[]): Promise<void> {
    this.toolRunning = true;
    this.callbacks.onMood("working");
    const completed = await runToolCalls(
      items.map((item) => ({ id: item.call_id!, name: item.name!, args: parseJsonObject(item.arguments || "{}") })),
      this.toolSpecs,
      this.callbacks,
    );
    let shouldRespond = false;
    for (const { id, result } of completed) {
      if (result.silent !== true) shouldRespond = true;
      this.sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: JSON.stringify(sanitizeToolResult(result)) } });
    }
    if (shouldRespond) this.sendEvent({ type: "response.create" });
    this.toolRunning = false;
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }
}

function collectText(content?: Array<{ transcript?: string; text?: string }>): string {
  return content?.map((part) => part.transcript || part.text || "").filter(Boolean).join("\n") || "";
}

// Voice session backends.
// - OpenAI Realtime: mint a short-lived client secret; the renderer connects over WebRTC.
// - Gemini Live: the main process holds the WebSocket (the API key never reaches the renderer)
//   and relays JSON messages to/from the renderer over IPC. It also transparently resumes the
//   session when Google sends goAway, so conversations can run past the ~15 minute limit.

const crypto = require("node:crypto");
const { requireApiKey, getSettings } = require("./settings.cjs");

const GEMINI_WS =
  process.env.AHDISMOI_GEMINI_WS_URL ||
  process.env.RICKY_GEMINI_WS_URL || "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ---------- OpenAI Realtime ----------

async function createOpenAISession({ instructions, tools }) {
  const settings = await getSettings();
  const { model, voiceName } = settings.tasks.voice;
  const apiKey = await requireApiKey("openai");
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": crypto.createHash("sha256").update("rileyjarvis-local").digest("hex"),
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions,
        output_modalities: ["audio"],
        ...(model.startsWith("gpt-realtime-2") ? { reasoning: { effort: "low" } } : {}),
        tool_choice: "auto",
        tools,
        audio: {
          input: {
            turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true },
          },
          output: { voice: voiceName || "cedar" },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI Realtime token request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const value = data.value || data.client_secret?.value;
  if (!value) throw new Error("OpenAI Realtime token response did not include a client secret.");
  return { provider: "openai", token: value, model };
}

// ---------- Gemini Live ----------

// Convert our JSON-schema tool specs into Gemini function declarations.
// Open-ended objects (e.g. record "fields") become JSON strings, which the renderer parses back.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "STRING" };
  const type = String(schema.type || "string").toUpperCase();
  const out = { type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);
  if (type === "NUMBER" || type === "INTEGER") {
    if (typeof schema.minimum === "number") out.minimum = schema.minimum;
    if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  }
  if (type === "ARRAY") out.items = toGeminiSchema(schema.items || { type: "string" });
  if (type === "OBJECT") {
    const props = schema.properties || {};
    if (Object.keys(props).length === 0) {
      return { type: "STRING", description: `${schema.description ? `${schema.description} ` : ""}JSON-encoded object, e.g. {"key": "value"}.` };
    }
    out.properties = {};
    for (const [key, value] of Object.entries(props)) out.properties[key] = toGeminiSchema(value);
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  }
  return out;
}

function toGeminiTools(tools) {
  const functionDeclarations = tools.map((tool) => {
    const declaration = { name: tool.name, description: tool.description };
    const props = tool.parameters?.properties || {};
    if (Object.keys(props).length > 0) declaration.parameters = toGeminiSchema(tool.parameters);
    return declaration;
  });
  return [{ functionDeclarations }];
}

// Names of arguments that were converted to JSON strings, per tool, so the renderer can parse them.
function jsonStringArgs(tools) {
  const map = {};
  for (const tool of tools) {
    for (const [key, value] of Object.entries(tool.parameters?.properties || {})) {
      if (value?.type === "object" && Object.keys(value.properties || {}).length === 0) {
        (map[tool.name] ||= []).push(key);
      }
    }
  }
  return map;
}

class GeminiLiveSession {
  constructor({ send, onClose }) {
    this.send = send; // (channel, payload) => void, delivers to renderer
    this.onClose = onClose;
    this.ws = null;
    this.setup = null;
    this.resumeHandle = null;
    this.closedByUser = false;
    this.reconnecting = false;
  }

  async start({ instructions, tools }) {
    const settings = await getSettings();
    const { model, voiceName } = settings.tasks.voice;
    this.apiKey = await requireApiKey("gemini");
    this.setup = {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || "Charon" } } },
      },
      systemInstruction: { parts: [{ text: instructions }] },
      tools: toGeminiTools(tools),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {},
    };
    await this.open();
    return { provider: "gemini", model, jsonStringArgs: jsonStringArgs(tools) };
  }

  open() {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS}?key=${encodeURIComponent(this.apiKey)}`;
      const ws = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Timed out connecting to Gemini Live."));
          try {
            ws.close();
          } catch {}
        }
      }, 15000);

      ws.addEventListener("open", () => {
        const setup = { ...this.setup };
        if (this.resumeHandle) setup.sessionResumption = { handle: this.resumeHandle };
        ws.send(JSON.stringify({ setup }));
      });

      ws.addEventListener("message", async (event) => {
        const text = typeof event.data === "string" ? event.data : Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data).toString("utf8");
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message.setupComplete && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
        if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
          this.resumeHandle = message.sessionResumptionUpdate.newHandle;
        }
        if (message.goAway) {
          void this.reconnect();
        }
        this.send("voice:gemini-message", message);
      });

      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`Gemini Live closed during setup (${event.code}): ${event.reason || "check the model ID and API key in Settings"}`));
          return;
        }
        if (this.ws !== ws) return; // replaced by a resumed connection
        if (!this.closedByUser && this.resumeHandle && !this.reconnecting) {
          void this.reconnect();
          return;
        }
        if (!this.closedByUser) {
          this.send("voice:gemini-closed", { code: event.code, reason: event.reason || "" });
        }
        this.onClose?.();
      });

      ws.addEventListener("error", () => {
        // 'close' follows and carries the details.
      });

      this.ws = ws;
    });
  }

  async reconnect() {
    if (this.reconnecting || this.closedByUser || !this.resumeHandle) return;
    this.reconnecting = true;
    const old = this.ws;
    this.send("voice:gemini-status", { message: "Refreshing the voice session…" });
    try {
      await this.open();
      try {
        old?.close();
      } catch {}
    } catch (error) {
      this.send("voice:gemini-closed", { code: 0, reason: error.message });
    } finally {
      this.reconnecting = false;
    }
  }

  sendClient(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  close() {
    this.closedByUser = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

module.exports = { createOpenAISession, GeminiLiveSession, toGeminiTools, jsonStringArgs };

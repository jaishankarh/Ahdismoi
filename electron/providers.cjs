// Provider adapters for every non-voice model call: image generation/editing, web search,
// screen understanding (vision), and cheap "does this model exist" checks for the settings panel.
// Each task picks its provider + model from settings, so any model can be swapped in.

const fs = require("node:fs/promises");
const path = require("node:path");
const { requireApiKey, getSettings } = require("./settings.cjs");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BASE = "https://api.openai.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://github.com/rileyjarvis", "X-Title": "RileyJarvis" };

// ---------- HTTP helpers ----------

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${response.status} ${summarizeError(text)}`);
    error.status = response.status;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected non-JSON response: ${text.slice(0, 200)}`);
  }
}

function summarizeError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text.slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function fileToInline(filePath) {
  const buffer = await fs.readFile(filePath);
  return { mimeType: mimeForPath(filePath), data: buffer.toString("base64") };
}

function extForMime(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

// ---------- Images ----------

// size is one of "square" | "portrait" | "landscape" | "thumbnail".
const ASPECT = { square: "1:1", portrait: "2:3", landscape: "3:2", thumbnail: "16:9" };
const OPENAI_SIZE = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024", thumbnail: "1536x1024" };

/**
 * Generate or edit an image.
 * @param {{task: "imageGenerate"|"imageEdit", prompt: string, shape: string, inputPaths?: string[]}} options
 * @returns {Promise<{mimeType: string, data: string}>} base64 image
 */
async function generateImage({ task, prompt, shape, inputPaths = [] }) {
  const settings = await getSettings();
  const { provider, model } = settings.tasks[task];
  if (provider === "gemini") return geminiImage({ model, prompt, shape, inputPaths });
  if (provider === "openai") return openaiImage({ model, prompt, shape, inputPaths });
  if (provider === "openrouter") return openrouterImage({ model, prompt, shape, inputPaths });
  throw new Error(`Provider ${provider} cannot generate images.`);
}

async function geminiImage({ model, prompt, shape, inputPaths }) {
  const key = await requireApiKey("gemini");
  const inlines = await Promise.all(inputPaths.slice(0, 10).map(fileToInline));
  const parts = [{ text: prompt }, ...inlines.map((inline) => ({ inline_data: { mime_type: inline.mimeType, data: inline.data } }))];

  try {
    const data = await postJson(
      `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: ASPECT[shape] || "1:1", imageSize: "1K" },
        },
      },
      { "x-goog-api-key": key },
    );
    const image = findGeminiImage(data);
    if (image) return image;
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    const text = collectGeminiText(data);
    throw new Error(`Gemini returned no image${reason ? ` (${reason})` : ""}${text ? `: ${text.slice(0, 300)}` : "."}`);
  } catch (error) {
    // Newer Google docs describe an Interactions API for image models. If generateContent is
    // rejected for this model, try that shape before giving up.
    if (error.status !== 404 && error.status !== 400) throw error;
    const data = await postJson(
      `${GEMINI_BASE}/interactions`,
      {
        model,
        input: [
          { type: "text", text: prompt },
          ...inlines.map((inline) => ({ type: "image", mime_type: inline.mimeType, data: inline.data })),
        ],
        response_format: { type: "image", aspect_ratio: ASPECT[shape] || "1:1", image_size: "1K" },
      },
      { "x-goog-api-key": key },
    ).catch((fallbackError) => {
      throw new Error(`Gemini image request failed: ${error.message} (fallback: ${fallbackError.message})`);
    });
    const image = findInteractionImage(data);
    if (image) return image;
    throw new Error("Gemini returned no image data.");
  }
}

function findGeminiImage(data) {
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) return { mimeType: inline.mimeType || inline.mime_type || "image/png", data: inline.data };
    }
  }
  return null;
}

function findInteractionImage(data) {
  const pools = [data?.outputs, ...(data?.steps || []).map((step) => step?.content || step?.model_output?.content)];
  for (const pool of pools) {
    for (const item of pool || []) {
      if (item?.type === "image" && (item.data || item.image?.data)) {
        return { mimeType: item.mime_type || item.image?.mime_type || "image/png", data: item.data || item.image.data };
      }
    }
  }
  return null;
}

function collectGeminiText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => (part.thought ? "" : part.text || ""))
    .join("")
    .trim();
}

async function openaiImage({ model, prompt, shape, inputPaths }) {
  const key = await requireApiKey("openai");
  const size = OPENAI_SIZE[shape] || "1024x1024";

  if (inputPaths.length === 0) {
    const data = await postJson(`${OPENAI_BASE}/images/generations`, { model, prompt, size, quality: "medium" }, { Authorization: `Bearer ${key}` });
    return openaiImageResult(data);
  }

  const buildForm = async (fieldName) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", "medium");
    for (const inputPath of inputPaths.slice(0, 10)) {
      const buffer = await fs.readFile(inputPath);
      form.append(fieldName, new Blob([buffer], { type: mimeForPath(inputPath) }), path.basename(inputPath));
    }
    return form;
  };

  let response = await fetch(`${OPENAI_BASE}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: await buildForm("image[]") });
  if (!response.ok) {
    const firstError = await response.text();
    response = await fetch(`${OPENAI_BASE}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: await buildForm("image") });
    if (!response.ok) throw new Error(`OpenAI image edit failed: ${response.status} ${summarizeError((await response.text()) || firstError)}`);
  }
  return openaiImageResult(await response.json());
}

async function openaiImageResult(data) {
  const item = data?.data?.[0];
  if (item?.b64_json) return { mimeType: "image/png", data: item.b64_json };
  if (item?.url) return await downloadImage(item.url);
  throw new Error("OpenAI image response did not include image data.");
}

async function openrouterImage({ model, prompt, shape, inputPaths }) {
  const key = await requireApiKey("openrouter");
  const inlines = await Promise.all(inputPaths.slice(0, 4).map(fileToInline));
  const body = {
    model,
    prompt,
    aspect_ratio: ASPECT[shape] || "1:1",
    resolution: "1K",
  };
  if (inlines.length) {
    body.input_references = inlines.map((inline) => ({ type: "image_url", image_url: { url: `data:${inline.mimeType};base64,${inline.data}` } }));
  }
  const data = await postJson(`${OPENROUTER_BASE}/images`, body, { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS });
  const item = data?.data?.[0];
  if (item?.b64_json) return { mimeType: item.media_type || "image/png", data: item.b64_json };
  if (item?.url) return await downloadImage(item.url);
  throw new Error("OpenRouter image response did not include image data.");
}

async function downloadImage(url) {
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (match) return { mimeType: match[1], data: match[2] };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download generated image: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { mimeType: response.headers.get("content-type") || "image/png", data: buffer.toString("base64") };
}

// ---------- Web search ----------

/** @returns {Promise<{answer: string, sources: {title: string, url: string, snippet?: string, published?: string}[]}>} */
async function webSearch({ query, numResults = 5 }) {
  const settings = await getSettings();
  const { provider, model } = settings.tasks.search;
  if (provider === "exa") return exaSearch({ query, numResults });
  if (provider === "gemini") return geminiSearch({ model, query });
  if (provider === "openai") return openaiSearch({ model, query });
  if (provider === "openrouter") return openrouterSearch({ model, query, numResults });
  throw new Error(`Provider ${provider} cannot search.`);
}

const SEARCH_PROMPT = (query) =>
  `Search the web and write a short, factual research brief (under 250 words) answering: ${query}\nUse bullet points for key facts. Mention dates for anything time-sensitive.`;

async function geminiSearch({ model, query }) {
  const key = await requireApiKey("gemini");
  const data = await postJson(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    { contents: [{ role: "user", parts: [{ text: SEARCH_PROMPT(query) }] }], tools: [{ google_search: {} }] },
    { "x-goog-api-key": key },
  );
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: chunk.web.title || hostname(uri) || "Source", url: uri });
  }
  return { answer: collectGeminiText(data), sources };
}

async function openaiSearch({ model, query }) {
  const key = await requireApiKey("openai");
  const data = await postJson(`${OPENAI_BASE}/responses`, { model, tools: [{ type: "web_search" }], input: SEARCH_PROMPT(query) }, { Authorization: `Bearer ${key}` });
  let answer = data.output_text || "";
  const sources = [];
  const seen = new Set();
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (!answer && content.type === "output_text") answer += content.text || "";
      for (const annotation of content.annotations || []) {
        if (annotation.type === "url_citation" && annotation.url && !seen.has(annotation.url)) {
          seen.add(annotation.url);
          sources.push({ title: annotation.title || hostname(annotation.url), url: annotation.url });
        }
      }
    }
  }
  return { answer, sources };
}

async function openrouterSearch({ model, query, numResults }) {
  const key = await requireApiKey("openrouter");
  const data = await postJson(
    `${OPENROUTER_BASE}/chat/completions`,
    {
      model,
      messages: [{ role: "user", content: SEARCH_PROMPT(query) }],
      plugins: [{ id: "web", max_results: Math.max(1, Math.min(10, numResults)) }],
    },
    { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
  );
  const message = data?.choices?.[0]?.message || {};
  const sources = [];
  const seen = new Set();
  for (const annotation of message.annotations || []) {
    const citation = annotation.url_citation || annotation;
    if (citation?.url && !seen.has(citation.url)) {
      seen.add(citation.url);
      sources.push({ title: citation.title || hostname(citation.url), url: citation.url, snippet: citation.content });
    }
  }
  return { answer: typeof message.content === "string" ? message.content : "", sources };
}

async function exaSearch({ query, numResults }) {
  const key = await requireApiKey("exa");
  const data = await postJson(
    "https://api.exa.ai/search",
    { query, type: "auto", numResults: Math.max(1, Math.min(10, numResults)), contents: { text: { maxCharacters: 900 } } },
    { "x-api-key": key },
  );
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    answer: "",
    sources: results.map((result) => ({
      title: result.title || result.url,
      url: result.url,
      snippet: result.text || result.summary || "",
      published: result.publishedDate || undefined,
    })),
  };
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- Vision (screen understanding) ----------

const VISION_PROMPT = (question) => `You are looking at a screenshot of a computer desktop so an assistant can operate it.
${question ? `The assistant wants to know: ${question}\n` : ""}Return JSON only, with this shape:
{"summary": "one or two sentences describing what is on screen and the answer to the question if one was asked",
 "elements": [{"label": "short name of a clickable or important element", "x": 0-1000, "y": 0-1000}]}
x and y are the CENTER of the element, normalized so 0,0 is the top-left and 1000,1000 is the bottom-right of the image.
List at most 25 elements, most relevant first. Include text fields, buttons, links, tabs and menu items that are visible.`;

/**
 * @returns {Promise<{summary: string, elements: {label: string, x: number, y: number}[]}>} normalized 0-1000 coords
 */
async function describeScreen({ imagePath, question }) {
  const settings = await getSettings();
  const { provider, model } = settings.tasks.vision;
  const inline = await fileToInline(imagePath);
  let raw = "";

  if (provider === "gemini") {
    const key = await requireApiKey("gemini");
    const data = await postJson(
      `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: inline.mimeType, data: inline.data } }, { text: VISION_PROMPT(question) }] }],
        generationConfig: { responseMimeType: "application/json" },
      },
      { "x-goog-api-key": key },
    );
    raw = collectGeminiText(data);
  } else if (provider === "openai" || provider === "openrouter") {
    const key = await requireApiKey(provider);
    const base = provider === "openai" ? OPENAI_BASE : OPENROUTER_BASE;
    const extra = provider === "openrouter" ? OPENROUTER_HEADERS : {};
    const data = await postJson(
      `${base}/chat/completions`,
      {
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_PROMPT(question) },
              { type: "image_url", image_url: { url: `data:${inline.mimeType};base64,${inline.data}` } },
            ],
          },
        ],
      },
      { Authorization: `Bearer ${key}`, ...extra },
    );
    const content = data?.choices?.[0]?.message?.content;
    raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text || "").join("") : "";
  } else {
    throw new Error(`Provider ${provider} cannot read screenshots.`);
  }

  return parseVisionJson(raw);
}

function parseVisionJson(raw) {
  const cleaned = String(raw || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  try {
    const parsed = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
    const elements = Array.isArray(parsed.elements)
      ? parsed.elements
          .map((element) => ({ label: String(element.label || "").slice(0, 80), x: Number(element.x), y: Number(element.y) }))
          .filter((element) => element.label && Number.isFinite(element.x) && Number.isFinite(element.y))
          .slice(0, 25)
      : [];
    return { summary: String(parsed.summary || ""), elements };
  } catch {
    return { summary: cleaned.slice(0, 800), elements: [] };
  }
}

// ---------- Model checks (settings panel "Check" button; no generation cost) ----------

async function checkModel(provider, model) {
  const key = await requireApiKey(provider);
  if (provider === "gemini") {
    const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": key } });
    if (!response.ok) throw new Error(`Gemini: ${response.status} ${summarizeError(await response.text())}`);
    const data = await response.json();
    return `Found ${data.displayName || model}.`;
  }
  if (provider === "openai") {
    const response = await fetch(`${OPENAI_BASE}/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`OpenAI: ${response.status} ${summarizeError(await response.text())}`);
    return `Found ${model}.`;
  }
  if (provider === "openrouter") {
    const lists = await Promise.all(
      [`${OPENROUTER_BASE}/models`, `${OPENROUTER_BASE}/models?output_modalities=image`].map(async (url) => {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data.data) ? data.data : [];
      }),
    );
    const found = lists.flat().find((item) => item.id === model || item.canonical_slug === model);
    if (!found) throw new Error(`OpenRouter has no model with ID "${model}". Check the ID on openrouter.ai/models.`);
    return `Found ${found.name || model}.`;
  }
  if (provider === "exa") {
    await exaSearch({ query: "test", numResults: 1 });
    return "Exa key works.";
  }
  throw new Error(`Unknown provider ${provider}`);
}

module.exports = {
  generateImage,
  webSearch,
  describeScreen,
  checkModel,
  extForMime,
  mimeForPath,
  hostname,
  requireApiKey,
};

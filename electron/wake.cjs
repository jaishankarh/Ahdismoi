// Wake-word support in the main process.
// - Serves wake-word model files to the page over a private "ricky-asset://" protocol.
// - Vosk: downloads the speech model once (zip or tar.gz), converts zips to the tar.gz layout
//   vosk-browser expects, and caches it in the user-data folder.
// - Porcupine: returns the AccessKey, the user's trained keyword file (.ppn) and the bundled
//   language model (.pv) as base64 for the in-page engine.

const { app, dialog, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { unzipSync } = require("fflate");
const { getApiKey, getSettings, saveSettings } = require("./settings.cjs");

const SCHEME = "ricky-asset";

// Must run before app 'ready'.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

function wakeDir() {
  return path.join(app.getPath("userData"), "wake");
}

function handleProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // ricky-asset://models/<file>
    const file = path.basename(decodeURIComponent(url.pathname));
    const full = path.join(wakeDir(), "models", file);
    try {
      const data = await fs.readFile(full);
      return new Response(data, {
        headers: { "Content-Type": "application/gzip", "Access-Control-Allow-Origin": "*", "Content-Length": String(data.length) },
      });
    } catch {
      return new Response("Not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  });
}

// ---------- Vosk ----------

async function prepareVoskModel(onProgress) {
  const settings = await getSettings();
  const sourceUrl = settings.wake.voskModelUrl;
  const id = crypto.createHash("sha1").update(sourceUrl).digest("hex").slice(0, 12);
  const fileName = `vosk-${id}.tar.gz`;
  const target = path.join(wakeDir(), "models", fileName);
  const modelUrl = `${SCHEME}://models/${fileName}`;

  try {
    await fs.access(target);
    return { modelUrl, cached: true };
  } catch {
    // not downloaded yet
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const buffer = await download(sourceUrl, onProgress);
  onProgress?.({ phase: "preparing" });
  const lower = sourceUrl.toLowerCase().split("?")[0];
  let tarGz;
  if (lower.endsWith(".zip")) {
    tarGz = zipToTarGz(buffer);
  } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    tarGz = buffer;
  } else {
    throw new Error("The Vosk model URL must point to a .zip or .tar.gz file.");
  }
  const tmp = `${target}.part`;
  await fs.writeFile(tmp, tarGz);
  await fs.rename(tmp, target);
  return { modelUrl, cached: false };
}

async function download(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download the wake-word model (${response.status}) from ${url}`);
  const total = Number(response.headers.get("content-length") || 0);
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    if (Date.now() - lastReport > 250) {
      lastReport = Date.now();
      onProgress?.({ phase: "downloading", received, total });
    }
  }
  onProgress?.({ phase: "downloading", received, total: total || received });
  return Buffer.concat(chunks);
}

/** Convert a zip archive into a gzipped ustar archive (vosk-browser only reads tar.gz). */
function zipToTarGz(zipBuffer) {
  const entries = unzipSync(new Uint8Array(zipBuffer));
  const blocks = [];
  const names = Object.keys(entries)
    .filter((name) => !name.startsWith("__MACOSX/") && !path.posix.basename(name).startsWith("._"))
    .sort();
  const dirs = new Set();
  for (const name of names) {
    const parts = name.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join("/")}/`);
    if (name.endsWith("/")) dirs.add(name);
  }
  for (const dir of [...dirs].sort()) blocks.push(tarHeader(dir, 0, "5"));
  for (const name of names) {
    if (name.endsWith("/")) continue;
    const data = Buffer.from(entries[name]);
    blocks.push(tarHeader(name, data.length, "0"), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 6 });
}

function tarHeader(name, size, type) {
  const header = Buffer.alloc(512);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const cut = name.lastIndexOf("/", name.length - 2 - (name.endsWith("/") ? 0 : 0));
    prefix = name.slice(0, cut);
    fileName = name.slice(cut + 1);
    if (Buffer.byteLength(fileName) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path too long for tar: ${name}`);
  }
  header.write(fileName, 0, 100, "utf8");
  header.write(type === "5" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function clearVoskCache() {
  await fs.rm(path.join(wakeDir(), "models"), { recursive: true, force: true });
}

// ---------- Porcupine ----------

async function choosePorcupineKeyword(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "Choose your Porcupine wake-word file",
    filters: [{ name: "Porcupine keyword", extensions: ["ppn"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const source = result.filePaths[0];
  await fs.mkdir(wakeDir(), { recursive: true });
  await fs.copyFile(source, path.join(wakeDir(), "keyword.ppn"));
  return saveSettings({ wake: { porcupineKeywordName: path.basename(source) } });
}

async function porcupineAssets() {
  const settings = await getSettings();
  const accessKey = await getApiKey("picovoice");
  if (!accessKey) throw new Error("Add your Picovoice AccessKey in Settings → API keys, or switch the wake-word engine to Vosk.");
  let keyword;
  try {
    keyword = await fs.readFile(path.join(wakeDir(), "keyword.ppn"));
  } catch {
    throw new Error("Choose your trained .ppn wake-word file in Settings → Wake word, or switch the engine to Vosk.");
  }
  const modelFile = settings.wake.porcupineLanguage === "en" ? "porcupine_params.pv" : "porcupine_params_fr.pv";
  const model = await fs.readFile(path.join(__dirname, "assets", modelFile));
  return {
    accessKey,
    keywordBase64: keyword.toString("base64"),
    modelBase64: model.toString("base64"),
    modelVersion: `${settings.wake.porcupineLanguage}-1`,
  };
}

module.exports = { registerScheme, handleProtocol, prepareVoskModel, clearVoskCache, choosePorcupineKeyword, porcupineAssets, zipToTarGz };

const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const settingsStore = require("./settings.cjs");
const providers = require("./providers.cjs");
const computer = require("./computer.cjs");
const { createOpenAISession, GeminiLiveSession } = require("./voice.cjs");
const wake = require("./wake.cjs");

wake.registerScheme();

let geminiSession = null;

// On Wayland, apps can't position their own windows or stay on top, which the floating
// computer-use face needs. Run through XWayland instead (it's on every mainstream desktop).
if (computer.detectPlatform() === "wayland" && !process.env.RICKY_NATIVE_WAYLAND) {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}
const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "ricky-db.json");
let currentMode = "display";
let mainWindow = null;
let normalWindowBounds = null;
let dbWriteQueue = Promise.resolve();

function buildInstructions(userName, assistantName = "Ahdismoi", wakeEnabled = false) {
  const name = userName || "the user";
  const me = assistantName || "Ahdismoi";
  const wakeSection = wakeEnabled
    ? `

# Wake Word Mode
Wake-word mode is on. The user wakes you by saying your name ("${me}"). Audio you receive may begin with the wake word; ignore it and respond to what follows. If they only said the wake word, reply with a very short "Yes?" or similar.
When the user ends the conversation (e.g. "that's all", "thanks, bye", "merci", "go to sleep"), say a brief goodbye and call go_to_sleep.`
    : "";
  return `# Role and Objective
You are ${me}, ${name}'s desktop AI operator.${me.toLowerCase() === "ahdismoi" ? ' Your name is pronounced the French way: "ah-dis-moi" (from "Ah, dis-moi", "Ah, tell me").' : ""} You speak through realtime voice and can use local tools.

# Personality and Tone
Concise, calm, useful. Talk like a smart operator, not a chatbot.

# Modes
- Display mode is the default. Use the app and artifact panel to show things. Do not control the computer.
- Computer use mode allows desktop control tools. Only the user can turn it on, with the toggle in the app. If they ask you to control the computer while in display mode, call set_mode with mode "computer": that shows them a button to approve. Then wait for them to confirm before using computer tools.

# Computer Use
- Before clicking, call screen_snapshot (optionally with a question like "where is the search box?"). It returns a summary and a list of on-screen elements with click coordinates. Click using those coordinates, then take another snapshot to confirm the result.
- Prefer keyboard shortcuts (computer_hotkey) and typing over clicking when they are reliable.

# Tool Behavior
- Use read-only tools when the user's intent is clear.
- When ${name} says "show me the menu", "show me what I can do", or asks what you can do, call show_menu immediately.
- For web search, notes, charts, records, image generation, and artifact display, act directly when the request is clear.
- For thumbnail creation/editing, always use the thumbnail board tools, never generic image_generate and never artifact_show with imageLoading. Generate exactly one 16:9 image per request. Never generate multiple unless ${name} separately asks again. Every generate/edit request gets a permanent database number that never changes, like #18 then #19 then #20. Do not renumber visible grid positions. Show paginated 3x3 pages of the permanent numbers. Do not show a standalone fullscreen loading animation for thumbnails. Use ${name}'s wording literally: do not invent elaborate extra concepts, fake text, or extra thumbnail ideas. For edits, use the exact existing numbered/selected image as input and make only the requested change.
- The thumbnail board persists across sessions. If ${name} references thumbnail #N, trust that permanent number and call the matching thumbnail tool. Do not say you cannot see old thumbnails. Use thumbnail_grid to refresh state or change pages if needed.
- When a thumbnail finishes generating or editing, do not announce it verbally. The UI updates silently.
- For sending messages, deleting data, buying things, account changes, sharing private information, or anything irreversible, summarize the action and ask for explicit confirmation before calling the modifying tool.
- If a tool requires a confirmed field, set confirmed to true only after the user clearly confirms.
- Typing text and pressing Enter/Return in computer use mode are allowed without extra approval when ${name} asks you to type or send a prompt. Ask first before clicking controls or taking actions that delete, purchase, change settings, or expose private information.
- Explain what you are doing in one short sentence before longer tool work. Do not over-explain.

# Artifacts
Use artifacts for menus, web results, graphics, notes, database tables, code snippets, and task progress. If the user asks to show, hide, or fullscreen the artifacts panel, call the artifact tool.
For Mermaid charts, keep syntax simple: start with flowchart TD, avoid markdown fences, avoid parentheses in node labels, and use short alphanumeric node IDs.

# Audio
Let the user interrupt. If audio is unclear, ask one short clarifying question instead of guessing.${wakeSection}`;
}

const toolSpecs = [
  {
    type: "function",
    name: "set_mode",
    description: "Switch to display mode, or ask the user to enable computer use mode. Only the user can actually turn computer mode on; calling this with mode computer shows them an approve button.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["display", "computer"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "artifact_show",
    description: "Show structured content in the artifact panel. Use for notes, menus, web results, charts, code, task progress, and visual content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["text", "markdown", "code", "table", "notes", "mermaid", "image", "imageLoading", "thumbnailBoard", "progress"] },
        content: { type: "string" },
        language: { type: "string" },
        fullscreen: { type: "boolean" },
      },
      required: ["title", "kind", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "show_menu",
    description: "Show the assistant's capability menu in the artifact panel. Call this when the user asks 'show me the menu', 'show me what I can do', or asks what you can do.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "go_to_sleep",
    description: "In wake-word mode, stop listening and go back to waiting for the wake word. Call after a brief goodbye when the user ends the conversation.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web. Use for current facts, links, research, and source gathering. Results are shown as a clean Markdown research brief in the artifact panel.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        numResults: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "image_generate",
    description: "Generate a standalone image and show it in the artifact panel. Do not use for YouTube thumbnails, thumbnail edits, or the thumbnail board; use thumbnail_generate or thumbnail_edit instead.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024"] },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_reference_add",
    description: "Add a local image file as a reference image for making thumbnails of the user. Use when the user gives a file path to a photo of themselves.",
    parameters: {
      type: "object",
      properties: {
        imagePath: { type: "string" },
        label: { type: "string" },
      },
      required: ["imagePath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_generate",
    description: "Generate exactly one 16:9 YouTube thumbnail into the persistent paginated thumbnail board. Uses the user's reference images if available. Assigns a new permanent number that never changes. Never generate multiple at once.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_edit",
    description: "Edit one existing thumbnail by permanent thumbnail number, or edit the currently selected thumbnail if number is omitted. Use this whenever the user says 'edit number 20' or 'edit this'. The edited result gets a new permanent number.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        number: { type: "number", minimum: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_select",
    description: "Select a permanent numbered thumbnail and show it fullscreen. Use when the user says 'pull up number 20', 'show number 20', 'open number 20', or 'select number 20'.",
    parameters: {
      type: "object",
      properties: {
        number: { type: "number", minimum: 1 },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "thumbnail_grid",
    description: "Show one paginated 3x3 page of the persistent thumbnail board and return compact board state. Use to refresh state, change pages, or when the user asks what thumbnails exist.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mermaid_render",
    description: "Render a Mermaid chart in the artifact panel. Provide only Mermaid code, no markdown fences. Prefer flowchart TD with quoted labels.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        diagram: { type: "string" },
      },
      required: ["title", "diagram"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "note_add",
    description: "Add a note to the local notes list.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_create",
    description: "Create a local database record.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
      },
      required: ["collection", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_search",
    description: "Search local database records by collection and query.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string" },
        query: { type: "string" },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_update",
    description: "Update a local database record. Ask for confirmation first if the change is sensitive or destructive.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "records_delete",
    description: "Delete a local database record. Always ask the user for explicit confirmation first, then call with confirmed true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["id", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_open_app",
    description: "Open an installed desktop app by name (e.g. Firefox, Notes, Terminal, Visual Studio Code). Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        appName: { type: "string" },
      },
      required: ["appName"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_type_text",
    description: "Type text into the focused app. Requires computer mode. Do not ask for extra confirmation just to type.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_press_key",
    description: "Press a keyboard key in the focused app. Requires computer mode. Use enter after typing when the user asks to send a prompt.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", enum: ["enter", "tab", "escape", "backspace", "delete", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"] },
        repeat: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_hotkey",
    description: "Press a keyboard shortcut, e.g. modifiers [\"cmd\"] + key \"l\" to focus a browser address bar. \"cmd\" means Command on macOS and Ctrl on Linux. Requires computer mode. Ask first for shortcuts that close, delete, or quit.",
    parameters: {
      type: "object",
      properties: {
        modifiers: { type: "array", items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift", "super"] } },
        key: { type: "string", description: "A single letter or digit, or a key name like enter, tab, escape, up, f5." },
        confirmed: { type: "boolean" },
      },
      required: ["modifiers", "key"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_click",
    description: "Click at screen coordinates taken from screen_snapshot. Requires computer mode. Ask for confirmation before clicking buttons that send, delete, buy, submit, or change settings.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
        confirmed: { type: "boolean" },
        risk: { type: "string", enum: ["low", "may_send_or_modify", "private_or_sensitive"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "computer_scroll",
    description: "Scroll the app under the mouse pointer (on macOS: the focused app, using arrow keys). Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "screen_snapshot",
    description: "Look at the screen. Returns a summary and a list of visible elements with click coordinates. Pass a question to focus it, e.g. 'where is the send button?'. Requires computer mode.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "ui_inspect",
    description: "Get the focused app and window title (limited on Linux Wayland). Requires computer mode.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

async function ensureData() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(defaultDb(), null, 2));
  }
}

async function readDb() {
  await ensureData();
  const raw = await fs.readFile(dbPath, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  await ensureData();
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function updateDb(mutator) {
  const operation = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return { db, result };
  });
  dbWriteQueue = operation.catch(() => {});
  return operation;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaultDb() {
  return {
    notes: [],
    records: [],
    thumbnailBoard: {
      references: [],
      images: [],
      nextNumber: 1,
      page: 1,
      pageSize: 9,
      selectedId: null,
      view: "grid",
    },
  };
}

function normalizeDb(db) {
  const next = db && typeof db === "object" ? db : defaultDb();
  if (!Array.isArray(next.notes)) next.notes = [];
  if (!Array.isArray(next.records)) next.records = [];
  if (!next.thumbnailBoard || typeof next.thumbnailBoard !== "object") {
    next.thumbnailBoard = defaultDb().thumbnailBoard;
  }
  if (!Array.isArray(next.thumbnailBoard.references)) next.thumbnailBoard.references = [];
  if (!Array.isArray(next.thumbnailBoard.images)) next.thumbnailBoard.images = [];
  let maxNumber = 0;
  for (const image of [...next.thumbnailBoard.images].reverse()) {
    if (!Number.isInteger(image.number) || image.number < 1) image.number = maxNumber + 1;
    maxNumber = Math.max(maxNumber, image.number);
  }
  if (!Number.isInteger(next.thumbnailBoard.nextNumber) || next.thumbnailBoard.nextNumber <= maxNumber) {
    next.thumbnailBoard.nextNumber = maxNumber + 1;
  }
  if (!Number.isInteger(next.thumbnailBoard.page) || next.thumbnailBoard.page < 1) next.thumbnailBoard.page = 1;
  if (!Number.isInteger(next.thumbnailBoard.pageSize) || next.thumbnailBoard.pageSize < 1) next.thumbnailBoard.pageSize = 9;
  if (typeof next.thumbnailBoard.view !== "string") next.thumbnailBoard.view = "grid";
  if (!("selectedId" in next.thumbnailBoard)) next.thumbnailBoard.selectedId = null;
  return next;
}

async function clearStartupLoadingThumbnails() {
  const db = await readDb();
  const before = db.thumbnailBoard.images.length;
  db.thumbnailBoard.images = db.thumbnailBoard.images.filter((image) => image.status !== "loading");
  if (db.thumbnailBoard.images.length !== before) {
    db.thumbnailBoard.selectedId = null;
    db.thumbnailBoard.view = "grid";
    await writeDb(db);
  }
}

function requireComputerMode() {
  if (currentMode !== "computer") {
    return {
      ok: false,
      needsMode: "computer",
      message: "Computer control is off. Call set_mode with mode computer so the user can approve it with the toggle.",
    };
  }
  return null;
}

function requiresConfirmation(args) {
  return args.confirmed !== true && (args.risk === "may_send_or_modify" || args.risk === "private_or_sensitive");
}

async function createWindow() {
  computer.init({ screen, desktopCapturer });
  await ensureData();
  await clearStartupLoadingThumbnails();
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    title: "Ahdismoi",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    icon: nativeImage.createEmpty(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  // Links (e.g. "Get key", search sources) open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(process.cwd(), "dist", "index.html"));
  }
}

function setWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mode === "computer") {
    const currentBounds = mainWindow.getBounds();
    if (currentBounds.width > 400 && currentBounds.height > 400) {
      normalWindowBounds = currentBounds;
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint) || screen.getDisplayMatching(currentBounds);
    const { workArea } = targetDisplay;
    const miniSize = 190;
    const margin = 18;
    mainWindow.setMinimumSize(150, 150);
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, "floating");
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setBounds({
      x: workArea.x + margin,
      y: workArea.y + workArea.height - miniSize - margin,
      width: miniSize,
      height: miniSize,
    });
    return;
  }

  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(420, 520);
  if (normalWindowBounds) {
    mainWindow.setBounds(normalWindowBounds);
  } else {
    mainWindow.setBounds({ width: 1120, height: 760 });
    mainWindow.center();
  }
}

ipcMain.handle("tools:list", () => toolSpecs);

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setMode(mode) {
  currentMode = mode === "computer" ? "computer" : "display";
  setWindowMode(currentMode);
  sendToRenderer("mode:changed", currentMode);
  return currentMode;
}

async function sessionInstructions() {
  const settings = await settingsStore.getSettings();
  const db = await readDb();
  return `${buildInstructions(settings.userName, settings.assistantName, settings.wake.enabled)}\n\n${buildThumbnailBoardInstructions(db, settings.userName || "the user")}`;
}

// Only the renderer's own UI (a user click) can switch into computer mode.
ipcMain.handle("mode:set", (_event, mode) => ({ mode: setMode(mode) }));
ipcMain.handle("mode:get", () => currentMode);

ipcMain.handle("voice:start", async () => {
  const settings = await settingsStore.getSettings();
  const instructions = await sessionInstructions();
  if (settings.tasks.voice.provider === "openai") {
    return await createOpenAISession({ instructions, tools: toolSpecs });
  }
  geminiSession?.close();
  const session = new GeminiLiveSession({
    send: sendToRenderer,
    onClose: () => {
      if (geminiSession === session) geminiSession = null;
    },
  });
  geminiSession = session;
  try {
    return await session.start({ instructions, tools: toolSpecs });
  } catch (error) {
    session.close();
    if (geminiSession === session) geminiSession = null;
    throw error;
  }
});

ipcMain.on("voice:gemini-send", (_event, message) => {
  geminiSession?.sendClient(message);
});

ipcMain.handle("voice:stop", () => {
  geminiSession?.close();
  geminiSession = null;
  return true;
});

ipcMain.handle("settings:get", async () => ({
  settings: await settingsStore.getSettings(),
  tasks: settingsStore.TASKS,
  providers: settingsStore.PROVIDERS,
  voices: settingsStore.VOICE_PRESETS,
  keys: await settingsStore.keyStatus(),
  encryption: settingsStore.encryptionInfo(),
  platform: process.platform,
}));

ipcMain.handle("settings:save", async (_event, partial) => settingsStore.saveSettings(partial));

ipcMain.handle("settings:set-key", async (_event, { provider, value }) => {
  await settingsStore.setApiKey(provider, value);
  return settingsStore.keyStatus();
});

ipcMain.handle("settings:check-model", async (_event, { provider, model }) => {
  try {
    return { ok: true, message: await providers.checkModel(provider, model) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("computer:status", async () => computer.status());

ipcMain.handle("wake:prepare-vosk", async () =>
  wake.prepareVoskModel((progress) => sendToRenderer("wake:progress", progress)),
);
ipcMain.handle("wake:clear-vosk", async () => wake.clearVoskCache());
ipcMain.handle("wake:porcupine-assets", async () => wake.porcupineAssets());
ipcMain.handle("wake:choose-keyword", async () => wake.choosePorcupineKeyword(mainWindow));

ipcMain.handle("tools:execute", async (_event, toolCall) => {
  const name = String(toolCall?.name || "");
  const args = asObject(toolCall?.arguments);

  try {
    if (name === "set_mode") {
      if (args.mode === "computer" && currentMode !== "computer") {
        sendToRenderer("mode:request", { reason: String(args.reason || "") });
        return {
          ok: false,
          needsUserApproval: true,
          message: "Only the user can turn on computer control. An 'Allow computer control' button is now showing in the app; ask them to click it, then continue.",
        };
      }
      const mode = setMode(args.mode === "computer" ? "computer" : "display");
      return {
        ok: true,
        mode,
        artifact: { title: "Mode", kind: "progress", content: `Mode is ${mode === "computer" ? "computer use" : "display"}.` },
      };
    }

    if (name === "go_to_sleep") {
      return { ok: true, sleep: true, message: "Going back to sleep after you finish speaking." };
    }

    if (name === "artifact_show") {
      return { ok: true, artifact: args };
    }

    if (name === "show_menu") {
      return {
        ok: true,
        artifact: {
          title: "Menu",
          kind: "markdown",
          content: buildMenuMarkdown((await settingsStore.getSettings()).assistantName),
        },
      };
    }

    if (name === "web_search") {
      return await webSearch(args);
    }

    if (name === "image_generate") {
      return await generateImage(args);
    }

    if (name === "thumbnail_loading_prepare") {
      return await thumbnailLoadingPrepare(args);
    }

    if (name === "thumbnail_reference_add") {
      return await thumbnailReferenceAdd(args);
    }

    if (name === "thumbnail_generate") {
      return await thumbnailGenerate(args);
    }

    if (name === "thumbnail_edit") {
      return await thumbnailEdit(args);
    }

    if (name === "thumbnail_select") {
      return await thumbnailSelect(args);
    }

    if (name === "thumbnail_grid") {
      const { db } = await updateDb(async (currentDb) => {
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = pageForArgs(args);
      });
      return { ok: true, board: thumbnailBoardSummary(db), artifact: await thumbnailBoardArtifact(db, "grid") };
    }

    if (name === "mermaid_render") {
      const diagram = normalizeMermaidDiagram(String(args.diagram || ""), String(args.title || "Mermaid chart"));
      return {
        ok: true,
        artifact: {
          title: String(args.title || "Mermaid chart"),
          kind: "mermaid",
          content: diagram,
        },
      };
    }

    if (name === "note_add") {
      const db = await readDb();
      const note = {
        id: crypto.randomUUID(),
        text: String(args.text || ""),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        createdAt: new Date().toISOString(),
      };
      db.notes.unshift(note);
      await writeDb(db);
      return {
        ok: true,
        note,
        artifact: {
          title: "Fun Notes",
          kind: "notes",
          content: JSON.stringify(db.notes.slice(0, 20), null, 2),
        },
      };
    }

    if (name === "records_create") {
      const db = await readDb();
      const record = {
        id: crypto.randomUUID(),
        collection: String(args.collection || "default"),
        title: String(args.title || "Untitled"),
        fields: asObject(args.fields),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.records.unshift(record);
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_search") {
      const db = await readDb();
      const collection = String(args.collection || "default");
      const query = String(args.query || "").toLowerCase();
      const records = db.records.filter((record) => {
        if (record.collection !== collection) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return { ok: true, records, artifact: recordsArtifact(records, collection) };
    }

    if (name === "records_update") {
      const db = await readDb();
      const record = db.records.find((item) => item.id === args.id);
      if (!record) return { ok: false, error: "Record not found." };
      record.title = typeof args.title === "string" ? args.title : record.title;
      record.fields = { ...record.fields, ...asObject(args.fields) };
      record.updatedAt = new Date().toISOString();
      await writeDb(db);
      return { ok: true, record, artifact: recordsArtifact(db.records, record.collection) };
    }

    if (name === "records_delete") {
      if (args.confirmed !== true) {
        return { ok: false, requiresConfirmation: true, message: "Explicit confirmation is required before deleting a record." };
      }
      const db = await readDb();
      const before = db.records.length;
      db.records = db.records.filter((record) => record.id !== args.id);
      await writeDb(db);
      return { ok: true, deleted: before !== db.records.length, artifact: recordsArtifact(db.records, "All Records") };
    }

    if (name.startsWith("computer_") || name === "screen_snapshot" || name === "ui_inspect") {
      const blocked = requireComputerMode();
      if (blocked) return blocked;
      return await runComputerTool(name, args);
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

async function runComputerTool(name, args) {
  const backend = computer.backend();
  if (!backend.typeText) {
    return { ok: false, error: `Computer control is not supported on ${process.platform}.` };
  }

  if (name === "computer_open_app") {
    const appName = String(args.appName || "").trim();
    if (!appName) return { ok: false, error: "appName is required." };
    await backend.openApp(appName);
    return { ok: true, message: `Opened ${appName}.` };
  }

  if (name === "computer_type_text") {
    if (requiresConfirmation(args)) {
      return { ok: false, requiresConfirmation: true, message: "Confirmation required before typing sensitive or sending text." };
    }
    await backend.typeText(String(args.text || ""));
    return { ok: true, message: "Typed text into the focused app." };
  }

  if (name === "computer_press_key") {
    const key = computer.normalizeKey(args.key);
    if (!key) return { ok: false, error: `Unsupported key: ${args.key}` };
    const repeat = Math.max(1, Math.min(20, Number(args.repeat || 1)));
    await backend.pressKey(key, repeat);
    return { ok: true, message: `Pressed ${key}.` };
  }

  if (name === "computer_hotkey") {
    const modifiers = (Array.isArray(args.modifiers) ? args.modifiers : [])
      .map((mod) => String(mod).toLowerCase())
      .filter((mod) => computer.MODIFIERS.includes(mod));
    const key = String(args.key || "").toLowerCase().trim();
    if (!key) return { ok: false, error: "key is required." };
    const dangerous = modifiers.length > 0 && ["q", "w", "f4", "delete", "backspace"].includes(key);
    if (dangerous && args.confirmed !== true) {
      return { ok: false, requiresConfirmation: true, message: "That shortcut can close or delete things. Confirm with the user, then call again with confirmed true." };
    }
    await backend.hotkey(modifiers, key);
    return { ok: true, message: `Pressed ${[...modifiers, key].join("+")}.` };
  }

  if (name === "computer_click") {
    if (requiresConfirmation(args)) {
      return { ok: false, requiresConfirmation: true, message: "Confirmation required before clicking a risky target." };
    }
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "x and y must be numbers." };
    await backend.click(x, y, String(args.button || "left"), args.double === true);
    return { ok: true, message: `Clicked ${Math.round(x)}, ${Math.round(y)}.` };
  }

  if (name === "computer_scroll") {
    const direction = ["up", "down", "left", "right"].includes(args.direction) ? args.direction : "down";
    const amount = Math.max(1, Math.min(20, Number(args.amount || 4)));
    await backend.scroll(direction, amount);
    return { ok: true, message: `Scrolled ${direction}.` };
  }

  if (name === "screen_snapshot") {
    await fs.mkdir(dataDir, { recursive: true });
    const screenshotPath = path.join(dataDir, `screenshot-${Date.now()}.png`);
    // Hide Ricky's own mini window so it doesn't cover what we're looking at.
    const hidden = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    // setOpacity is a no-op on Linux, so hide the window there instead (showInactive keeps
    // keyboard focus on the app being controlled).
    const useHide = process.platform === "linux";
    if (hidden) useHide ? mainWindow.hide() : mainWindow.setOpacity(0);
    try {
      await new Promise((resolve) => setTimeout(resolve, hidden ? 180 : 0));
      await backend.screenshot(screenshotPath);
    } finally {
      if (hidden) useHide ? mainWindow.showInactive() : mainWindow.setOpacity(1);
    }
    const dataUrl = await imageDataUrl(screenshotPath);
    const artifact = { title: "Screen Snapshot", kind: "image", content: dataUrl };

    let vision;
    try {
      vision = await providers.describeScreen({ imagePath: screenshotPath, question: String(args.question || "") });
    } catch (error) {
      return {
        ok: false,
        error: `Took the screenshot but the screen-understanding model failed: ${error instanceof Error ? error.message : String(error)}`,
        artifact,
      };
    } finally {
      pruneScreenshots().catch(() => {});
    }

    const space = await backend.screenSize();
    const elements = vision.elements.map((element) => ({
      label: element.label,
      x: Math.round((Math.max(0, Math.min(1000, element.x)) / 1000) * space.width),
      y: Math.round((Math.max(0, Math.min(1000, element.y)) / 1000) * space.height),
    }));
    return {
      ok: true,
      summary: vision.summary,
      screen: space,
      elements,
      note: "Coordinates are ready to pass to computer_click.",
      artifact,
    };
  }

  if (name === "ui_inspect") {
    const summary = await backend.activeWindow();
    return { ok: true, summary, artifact: { title: "UI Inspect", kind: "text", content: summary } };
  }

  return { ok: false, error: `Unknown computer tool: ${name}` };
}

// Keep only the 20 most recent screenshots on disk.
async function pruneScreenshots() {
  const files = (await fs.readdir(dataDir)).filter((file) => /^screenshot-\d+\.png$/.test(file)).sort();
  for (const file of files.slice(0, Math.max(0, files.length - 20))) {
    await fs.unlink(path.join(dataDir, file)).catch(() => {});
  }
}

async function webSearch(args) {
  const query = String(args.query || "");
  try {
    const { answer, sources } = await providers.webSearch({ query, numResults: Number(args.numResults || 5) });
    return {
      ok: true,
      answer: answer.slice(0, 1500),
      sources: sources.slice(0, 8).map((source) => ({ title: source.title, url: source.url })),
      artifact: { title: `Web Search: ${query}`, kind: "markdown", content: formatSearchMarkdown(query, answer, sources) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message,
      artifact: { title: "Web search failed", kind: "markdown", content: `# Web search failed\n\n${cleanMarkdownText(message)}\n\nCheck the search provider and API key in Settings.` },
    };
  }
}

function formatSearchMarkdown(query, answer, results) {
  const cleanQuery = query.trim() || "Search";
  if (!answer && results.length === 0) {
    return `# ${cleanQuery}\n\nNo strong web results came back for this search. Try a narrower query or a specific site.`;
  }

  const sections = results.slice(0, 8).map((result, index) => {
    const title = cleanMarkdownText(result.title || result.url || `Result ${index + 1}`);
    const url = String(result.url || "");
    const source = cleanMarkdownText(hostname(url) || "Source");
    const text = cleanMarkdownText(result.snippet || "").slice(0, 700);
    const published = result.published ? `\n- Published: ${cleanMarkdownText(result.published)}` : "";
    const link = url ? `[Open source](${url})` : "Source link unavailable";
    return `### ${index + 1}. ${title}${text ? `\n\n${text}` : ""}\n\n- Source: ${source}${published}\n- ${link}`;
  });

  const parts = [`# ${cleanQuery}`];
  if (answer) parts.push(answer.trim(), "## Sources");
  else parts.push(`Found ${results.length} source${results.length === 1 ? "" : "s"}.`);
  return [...parts, ...sections].join("\n\n");
}

function cleanMarkdownText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function buildMenuMarkdown(me = "Ahdismoi") {
  return `# ${me} Menu

Here is what you can ask me to do.

## Voice and Conversation

- Talk naturally with ${me} in realtime.
- Interrupt mid-response and ask follow-ups.
- Ask unrelated questions while tools keep running.

## Wake Word

- Turn on wake-word mode with the ear button, then say "${me}" to start talking.
- Say "that's all" or "merci" to send ${me} back to sleep.

## Artifacts Panel

- "Show me the menu."
- "Show the artifacts panel."
- "Make that fullscreen."
- Show clean research briefs, notes, code snippets, charts, task progress, images, and records.

## Web and Research

- "Search the web for ..."
- "Look up the latest on ..."
- Results render as a clean Markdown brief with source links.

## Visuals

- Generate images with the image model chosen in Settings.
- Create Mermaid charts with automatic fallback if the syntax breaks.
- Draft diagrams, code snippets, structured notes, and visual explanations.

## Notes and Records

- Add notes to the local note grid.
- Create, search, update, and confirm-delete local database records.

## Computer Use Mode

- Turn on computer control with the monitor button (only you can).
- Open apps, look at the screen, click, type, use shortcuts, scroll, and inspect the UI.
- ${me} asks before risky actions like sending, deleting, buying, changing settings, or sharing private info.

## Good Starter Prompts

- "Show me the menu."
- "Search the web for the latest AI video tools."
- "Create a chart of my workflow."
- "Add a note: follow up on the sponsor."
- "Open my browser and search for ..." (after enabling computer control)`;
}

const SIZE_TO_SHAPE = { "1024x1024": "square", "1024x1536": "portrait", "1536x1024": "landscape" };

async function generateImage(args) {
  try {
    const image = await providers.generateImage({
      task: "imageGenerate",
      prompt: String(args.prompt || ""),
      shape: SIZE_TO_SHAPE[String(args.size || "1024x1024")] || "square",
    });
    const saved = await saveImage(image, "ricky-image");
    return {
      ok: true,
      path: saved.path,
      artifact: { title: "Generated Image", kind: "image", content: saved.dataUrl },
    };
  } catch (error) {
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

function imageErrorArtifact(error) {
  return {
    ok: false,
    error,
    artifact: {
      title: "Image Generation Failed",
      kind: "markdown",
      content: `# Image generation failed\n\n${cleanMarkdownText(error)}\n\nTry a shorter prompt, or check the image model and API key in Settings.`,
    },
  };
}

async function thumbnailReferenceAdd(args) {
  const imagePath = path.resolve(String(args.imagePath || "").replace(/^file:\/\//, ""));
  try {
    await fs.access(imagePath);
  } catch {
    return imageErrorArtifact(`Reference image not found: ${imagePath}`);
  }

  const db = await readDb();
  const reference = {
    id: crypto.randomUUID(),
    path: imagePath,
    label: String(args.label || path.basename(imagePath)),
    createdAt: new Date().toISOString(),
  };
  db.thumbnailBoard.references.unshift(reference);
  await writeDb(db);
  return {
    ok: true,
    reference,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "grid"),
    message: `Added ${reference.label} as a thumbnail reference image.`,
  };
}

async function thumbnailLoadingPrepare(args) {
  const runId = crypto.randomUUID();
  const count = 1;
  const mode = args.mode === "edit" ? "edited" : "generated";
  let target = null;
  const { db } = await updateDb(async (currentDb) => {
    target = mode === "edited" ? thumbnailByNumberOrSelected(currentDb, args.number, args.targetId) : null;
    const placeholders = Array.from({ length: count }, (_unused, index) => ({
      id: crypto.randomUUID(),
      number: currentDb.thumbnailBoard.nextNumber++,
      runId,
      status: "loading",
      type: mode,
      prompt: String(args.prompt || ""),
      size: "1536x1024",
      parentId: target?.id || null,
      createdAt: new Date().toISOString(),
      loadingLabel: count > 1 ? `Generating ${index + 1}/${count}` : mode === "edited" ? "Editing" : "Generating",
    }));

    currentDb.thumbnailBoard.images.unshift(...placeholders);
    if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
      currentDb.thumbnailBoard.selectedId = null;
      currentDb.thumbnailBoard.view = "grid";
      currentDb.thumbnailBoard.page = 1;
    }
  });
  const view = db.thumbnailBoard.view === "selected" && db.thumbnailBoard.selectedId ? "selected" : "grid";
  return {
    ok: true,
    runId,
    targetId: target?.id || null,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, view),
  };
}

async function thumbnailGenerate(args) {
  try {
    const db = await readDb();
    const prompt = thumbnailPrompt(String(args.prompt || ""), db.thumbnailBoard.references.length > 0);
    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 4);

    const generated = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt,
          size,
          inputPaths: referencePaths,
        });
        return thumbnailRecord(image, args.prompt, "generated", size);
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, generated);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: generated.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailEdit(args) {
  try {
    const db = await readDb();
    const target = thumbnailByNumberOrSelected(db, args.number, args.targetId);
    if (!target) {
      return imageErrorArtifact("No thumbnail is selected. Say a number, like 'edit number two', or generate a thumbnail first.");
    }

    const size = "1536x1024";
    const count = 1;
    const referencePaths = db.thumbnailBoard.references.map((reference) => reference.path).slice(0, 3);
    const inputPaths = [target.path, ...referencePaths].filter(Boolean);
    const editPrompt = editThumbnailPrompt(String(args.prompt || ""), target.prompt || "");

    const edited = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const image = await createThumbnailImage({
          prompt: editPrompt,
          size,
          inputPaths,
        });
        return {
          ...thumbnailRecord(image, args.prompt, "edited", size),
          parentId: target.id,
        };
      }),
    );

    const { db: latestDb } = await updateDb(async (currentDb) => {
      replaceLoadingThumbnails(currentDb, args.runId, edited);
      if (currentDb.thumbnailBoard.view !== "selected" || !currentDb.thumbnailBoard.selectedId) {
        currentDb.thumbnailBoard.selectedId = null;
        currentDb.thumbnailBoard.view = "grid";
        currentDb.thumbnailBoard.page = 1;
      }
    });
    const view = latestDb.thumbnailBoard.view === "selected" && latestDb.thumbnailBoard.selectedId ? "selected" : "grid";
    return {
      ok: true,
      count: edited.length,
      board: thumbnailBoardSummary(latestDb),
      artifact: await thumbnailBoardArtifact(latestDb, view),
      silent: true,
      thumbnailReady: true,
    };
  } catch (error) {
    if (args.runId) await removeLoadingThumbnailRun(args.runId);
    return imageErrorArtifact(error instanceof Error ? error.message : String(error));
  }
}

async function thumbnailSelect(args) {
  const db = await readDb();
  const number = Number(args.number || 0);
  const selected = db.thumbnailBoard.images.find((image) => image.number === number);
  if (!selected) {
    return imageErrorArtifact(`Thumbnail number ${number} does not exist yet.`);
  }
  if (selected.status === "loading") {
    return imageErrorArtifact(`Thumbnail number ${number} is still generating.`);
  }
  db.thumbnailBoard.selectedId = selected.id;
  db.thumbnailBoard.view = "selected";
  await writeDb(db);
  return {
    ok: true,
    selected,
    selectedNumber: number,
    board: thumbnailBoardSummary(db),
    artifact: await thumbnailBoardArtifact(db, "selected"),
    message: `Selected thumbnail ${number}.`,
  };
}

async function createThumbnailImage({ prompt, inputPaths }) {
  const image = await providers.generateImage({
    task: inputPaths.length > 0 ? "imageEdit" : "imageGenerate",
    prompt,
    shape: "thumbnail",
    inputPaths,
  });
  return await saveImage(image, "thumbnail");
}

async function saveImage(image, prefix) {
  await fs.mkdir(dataDir, { recursive: true });
  const imagePath = path.join(dataDir, `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${providers.extForMime(image.mimeType)}`);
  await fs.writeFile(imagePath, Buffer.from(image.data, "base64"));
  return { path: imagePath, dataUrl: `data:${image.mimeType};base64,${image.data}` };
}

function thumbnailRecord(image, prompt, type, size) {
  return {
    id: crypto.randomUUID(),
    type,
    path: image.path,
    prompt: String(prompt || ""),
    size,
    createdAt: new Date().toISOString(),
  };
}

function thumbnailPrompt(prompt, hasReferences) {
  return [
    hasReferences ? "Use the provided reference image(s) of the person as the identity reference." : "",
    "Create one 16:9 YouTube thumbnail.",
    "Follow this request literally. Do not add extra concepts, fake UI, extra text, watermarks, or unrelated elements.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function editThumbnailPrompt(prompt, originalPrompt) {
  return [
    "Edit the provided thumbnail image.",
    "Make only this change. Preserve everything else unless the request says otherwise.",
    prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

function thumbnailByNumberOrSelected(db, number, targetId) {
  const candidate = targetId
    ? db.thumbnailBoard.images.find((image) => image.id === targetId) || null
    : number
      ? db.thumbnailBoard.images.find((image) => image.number === Number(number)) || null
      : db.thumbnailBoard.selectedId
        ? db.thumbnailBoard.images.find((image) => image.id === db.thumbnailBoard.selectedId) || null
        : null;
  if (candidate?.status === "loading") return null;
  return candidate;
}

function replaceLoadingThumbnails(db, runId, records) {
  if (!runId) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  const placeholders = db.thumbnailBoard.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => image.runId === runId && image.status === "loading");

  if (placeholders.length === 0) {
    db.thumbnailBoard.images.unshift(...records.map((record) => assignThumbnailNumber(db, record)));
    return;
  }

  for (const [recordIndex, placeholder] of placeholders.entries()) {
    const replacement = records[recordIndex];
    if (replacement) db.thumbnailBoard.images[placeholder.index] = { ...replacement, number: placeholder.image.number };
  }

  if (records.length > placeholders.length) {
    db.thumbnailBoard.images.unshift(...records.slice(placeholders.length).map((record) => assignThumbnailNumber(db, record)));
  }
}

async function removeLoadingThumbnailRun(runId) {
  await updateDb(async (db) => {
    db.thumbnailBoard.images = db.thumbnailBoard.images.filter(
      (image) => !(image.runId === runId && image.status === "loading"),
    );
    db.thumbnailBoard.view = "grid";
    if (db.thumbnailBoard.selectedId && !db.thumbnailBoard.images.some((image) => image.id === db.thumbnailBoard.selectedId)) {
      db.thumbnailBoard.selectedId = null;
    }
  });
}

function thumbnailNumber(db, id) {
  return db.thumbnailBoard.images.find((image) => image.id === id)?.number || null;
}

function assignThumbnailNumber(db, image) {
  if (Number.isInteger(image.number) && image.number > 0) return image;
  return { ...image, number: db.thumbnailBoard.nextNumber++ };
}

function pageForArgs(args) {
  const page = Number(args?.page || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function sortedThumbnailImages(db) {
  return [...db.thumbnailBoard.images].sort((a, b) => (b.number || 0) - (a.number || 0));
}

function paginatedThumbnailImages(db, page = db.thumbnailBoard.page || 1) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const start = (page - 1) * pageSize;
  return sortedThumbnailImages(db).slice(start, start + pageSize);
}

function thumbnailPageMeta(db) {
  const pageSize = db.thumbnailBoard.pageSize || 9;
  const totalImages = db.thumbnailBoard.images.length;
  return {
    page: db.thumbnailBoard.page || 1,
    pageSize,
    totalImages,
    totalPages: Math.max(1, Math.ceil(totalImages / pageSize)),
    nextNumber: db.thumbnailBoard.nextNumber,
  };
}

function thumbnailBoardSummary(db) {
  const board = db.thumbnailBoard;
  const selectedNumber = board.selectedId ? thumbnailNumber(db, board.selectedId) : null;
  const page = thumbnailPageMeta(db);
  return {
    view: board.view,
    selectedNumber,
    references: board.references.length,
    page,
    images: paginatedThumbnailImages(db, page.page).map((image) => ({
      number: image.number,
      id: image.id,
      status: image.status === "loading" ? "loading" : "ready",
      type: image.type || "thumbnail",
      prompt: image.prompt || "",
    })),
  };
}

function buildThumbnailBoardInstructions(db, name = "the user") {
  const summary = thumbnailBoardSummary(db);
  const imageLines = summary.images.length
    ? summary.images
        .map((image) => `- #${image.number}: ${image.status}${image.status === "ready" ? `, ${image.type}` : ""}${image.prompt ? `, prompt: ${image.prompt.slice(0, 120)}` : ""}`)
        .join("\n")
    : "- No generated thumbnails yet.";

  return `# Current Thumbnail Board State
Reference images loaded: ${summary.references}
Current view: ${summary.view}
Selected thumbnail number: ${summary.selectedNumber || "none"}
Current page: ${summary.page.page}/${summary.page.totalPages}
Total thumbnails: ${summary.page.totalImages}
Next new thumbnail number: ${summary.page.nextNumber}
Visible permanent thumbnail numbers:
${imageLines}

When ${name} says "pull up number N", "select N", or "show N", call thumbnail_select with that permanent number. When ${name} says "edit this", use thumbnail_edit with no number if a selected thumbnail number exists. When ${name} says "edit number N", call thumbnail_edit with that permanent number. When they ask for older thumbnails or another page, call thumbnail_grid with the requested page. Do not claim you cannot see prior thumbnails; this board state is persistent and paginated.`;
}

async function thumbnailBoardArtifact(db, view) {
  const board = db.thumbnailBoard;
  const selected = board.images.find((image) => image.id === board.selectedId) || null;
  const page = thumbnailPageMeta(db);
  const visibleImages = view === "selected" && selected ? [selected] : paginatedThumbnailImages(db, page.page);
  const images = await Promise.all(
    visibleImages.map(async (image) => {
      const src = image.path ? await imageDataUrl(image.path) : null;
      return {
        ...image,
        number: image.number,
        src,
        selected: selected?.id === image.id,
      };
    }),
  );

  return {
    title: view === "selected" && selected ? `Thumbnail ${thumbnailNumber(db, selected.id)}` : "Thumbnail Board",
    kind: "thumbnailBoard",
    fullscreen: view === "selected",
    content: JSON.stringify({
      view,
      selectedId: board.selectedId,
      references: board.references,
      page,
      images,
    }),
  };
}

async function imageDataUrl(imagePath) {
  const buffer = await fs.readFile(imagePath);
  return `data:${mimeForPath(imagePath)};base64,${buffer.toString("base64")}`;
}

function mimeForPath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function recordsArtifact(records, collection) {
  return {
    title: `Records: ${collection}`,
    kind: "table",
    content: JSON.stringify(records, null, 2),
  };
}

function normalizeMermaidDiagram(diagram, title) {
  const stripped = diagram
    .replace(/```mermaid/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!stripped) {
    return fallbackMermaidDiagram(title);
  }

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, "-")
        .replace(/\s+-->\s+/g, " --> ")
        .replace(/\s+---\s+/g, " --- "),
    );

  const hasDiagramHeader = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/i.test(
    lines[0] || "",
  );

  return hasDiagramHeader ? lines.join("\n") : `flowchart TD\n${lines.join("\n")}`;
}

function fallbackMermaidDiagram(title) {
  const safeTitle = String(title || "Chart").replace(/["<>]/g, "");
  return `flowchart TD\n  A["${safeTitle}"] --> B["Chart request received"]\n  B --> C["A safe fallback is shown if syntax fails"]`;
}

app.whenReady().then(() => {
  wake.handleProtocol();
  return createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

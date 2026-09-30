// Cross-platform computer control.
//   macOS          -> osascript (System Events), open -a, screencapture
//   Linux X11      -> xdotool, gtk-launch / .desktop files, scrot | maim | import | gnome-screenshot
//   Linux Wayland  -> ydotool (needs ydotoold), grim | gnome-screenshot | spectacle
// Every backend exposes the same functions. Coordinates are in the backend's own click space;
// screenSize() reports that space so normalized vision coordinates can be mapped onto it.

const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);

// Electron pieces are injected so this module can also be exercised from plain Node in tests.
let electron = null;
function init(deps) {
  electron = deps;
}

const KEYS = ["enter", "return", "tab", "escape", "delete", "backspace", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"];
const MODIFIERS = ["cmd", "ctrl", "alt", "shift", "super"];

async function which(bin) {
  try {
    await execFileAsync("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

function detectPlatform() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") {
    const type = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
    if (type === "wayland" || (process.env.WAYLAND_DISPLAY && type !== "x11")) return "wayland";
    return "x11";
  }
  return "unsupported";
}

// ---------------- macOS ----------------

const MAC_KEYCODES = {
  enter: 36, return: 36, tab: 48, escape: 53, delete: 117, backspace: 51, space: 49, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODS = { cmd: "command down", ctrl: "control down", alt: "option down", shift: "shift down", super: "command down" };

function appleScriptString(value) {
  return JSON.stringify(String(value)).replace(/\\\\/g, "\\");
}

async function osa(script) {
  return execFileAsync("osascript", ["-e", script]);
}

const mac = {
  name: "macOS",
  async openApp(appName) {
    await execFileAsync("open", ["-a", appName]);
  },
  async typeText(text) {
    await osa(`tell application "System Events" to keystroke ${appleScriptString(text)}`);
  },
  async pressKey(key, repeat) {
    const code = MAC_KEYCODES[key];
    await osa(`tell application "System Events" to repeat ${repeat} times\nkey code ${code}\nend repeat`);
  },
  async hotkey(modifiers, key) {
    const using = modifiers.map((mod) => MAC_MODS[mod]).filter(Boolean);
    const usingClause = using.length ? ` using {${using.join(", ")}}` : "";
    const code = MAC_KEYCODES[key];
    const action = code ? `key code ${code}` : `keystroke ${appleScriptString(key)}`;
    await osa(`tell application "System Events" to ${action}${usingClause}`);
  },
  async click(x, y, button, double) {
    // System Events can only left-click; right/double clicks are approximated.
    const times = double ? 2 : 1;
    const clause = button === "right" ? " using {control down}" : "";
    for (let i = 0; i < times; i += 1) {
      await osa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}${clause}`);
    }
  },
  async scroll(direction, amount) {
    const code = { up: 126, down: 125, left: 123, right: 124 }[direction] || 125;
    await osa(`tell application "System Events" to repeat ${amount} times\nkey code ${code}\nend repeat`);
  },
  async screenshot(file) {
    // -x: no sound, -m: main display only (matches screenSize()).
    await execFileAsync("screencapture", ["-x", "-m", file]);
  },
  async activeWindow() {
    const { stdout } = await osa(`tell application "System Events"
set frontApp to first application process whose frontmost is true
set appName to name of frontApp
set windowName to ""
try
  set windowName to name of front window of frontApp
end try
return "App: " & appName & linefeed & "Window: " & windowName
end tell`);
    return stdout.trim();
  },
  async screenSize() {
    // System Events clicks use points (logical pixels) of the main display.
    const { width, height } = electron.screen.getPrimaryDisplay().bounds;
    return { width, height };
  },
  async doctor() {
    return {
      ok: true,
      missing: [],
      notes: [
        "Grant Accessibility permission (System Settings → Privacy & Security → Accessibility) to the app running Ricky (Electron or your terminal).",
        "Grant Screen Recording permission for screenshots.",
      ],
    };
  },
};

// ---------------- Linux helpers ----------------

async function findDesktopEntry(appName) {
  const wanted = appName.toLowerCase().trim();
  const dirs = [
    path.join(os.homedir(), ".local/share/applications"),
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/var/lib/flatpak/exports/share/applications",
    path.join(os.homedir(), ".local/share/flatpak/exports/share/applications"),
    "/var/lib/snapd/desktop/applications",
  ];
  let fuzzy = null;
  for (const dir of dirs) {
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((file) => file.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const file of files) {
      let text = "";
      try {
        text = await fs.readFile(path.join(dir, file), "utf8");
      } catch {
        continue;
      }
      const section = text.split(/^\[/m).find((part) => part.startsWith("Desktop Entry]")) || text;
      if (/^NoDisplay=true/m.test(section) || /^Hidden=true/m.test(section)) continue;
      const name = (/^Name=(.*)$/m.exec(section)?.[1] || "").trim();
      const exec = (/^Exec=(.*)$/m.exec(section)?.[1] || "").trim();
      const id = file.replace(/\.desktop$/, "");
      const entry = { id, name, exec };
      if (name.toLowerCase() === wanted || id.toLowerCase() === wanted || id.toLowerCase().endsWith(`.${wanted}`)) return entry;
      if (!fuzzy && (name.toLowerCase().includes(wanted) || id.toLowerCase().includes(wanted))) fuzzy = entry;
    }
  }
  return fuzzy;
}

function splitExec(exec) {
  // Strip desktop-entry field codes (%u %F etc.) and split respecting simple quotes.
  const cleaned = exec.replace(/%[a-zA-Z%]/g, "").trim();
  const parts = cleaned.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return parts.map((part) => part.replace(/^["']|["']$/g, ""));
}

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function linuxOpenApp(appName) {
  const entry = await findDesktopEntry(appName);
  if (entry) {
    if (await which("gtk-launch")) {
      spawnDetached("gtk-launch", [entry.id]);
      return;
    }
    const [cmd, ...args] = splitExec(entry.exec);
    if (cmd) {
      spawnDetached(cmd, args);
      return;
    }
  }
  const binary = appName.toLowerCase().replace(/\s+/g, "-");
  if (await which(binary)) {
    spawnDetached(binary, []);
    return;
  }
  throw new Error(`Could not find an installed app called "${appName}".`);
}

async function linuxScreenshot(file, candidates) {
  const errors = [];
  for (const [bin, args] of candidates) {
    if (!(await which(bin))) continue;
    try {
      await execFileAsync(bin, args(file), { timeout: 15000 });
      await fs.access(file);
      return;
    } catch (error) {
      errors.push(`${bin}: ${error.message}`);
    }
  }
  // Last resort: Electron's own capture (on Wayland this goes through the desktop portal
  // and may show a one-time permission dialog).
  if (electron?.desktopCapturer) {
    const display = electron.screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const sources = await electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    });
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
    if (source && !source.thumbnail.isEmpty()) {
      await fs.writeFile(file, source.thumbnail.toPNG());
      return;
    }
  }
  throw new Error(`No screenshot tool worked. ${errors.join("; ") || "Install one of: scrot, maim, gnome-screenshot, grim, spectacle."}`);
}

async function pngSize(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(24);
    await handle.read(buffer, 0, 24, 0);
    if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

// ---------------- Linux X11 (xdotool) ----------------

const XDO_KEYS = { enter: "Return", return: "Return", tab: "Tab", escape: "Escape", delete: "Delete", backspace: "BackSpace", space: "space", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", pagedown: "Next" };
const XDO_MODS = { cmd: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift", super: "super" };

const x11 = {
  name: "Linux (X11)",
  openApp: linuxOpenApp,
  async typeText(text) {
    await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", "--", text]);
  },
  async pressKey(key, repeat) {
    await execFileAsync("xdotool", ["key", "--clearmodifiers", "--repeat", String(repeat), XDO_KEYS[key]]);
  },
  async hotkey(modifiers, key) {
    const keysym = XDO_KEYS[key] || (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key);
    const combo = [...modifiers.map((mod) => XDO_MODS[mod]), keysym].join("+");
    await execFileAsync("xdotool", ["key", "--clearmodifiers", combo]);
  },
  async click(x, y, button, double) {
    const buttonId = button === "right" ? "3" : button === "middle" ? "2" : "1";
    const args = ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y)), "click"];
    if (double) args.push("--repeat", "2", "--delay", "80");
    args.push(buttonId);
    await execFileAsync("xdotool", args);
  },
  async scroll(direction, amount) {
    const buttonId = { up: "4", down: "5", left: "6", right: "7" }[direction] || "5";
    await execFileAsync("xdotool", ["click", "--repeat", String(amount * 3), "--delay", "15", buttonId]);
  },
  async screenshot(file) {
    await linuxScreenshot(file, [
      ["scrot", (f) => ["--overwrite", f]],
      ["maim", (f) => [f]],
      ["import", (f) => ["-window", "root", f]],
      ["gnome-screenshot", (f) => ["-f", f]],
      ["spectacle", (f) => ["-b", "-n", "-f", "-o", f]],
    ]);
  },
  async activeWindow() {
    const { stdout: name } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"]);
    let appLine = "";
    try {
      const { stdout: pid } = await execFileAsync("xdotool", ["getactivewindow", "getwindowpid"]);
      const comm = await fs.readFile(`/proc/${pid.trim()}/comm`, "utf8");
      appLine = `App: ${comm.trim()}\n`;
    } catch {
      // PID not available for some windows.
    }
    return `${appLine}Window: ${name.trim()}`;
  },
  async screenSize() {
    const { stdout } = await execFileAsync("xdotool", ["getdisplaygeometry"]);
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width, height };
  },
  async doctor() {
    const missing = [];
    if (!(await which("xdotool"))) missing.push("xdotool");
    const shot = await Promise.all(["scrot", "maim", "import", "gnome-screenshot", "spectacle"].map(which));
    if (!shot.some(Boolean)) missing.push("scrot (or maim / gnome-screenshot)");
    return {
      ok: missing.length === 0,
      missing,
      notes: missing.length ? ["Run scripts/setup-linux.sh, or install the missing packages with your package manager."] : [],
    };
  },
};

// ---------------- Linux Wayland (ydotool) ----------------
// ydotool 1.x takes Linux input-event keycodes: "<code>:1" = press, "<code>:0" = release.

const EV = {
  enter: 28, return: 28, tab: 15, escape: 1, delete: 111, backspace: 14, space: 57, up: 103, down: 108, left: 105, right: 106, home: 102, end: 107, pageup: 104, pagedown: 109,
  ctrl: 29, cmd: 29, shift: 42, alt: 56, super: 125,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50, n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41, "\\": 43, ",": 51, ".": 52, "/": 53,
};

function ydotoolEnv() {
  const env = { ...process.env };
  if (!env.YDOTOOL_SOCKET && env.XDG_RUNTIME_DIR) {
    const userSocket = path.join(env.XDG_RUNTIME_DIR, ".ydotool_socket");
    if (require("node:fs").existsSync(userSocket)) env.YDOTOOL_SOCKET = userSocket;
  }
  return env;
}

async function ydo(args) {
  try {
    return await execFileAsync("ydotool", args, { timeout: 15000, env: ydotoolEnv() });
  } catch (error) {
    const text = `${error.stderr || ""}${error.message || ""}`;
    if (/socket|connect|ydotoold/i.test(text)) {
      throw new Error("ydotool could not reach its background service (ydotoold). Run scripts/setup-linux.sh or start it with: systemctl --user start ydotoold");
    }
    throw error;
  }
}

const wayland = {
  name: "Linux (Wayland)",
  openApp: linuxOpenApp,
  async typeText(text) {
    await ydo(["type", "--key-delay", "12", "--", text]);
  },
  async pressKey(key, repeat) {
    const code = EV[key];
    for (let i = 0; i < repeat; i += 1) await ydo(["key", `${code}:1`, `${code}:0`]);
  },
  async hotkey(modifiers, key) {
    const codes = [...modifiers.map((mod) => EV[mod]), EV[String(key).toLowerCase()]];
    if (codes.some((code) => code === undefined)) throw new Error(`Unsupported key combination: ${[...modifiers, key].join("+")}`);
    await ydo(["key", ...codes.map((code) => `${code}:1`), ...[...codes].reverse().map((code) => `${code}:0`)]);
  },
  async click(x, y, button, double) {
    // Absolute moves in ydotool are relative to the top-left after a reset; move far up-left first
    // so pointer acceleration can't skew the result.
    await ydo(["mousemove", "--absolute", "-x", "0", "-y", "0"]);
    await ydo(["mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))]);
    const code = button === "right" ? "0xC1" : button === "middle" ? "0xC2" : "0xC0";
    const args = ["click"];
    if (double) args.push("--repeat", "2", "--next-delay", "80");
    args.push(code);
    await ydo(args);
  },
  async scroll(direction, amount) {
    const steps = amount * 3;
    const delta = direction === "up" || direction === "left" ? 1 : -1;
    const horizontal = direction === "left" || direction === "right";
    await ydo(["mousemove", "--wheel", "-x", horizontal ? String(-delta * steps) : "0", "-y", horizontal ? "0" : String(delta * steps)]);
  },
  async screenshot(file) {
    await linuxScreenshot(file, [
      ["grim", (f) => [f]],
      ["gnome-screenshot", (f) => ["-f", f]],
      ["spectacle", (f) => ["-b", "-n", "-f", "-o", f]],
    ]);
  },
  async activeWindow() {
    // Wayland deliberately hides other apps' windows. KDE users can install kdotool.
    if (await which("kdotool")) {
      const { stdout } = await execFileAsync("kdotool", ["getactivewindow", "getwindowname"]);
      return `Window: ${stdout.trim()}`;
    }
    return "Wayland does not let apps read other windows' titles. Use screen_snapshot to see what is on screen.";
  },
  async screenSize() {
    // ydotool moves in physical pixels of the (primary) output.
    const display = electron.screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    return { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  },
  async doctor() {
    const missing = [];
    const notes = [];
    let serviceOk = true;
    if (!(await which("ydotool"))) missing.push("ydotool");
    else {
      try {
        await execFileAsync("ydotool", ["mousemove", "-x", "0", "-y", "0"], { timeout: 5000, env: ydotoolEnv() });
      } catch {
        serviceOk = false;
        notes.push("ydotool is installed but its service (ydotoold) is not reachable. Run scripts/setup-linux.sh, then log out and back in.");
      }
    }
    const shot = await Promise.all(["grim", "gnome-screenshot", "spectacle"].map(which));
    if (!shot.some(Boolean)) notes.push("No screenshot tool found; Ricky will fall back to the system screen-share dialog.");
    notes.push("Wayland hides window titles from other apps, so 'inspect UI' is limited. Screenshots still work.");
    return { ok: missing.length === 0 && serviceOk, missing, notes };
  },
};

const unsupported = {
  name: process.platform,
  async doctor() {
    return { ok: false, missing: [], notes: [`Computer control is not supported on ${process.platform} yet.`] };
  },
};

function backend() {
  const kind = detectPlatform();
  if (kind === "mac") return mac;
  if (kind === "x11") return x11;
  if (kind === "wayland") return wayland;
  return unsupported;
}

function normalizeKey(key) {
  const value = String(key || "").toLowerCase().trim();
  return KEYS.includes(value) ? value : null;
}

async function status() {
  const b = backend();
  const report = await b.doctor();
  return { platform: b.name, ...report };
}

module.exports = { init, backend, detectPlatform, status, normalizeKey, pngSize, KEYS, MODIFIERS, findDesktopEntry, splitExec };

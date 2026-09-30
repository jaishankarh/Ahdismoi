// Launch Electron against the Vite dev server. Works on macOS, Linux and Windows
// (setting env vars inline like `FOO=bar electron .` does not work in Windows shells).
const { spawn } = require("node:child_process");
const electron = require("electron");

const child = spawn(electron, [".", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173" },
});
child.on("close", (code) => process.exit(code ?? 0));

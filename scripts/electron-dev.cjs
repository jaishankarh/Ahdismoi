// Launch Electron. With no flags, points it at the Vite dev server.
// `npm start` passes --built so the packaged dist/ build loads instead.
// Works on macOS, Linux and Windows (setting env vars inline like
// `FOO=bar electron .` does not work in Windows shells).
const { spawn } = require("node:child_process");
const electron = require("electron");

// Ubuntu 24.04+ AppArmor blocks unprivileged user namespaces, and npm does not
// install chrome-sandbox as setuid-root, so Chromium aborts before the app starts.
const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
const passthrough = process.argv.slice(2).filter((arg) => arg !== "--built");
const env = { ...process.env };
if (!process.argv.includes("--built")) {
  env.VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
}

const child = spawn(electron, [".", ...sandboxArgs, ...passthrough], {
  stdio: "inherit",
  env,
});
child.on("close", (code) => process.exit(code ?? 0));

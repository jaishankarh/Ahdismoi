# Ahdismoi

*(pronounced "ah-dis-moi", French for "ah, tell me")*

A local desktop AI companion you talk to, forked from RileyJarvis. It has realtime voice, a visual artifact panel, image and thumbnail generation, web search, notes and records, and opt-in computer control on **macOS and Linux**.

Built with Electron, React, Vite and TypeScript. This fork adds:

- **Every model is a setting.** Voice, image generation, image editing, web search and screen understanding each have their own provider and model picker, and you can type any model ID.
- **Gemini by default.** It works with a single Google Gemini API key. OpenAI, OpenRouter and Exa are optional alternatives.
- **Linux support** for computer control, on both X11 and Wayland, alongside macOS.
- **Ricky can see the screen.** Screenshots go to a vision model, which returns clickable elements with coordinates, so clicks aren't blind guesses.
- **Only you can turn on computer control.** The assistant can ask, but you have to click to allow it.
- **API keys are managed in the app** and encrypted with your OS keychain.
- **Wake-word mode.** It listens on-device for "Ahdismoi", then talks. It goes back to sleep after silence or when you say "that's all".
- **The assistant's name is a setting** (default: Ahdismoi).

## Features

- Realtime speech-to-speech conversation: Gemini Live (default) or OpenAI Realtime. You can interrupt at any time.
- Animated companion face with listening, thinking, speaking and working states.
- Artifact panel for markdown, menus, notes, Mermaid diagrams, generated images, records and progress.
- YouTube thumbnail board with persistent numbered generations, edits and reference photos.
- Web search with source links: Gemini + Google Search (default), OpenAI, OpenRouter or Exa.
- Local notes and records stored under `data/`.
- Computer control: open apps, look at the screen, click, type, keyboard shortcuts, scroll and inspect windows.

## Wake-word mode

Click the **ear button** to turn it on; it stays on across restarts until you turn it off.

1. **Asleep:** the face closes its eyes, and a speech engine on your computer listens only for the wake word. No audio leaves your machine.
2. Say **"Ahdismoi"**, or "Ahdismoi, open Firefox" in one breath. A chime plays and the voice session opens. Anything you said right after the wake word is passed along, so you don't have to pause.
3. **Awake:** talk normally, and interrupt whenever you like.
4. It goes back to sleep (falling chime) after a few seconds of silence (adjustable), or when you say "that's all", "merci" or "go to sleep". An idle voice session is closed after 5 minutes asleep, so it costs nothing.

The mic button wakes it or sends it to sleep by hand.

Two wake-word engines (Settings → Wake word):

| Engine | Setup | Notes |
|---|---|---|
| **Vosk** (default) | Nothing. A ~40 MB French speech model downloads once on first use. | Free and open source. Listens for the phrase "ah dis moi". It may occasionally wake on French sentences that contain "dis-moi"; lower the sensitivity if so. |
| **Picovoice Porcupine** | Free account at [console.picovoice.ai](https://console.picovoice.ai/): copy your AccessKey, create the wake word "Ahdismoi" (French, platform Web/WASM), download the `.ppn` file. In Settings, paste the key under API keys and choose the file. | A dedicated wake-word engine. More accurate and lighter on CPU. The French and English model files are bundled. |

Tips:

- **Sensitivity:** raise it if the wake word gets missed; lower it if it wakes by itself.
- **Speakers vs headphones:** if it interrupts itself when using speakers, turn on "Pause the mic while the assistant talks".

## Default models

| Task | Default | Alternatives in Settings |
|---|---|---|
| Voice | Gemini `gemini-3.8-live` (voice "Charon") | Other Gemini Live models, OpenAI `gpt-realtime-2` |
| Image generation | Gemini `gemini-3.1-flash-image` (Nano Banana 2) | Nano Banana Pro / Lite, OpenAI `gpt-image-2`, any OpenRouter image model (FLUX.2, Qwen Image…) |
| Image editing | Gemini `gemini-3.1-flash-image` | Same as above |
| Web search | Gemini `gemini-3.8-flash` + Google Search | OpenAI (web_search tool), OpenRouter (web plugin), Exa |
| Screen understanding | Gemini `gemini-3.8-flash` | Any OpenAI or OpenRouter vision model |

Model IDs change often. If one stops working, pick another in **Settings → Models** and press **Check**. Check is a free lookup; it doesn't generate anything.

## Requirements

- macOS, or Linux (X11 or Wayland)
- Node.js 20+
- A Google Gemini API key ([get one](https://aistudio.google.com/apikey)). Optional: OpenAI, OpenRouter or Exa keys if you switch providers.

## Quick start

```bash
git clone https://github.com/jaishankarh/Ahdismoi.git
cd Ahdismoi
npm install
npm run dev
```

Click the **gear icon**, paste your Gemini API key under **API keys**, then click the **mic** button and start talking.

Alternatively, put keys in `.env.local` (see `.env.example`). Keys saved in the app take priority.

### Linux: one-time computer-control setup

```bash
npm run setup:linux
```

- **X11:** installs `xdotool` and `scrot`.
- **Wayland** (default on recent Ubuntu/Fedora): installs `ydotool` and a screenshot tool, gives your user access to `/dev/uinput`, and runs `ydotoold` as a user service. Log out and back in afterwards.
- On Wayland, Ricky's own window runs through XWayland so the floating mini-face can position itself and stay on top. Set `RICKY_NATIVE_WAYLAND=1` to opt out.
- Wayland hides other windows' titles from apps, so "inspect UI" is limited. Ricky relies on screenshots instead.

**Settings → Computer control** shows whether everything is ready and what's missing.

### macOS permissions

macOS may ask for:

- **Microphone**, for voice.
- **Accessibility**, for clicking and typing (grant it to Electron, or to the terminal you launch from).
- **Screen Recording**, for screenshots.

## Using computer control

1. Ask Ricky to do something on your computer. If computer control is off, an **Allow computer control** banner appears. You can also click the monitor button yourself.
2. The window shrinks to a floating face, and Ricky can open apps, look at the screen, click, type and use shortcuts.
3. Click the small expand button on the face to turn computer control off.

Ricky asks before clicking things that send, delete, buy or change settings, and before shortcuts that close or quit. Typing and pressing Enter don't need extra approval.

## Settings and data locations

- Settings and encrypted keys live in Electron's user-data folder: `~/Library/Application Support/rileyjarvis` on macOS, `~/.config/rileyjarvis` on Linux.
- On Linux, encryption uses GNOME Keyring or KWallet. If neither is running, the Settings panel warns you, and you can use `.env.local` instead.
- Notes, records, generated images, thumbnails and recent screenshots are in `data/`. Only the last 20 screenshots are kept.

## Costs (rough, check current pricing)

- Gemini Live audio: about $0.005/min in and $0.018/min out, plus conversation context. Google's free tier includes the Live models, with rate limits. On the free tier, Google may use your data to improve its products.
- Nano Banana 2: about $0.07 per 1K image. OpenRouter's FLUX.2 Klein: about $0.014.
- Search and vision calls use small Flash models and cost fractions of a cent each.

## Development

```bash
npm run dev         # Vite + Electron with hot reload
npm run typecheck
npm run build       # production build into dist/
npm start           # run the built app
```

## Project layout

```
electron/
  main.cjs       window, IPC, tool definitions and tool execution
  settings.cjs   settings, model presets, encrypted API keys
  providers.cjs  image / search / vision / model-check adapters (Gemini, OpenAI, OpenRouter, Exa)
  voice.cjs      OpenAI Realtime token minting; Gemini Live WebSocket with auto-resume
  computer.cjs   macOS / Linux X11 / Linux Wayland computer control backends
  wake.cjs       wake-word model download/convert, local asset protocol, Porcupine files
  assets/        bundled Porcupine language models (French, English)
src/
  lib/voice/     Gemini Live + OpenAI Realtime clients behind one interface
  lib/audio/     shared 16 kHz microphone capture + ring buffer
  lib/wake/      wake-word listener (Vosk / Porcupine) and sleep/wake controller
  components/    face, artifact panel, settings panel
scripts/
  setup-linux.sh
```

## License

MIT. Bundled Porcupine model files are © Picovoice, under Apache 2.0. The default Vosk French model (downloaded at runtime) is by Alpha Cephei, under Apache 2.0.

# Ahdismoi

*Pronounced "ah-dis-moi", French for "ah, tell me".*

Ahdismoi is a desktop AI assistant you **talk to**. It runs as a small app on your computer. You speak, and it answers out loud in real time. It can also:

- show things in a side panel: search results, notes, charts, generated images
- generate and edit images, including a numbered YouTube-thumbnail board
- search the web and cite sources
- keep local notes and simple records
- **operate your computer** on request: open apps, look at the screen, click, type and use shortcuts (macOS and Linux)
- **wait for its name.** In wake-word mode it listens on your machine for "Ahdismoi" and only then starts a conversation.

Every AI model it uses is a setting. The defaults are Google Gemini, so **one free Gemini API key is enough to start**. You can switch any task to OpenAI, OpenRouter (hundreds of models, including open-source ones) or Exa.

It's a fork of [RileyJarvis](https://github.com/rbrown101010/rileyjarvis), rebuilt to be model-agnostic, cross-platform and wake-word driven.

---

## Contents

1. [What works where](#what-works-where)
2. [How it works](#how-it-works)
3. [Installation](#installation): [macOS](#macos) · [Linux (X11)](#linux-x11) · [Linux (Wayland)](#linux-wayland) · [Windows](#windows)
4. [Getting API keys](#getting-api-keys)
5. [First run](#first-run)
6. [Using Ahdismoi](#using-ahdismoi): [controls](#the-controls) · [talking](#talking) · [wake word](#wake-word-mode) · [computer control](#computer-control) · [images and thumbnails](#images-and-thumbnails) · [search, notes, records](#search-notes-and-records)
7. [Platform notes](#platform-notes-for-everyday-use)
8. [Settings panel guide](#settings-panel-guide)
9. [Configuration file (.env)](#configuration-file-env)
10. [Costs](#costs)
11. [Privacy and security](#privacy-and-security)
12. [Troubleshooting](#troubleshooting)
13. [Development](#development)

---

## What works where

| Feature | macOS | Linux X11 | Linux Wayland | Windows |
|---|:-:|:-:|:-:|:-:|
| Voice conversation (Gemini Live / OpenAI Realtime) | ✅ | ✅ | ✅ | ✅* |
| Wake word (Vosk / Porcupine) | ✅ | ✅ | ✅ | ✅* |
| Images, thumbnails, search, notes, records, charts | ✅ | ✅ | ✅ | ✅* |
| Settings panel, encrypted API keys | ✅ Keychain | ✅ keyring | ✅ keyring | ✅* DPAPI |
| Computer control (apps, clicks, typing, screenshots) | ✅ | ✅ | ✅ with one-time setup | ❌ not yet |
| Floating mini-face during computer control | ✅ | ✅ | ✅ via XWayland | – |

\* **Windows** runs everything except computer control; that button is disabled there. Windows support is untested so far, so please report issues.

Honest status: the Linux X11 paths are tested end to end. The Gemini Live voice loop and the wake-word cycle are tested with a mock server and synthesized speech. macOS keeps the original project's computer-control code. Real voice quality depends on your mic and the models you choose.

---

## How it works

```
 You ──mic──▶ [wake word, on your computer] ──"Ahdismoi"──▶ Voice model (Gemini Live / OpenAI Realtime)
                                                              │  speaks back, and calls tools:
                                                              ▼
            search · image gen/edit · notes · records · charts · computer control (+ screen reading)
                     │                                       │
             each uses the provider + model you picked in Settings
                                                              ▼
                                      results appear in the side panel
```

- The **voice model** is the brain. It listens, answers and decides which tool to use.
- **Tools** (search, images, screen reading) each call their own model, chosen per task in Settings.
- **Wake word:** a small speech engine runs locally. No audio is sent anywhere until it hears the wake word.
- **Computer control** must be switched on by you. When needed, the assistant takes a screenshot, and a vision model lists what's on screen with click coordinates.
- **API keys** stay in the app's background process, encrypted with your operating system's password store. They're never exposed to the page.

---

## Installation

You need **Node.js 20 or newer** and **Git** on every platform. The app itself installs with npm.

### macOS

1. **Install tools** (skip what you have):
   ```bash
   # Homebrew (https://brew.sh), then:
   brew install node git
   ```
   Or download Node.js LTS from <https://nodejs.org>.
2. **Get the code and install:**
   ```bash
   git clone https://github.com/jaishankarh/Ahdismoi.git
   cd Ahdismoi
   npm install
   ```
3. **Optional:** `cp .env.example .env.local` if you prefer keys in a file (see [Configuration](#configuration-file-env)).
4. **Start:** `npm run dev`
5. **Permissions.** macOS asks the first time each is needed. You can also set them in **System Settings → Privacy & Security**:
   - **Microphone:** for voice and the wake word.
   - **Accessibility:** for clicking and typing in computer control.
   - **Screen Recording:** for screenshots in computer control.

   Grant them to the app that launched Ahdismoi (Terminal, iTerm, Cursor, VS Code…) **and** to "Electron" if it's listed. Restart the app after granting Accessibility or Screen Recording.

### Linux (X11)

Check which session you're on with `echo $XDG_SESSION_TYPE`. It prints `x11` or `wayland`.

1. **Install tools** (Ubuntu/Debian shown; use `dnf`/`pacman` equivalents elsewhere):
   ```bash
   sudo apt install git curl
   # Node.js 20+ (distro packages are often too old):
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install nodejs
   ```
2. **Get the code and install:**
   ```bash
   git clone https://github.com/jaishankarh/Ahdismoi.git
   cd Ahdismoi
   npm install
   ```
3. **Computer-control setup** (one time; installs `xdotool` and `scrot`):
   ```bash
   npm run setup:linux
   ```
4. **Start:** `npm run dev`

**Key storage:** API keys are encrypted with GNOME Keyring or KWallet, which run by default on GNOME and KDE. On minimal window managers, install and start `gnome-keyring`, or keep keys in `.env.local`. The Settings panel tells you which applies.

### Linux (Wayland)

The default on recent Ubuntu, Fedora and KDE. Wayland deliberately stops apps from controlling other windows, so computer control uses `ydotool`, which needs a one-time setup.

1. Follow **steps 1–2 of Linux (X11)** above.
2. **Computer-control setup:**
   ```bash
   npm run setup:linux
   ```
   This does four things:
   - installs `ydotool` plus a screenshot tool (`grim` / `gnome-screenshot`)
   - adds you to the `input` group
   - adds a udev rule for `/dev/uinput`
   - starts `ydotoold` as a user service

   It asks for your password once.
3. **Log out and back in**, so the group change applies.
4. **Start:** `npm run dev`
5. Open **Settings → Computer control**. It should say "ready".

Notes:

- The Ahdismoi window itself runs through XWayland, so the floating mini-face can position itself and stay on top. Set `AHDISMOI_NATIVE_WAYLAND=1` to opt out.
- **Screenshots:** GNOME may show a one-time "allow screen sharing" dialog.
- Wayland hides other apps' window titles, so "inspect UI" is limited. Ahdismoi relies on screenshots instead. On KDE, installing `kdotool` restores window titles.
- **If your distro has no `ydotool` package,** build it from <https://github.com/ReimuNotMoe/ydotool>, then re-run the setup script.

### Windows

1. **Install tools:** Node.js LTS from <https://nodejs.org> and Git from <https://git-scm.com>. Accept the defaults.
2. **Get the code and install**, in PowerShell or Command Prompt:
   ```powershell
   git clone https://github.com/jaishankarh/Ahdismoi.git
   cd Ahdismoi
   npm install
   ```
3. **Optional:** `copy .env.example .env.local`
4. **Start:** `npm run dev`
5. **Microphone:** in **Settings → Privacy & security → Microphone**, turn on "Microphone access" and "Let desktop apps access your microphone".

Computer control is not available on Windows yet. Its button is disabled, and the assistant will tell you if asked. Everything else works, including the wake word.

---

## Getting API keys

You only need keys for the providers you actually use. With the defaults, that's **just Gemini**.

| Provider | Used for | Where | Notes |
|---|---|---|---|
| **Google Gemini** (required by default) | voice, images, search, screen reading | <https://aistudio.google.com/apikey> | Free tier available, including India. |
| OpenAI (optional) | voice, images, search, screen reading | <https://platform.openai.com/api-keys> | Paid; add credit under Billing. |
| OpenRouter (optional) | images, search, screen reading (many models) | <https://openrouter.ai/keys> | Pay-as-you-go; add credits at <https://openrouter.ai/credits>. |
| Exa (optional) | web search | <https://dashboard.exa.ai/api-keys> | Free starter credits. |
| Picovoice (optional) | Porcupine wake-word engine | <https://console.picovoice.ai/> | Free for personal use. |

**Google Gemini**
1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**, and pick or create a Google Cloud project if asked.
3. Copy the key, which starts with `AIza…`.
4. Optional: set up billing in AI Studio to lift free-tier limits. On the free tier, Google may use your data to improve its products.

**OpenAI**
1. Open <https://platform.openai.com/api-keys> and sign in.
2. Click **Create new secret key** and copy it (`sk-…`). It's shown only once.
3. Add credit under **Settings → Billing**. Some image models may require organization verification.

**OpenRouter**
1. Open <https://openrouter.ai/keys>, sign in and click **Create Key**.
2. Copy it (`sk-or-…`), then add credits at <https://openrouter.ai/credits>.
3. Browse model IDs at <https://openrouter.ai/models>. Use the ID shown on each model's page, like `black-forest-labs/flux.2-klein-4b`.

**Exa**
1. Open <https://dashboard.exa.ai/api-keys>, sign in, create a key and copy it.

**Picovoice**, only for the Porcupine wake-word engine:
1. Sign up at <https://console.picovoice.ai/>. Your **AccessKey** is on the dashboard; copy it.
2. Open **Porcupine** (wake word). Type `Ahdismoi`, choose **French** as the language, and train it.
3. Download the model for platform **Web (WASM)**. You get a `.ppn` file, possibly inside a zip.
4. In Ahdismoi's Settings: paste the AccessKey under **API keys → Picovoice**. Then under **Wake word**, set Engine = Porcupine, Keyword language = French, and use **Choose .ppn…**.

To enter any key, click the **gear icon**, go to **API keys**, paste the key and click **Save**. Or put it in `.env.local`.

---

## First run

1. `npm run dev` opens the window: a face on the left, the side panel on the right.
2. Click the **gear icon** and paste your **Gemini key** under **API keys**, then **Save**.
3. Optional: under **Models**, press **Check** next to each task. It confirms the model exists; it's free and generates nothing.
4. Optional: under **General**, enter **Your name** and **Save**.
5. Close Settings, click the **mic button** and say hello. Or click the **ear button** and say "Ahdismoi".

The first time you use the wake word with the default engine, it downloads a ~41 MB French speech model. You'll see progress under the face.

---

## Using Ahdismoi

### The controls

The buttons under the face, from left to right:

| Button | What it does |
|---|---|
| 🎤 **Mic** | Start or stop a voice conversation. In wake-word mode: **Wake now** / **Go to sleep**. |
| 👂 **Ear** | Turn **wake-word mode** on or off. It stays on across restarts. |
| ⌨️ **Keyboard** | Type a message instead of speaking. You must be connected. |
| ▭ **Panel** | Display mode, the normal full window. |
| 🖥️ **Monitor** (red) | Turn **computer control** on. Only you can do this. Disabled on Windows. |
| 🧠 **Artifacts** | Show or hide the side panel. |
| 🕘 **Log** | Live log of what was said, tools used, and errors. |
| ⚙️ **Gear** | Settings. |

### Talking

- Click **Mic** and speak naturally. You can interrupt at any time.
- The face shows its state: listening, thinking, speaking, working (running a tool) or sleeping.
- Say **"show me the menu"** for a list of things it can do.
- Things to try:
  - "Search the web for the latest news on …"
  - "Add a note: call the accountant on Friday."
  - "Make a flowchart of my morning routine."
  - "Generate an image of a watercolor fox."
  - "Make that fullscreen." / "Hide the panel."
- Anything that sends, deletes, buys or changes settings is confirmed with you first.

### Wake-word mode

1. Click the **Ear** button. The face closes its eyes and shows **Say "Ahdismoi"**.
2. Say **"Ahdismoi"**. You hear a rising chime, and the badge says **Listening**. You can also say it in one breath: "Ahdismoi, what's the weather in Chennai?" The part after the wake word is kept and passed along.
3. Talk as long as you like.
4. It **goes back to sleep** (falling chime):
   - after **10 seconds** without conversation, which is adjustable
   - when you say **"that's all"**, "thanks, bye", **"merci"** or "go to sleep"
   - when you click **Mic** ("Go to sleep")
5. After 5 minutes asleep, the voice connection closes to save money. The next "Ahdismoi" reconnects in a second or two.

Tips:

- **Missed wake words:** raise **Sensitivity** in Settings → Wake word.
- **Waking by itself:** lower Sensitivity. With the default Vosk engine, French sentences containing "dis-moi" can trigger it.
- **Changing the name or phrase:** the assistant's name is in Settings → General. With Vosk, the wake phrase is separate: the words as a French speech model hears them. With Porcupine, train a new word in the Picovoice Console.
- **Speakers vs headphones:** on speakers, if it hears itself and interrupts, turn on "Pause the mic while the assistant talks".

### Computer control

*macOS and Linux only.*

1. Ask for something like "Open Firefox and search for flights to Goa". If computer control is off, a red banner appears: **Allow computer control**. Or click the red **Monitor** button yourself.
2. The window shrinks to a floating face in the corner. The assistant can now:
   - open apps by name
   - take a screenshot and understand it
   - click, type, press keys and shortcuts ("cmd" means Command on Mac and Ctrl on Linux)
   - scroll
   - read the focused window's title
3. To stop, click the **expand button** on the floating face. That turns computer control off and restores the window.

Safety:

- The assistant can never switch computer control on by itself.
- It asks before clicking anything that sends, deletes, buys or changes settings, and before shortcuts that close or quit apps.
- Typing and pressing Enter don't need extra approval.

On macOS, scrolling uses arrow keys and right-click uses Ctrl-click, because of limits in macOS scripting.

### Images and thumbnails

- **Images:** "Generate an image of …" (square, portrait or landscape).
- **Thumbnail board:**
  - "Make a thumbnail of me about AI agents" gives 16:9 images with permanent numbers (#1, #2…).
  - "Pull up number 3", "edit number 3: make the background red", "show page 2".
  - Add reference photos of yourself: "Add /home/me/photos/face.jpg as a reference image."
  - The board is saved in the project's `data/` folder and persists between sessions.

### Search, notes and records

- **Search:** results appear in the panel as a short brief with source links. Links open in your browser.
- **Notes:** "Add a note …" / "show my notes".
- **Records:** a tiny local database. "Create a record in 'books': Dune, rating 5", "search books for Dune". Deleting asks for confirmation.

## Platform notes for everyday use

- **macOS:** all features. For the smoothest computer control, keep the app you want controlled in front. The floating face stays on top.
- **Linux X11:** all features.
- **Linux Wayland:** all features after `npm run setup:linux` and a re-login. Window titles are hidden by Wayland, so the assistant uses screenshots to know what's open.
- **Windows:** voice, wake word, images, search, notes and records. No computer control yet.

Once built, you can run without the dev server: `npm run build` once, then `npm start` each time. This works on all platforms.

---

## Settings panel guide

Open it with the **gear icon**. Changes apply when you click **Save**. Voice changes take effect the next time you connect.

**Models**

There's one card per task:

| Task | Used for |
|---|---|
| **Voice** | the realtime model you talk to; it also chooses tools |
| **Image generation** | new images and thumbnails |
| **Image editing** | thumbnail edits and images using your reference photos |
| **Web search** | search briefs with sources |
| **Screen understanding** | reading screenshots during computer control |

On each card:

- **Provider:** only providers that can do that task are listed.
- **Model:** type **any model ID** the provider supports. The dropdown only shows suggestions.
- **Voice** (voice card only): e.g. Charon or Puck for Gemini, cedar or marin for OpenAI.
- **Check:** confirms the model ID exists with that provider. It's free and needs that provider's key.
- A red "Needs a … API key" line means that provider has no key yet.

**Wake word**

| Field | Meaning |
|---|---|
| **Engine** | *Vosk* (free, offline, no account) or *Picovoice Porcupine* (more accurate; needs an AccessKey and a trained `.ppn`) |
| **Sensitivity** | higher wakes more easily; lower means fewer false wakes |
| **Sleep after silence** | seconds without conversation before it sleeps again (3–300) |
| **Wake phrase** (Vosk) | the words the speech model listens for; default `ah dis moi` |
| **Vosk model** (Vosk) | the speech model to download; **Re-download** clears the cached copy |
| **Keyword language** (Porcupine) | the language you trained the keyword in (French or English) |
| **Keyword file** (Porcupine) | **Choose .ppn…** to pick the file from the Picovoice Console |

**API keys**
- One row per provider. Rows needed by your current choices are highlighted and marked "needed".
- Paste a key and click **Save**. It's encrypted and never shown again. **Remove** deletes it.
- Status shows "saved", "from .env.local" or "not set". **Get key** opens the provider's key page.
- If there's a warning about secure storage, see [Troubleshooting](#troubleshooting).

**General**

| Field | Meaning |
|---|---|
| **Assistant name** | what it calls itself and how the UI labels it (default Ahdismoi) |
| **Your name** | how it addresses you |
| **Pause the mic while the assistant talks** | a fix for self-interruption on speakers (Gemini only) |

**Computer control**
- Shows your platform (macOS / Linux X11 / Linux Wayland) and whether it's **ready**.
- If not ready, it lists what's missing and what to do: usually `npm run setup:linux`, or macOS permissions.

**Footer**

| Button | Effect |
|---|---|
| **Reset to defaults** | forget changes made in the panel, going back to `.env.local` or built-in defaults; API keys are kept |
| **Close** | close without saving |
| **Save** | save your changes |

### Recipes

| Goal | Change |
|---|---|
| All Google, free tier | Defaults. Just add a Gemini key. |
| Cheapest images | Image generation → OpenRouter → `black-forest-labs/flux.2-klein-4b` (add an OpenRouter key) |
| Best image quality | Image generation and editing → Gemini → `gemini-3-pro-image` |
| No Google at all | Voice → OpenAI `gpt-realtime-2`; images → OpenAI or OpenRouter; search → OpenAI / OpenRouter / Exa; screen → OpenAI or OpenRouter |
| Smarter voice, slower | Voice → Gemini → `gemini-3.8-live-extended-thinking` |
| Most accurate wake word | Wake word → Porcupine (Picovoice key + `.ppn`) |

---

## Configuration file (.env)

Everything in the Settings panel can also be set in a file. That's handy for setting up several machines, or for keeping keys out of the UI.

1. Copy the template:
   - macOS/Linux: `cp .env.example .env.local`
   - Windows: `copy .env.example .env.local`
2. Fill in what you want. Empty lines use the built-in defaults.
3. Restart the app.

How it combines with the panel:

- **API keys** saved in the panel win over the file.
- **Other settings** in the file are *defaults*. Anything you change in the panel overrides them, and **Reset to defaults** returns to the file.
- Real environment variables beat `.env.local`, which beats `.env`.

[`.env.example`](.env.example) documents every variable with its allowed values. In summary:

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `EXA_API_KEY`, `PICOVOICE_ACCESS_KEY` | – | provider keys |
| `AHDISMOI_USER_NAME` | – | your name |
| `AHDISMOI_ASSISTANT_NAME` | `Ahdismoi` | assistant's name |
| `AHDISMOI_VOICE_PROVIDER` / `_MODEL` / `_NAME` | `gemini` / `gemini-3.8-live` / `Charon` | voice model and voice |
| `AHDISMOI_IMAGE_PROVIDER` / `_MODEL` | `gemini` / `gemini-3.1-flash-image` | image generation |
| `AHDISMOI_IMAGE_EDIT_PROVIDER` / `_MODEL` | `gemini` / `gemini-3.1-flash-image` | image editing |
| `AHDISMOI_SEARCH_PROVIDER` / `_MODEL` | `gemini` / `gemini-3.8-flash` | web search (`exa` model: `auto`) |
| `AHDISMOI_VISION_PROVIDER` / `_MODEL` | `gemini` / `gemini-3.8-flash` | screen understanding |
| `AHDISMOI_PAUSE_MIC_WHILE_SPEAKING` | `false` | half-duplex mic (Gemini) |
| `AHDISMOI_WAKE_ENABLED` | `false` | start in wake-word mode |
| `AHDISMOI_WAKE_ENGINE` | `vosk` | `vosk` or `porcupine` |
| `AHDISMOI_WAKE_PHRASE` | `ah dis moi` | Vosk wake phrase |
| `AHDISMOI_WAKE_SENSITIVITY` | `0.5` | 0.0–1.0 |
| `AHDISMOI_WAKE_SLEEP_AFTER_SECONDS` | `10` | 3–300 |
| `AHDISMOI_VOSK_MODEL_URL` | French small model | Vosk model (.zip / .tar.gz) |
| `AHDISMOI_PORCUPINE_LANGUAGE` | `fr` | `fr` or `en` |
| `AHDISMOI_NATIVE_WAYLAND` | off | Linux: native Wayland window instead of XWayland |
| `YDOTOOL_SOCKET` | auto | Linux Wayland: ydotoold socket path |
| `AHDISMOI_GEMINI_WS_URL` | Google | advanced: override the Gemini Live endpoint |

Older `RICKY_…` names still work.

---

## Costs

These are rough list prices as of late 2026; check the providers' pricing pages.

- **Gemini Live voice:** about $0.005/min of your speech plus $0.018/min of its speech, plus conversation context. The free tier covers light personal use, with rate limits.
- **Images:**

  | Model | Per 1K image |
  |---|---|
  | Nano Banana 2 (default) | ~$0.07 |
  | Nano Banana 2 Lite | ~$0.03 |
  | FLUX.2 Klein on OpenRouter | ~$0.014 |

- **Search and screen reading:** fractions of a cent per call with Flash models.
- **Wake word:** free with Vosk. Porcupine is free for personal use.
- In wake-word mode, **nothing is billed while asleep**. The voice session closes after 5 idle minutes.

## Privacy and security

- **API keys:**
  - They're encrypted at rest with macOS Keychain, the Linux Secret Service/KWallet, or Windows DPAPI, and kept in the app's background process.
  - Exception: the Picovoice AccessKey is handed to the local wake-word engine.
- **Wake word:** detection runs entirely on your computer. Audio goes to the voice provider only after the wake word, and stops when it sleeps.
- **Computer control** is off by default and can only be enabled by you. Screenshots go to the screen-understanding model you chose. The last 20 are kept in `data/`.
- **Local data:** notes, records, generated images and thumbnails live in the project's `data/` folder.
- **Settings location:**

  | Platform | Folder |
  |---|---|
  | macOS | `~/Library/Application Support/Ahdismoi` |
  | Linux | `~/.config/Ahdismoi` |
  | Windows | `%APPDATA%\Ahdismoi` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "…API key is missing" | Add the key in Settings → API keys, or check the provider chosen for that task. |
| A model stopped working / 404 | Model IDs change. Pick another in Settings → Models and press **Check**. |
| No sound from the assistant | Check your system output device; press Mic again to reconnect; look in the **Log**. |
| It interrupts itself | Use headphones, or enable "Pause the mic while the assistant talks". |
| Wake word never triggers | Raise Sensitivity; check the mic permission; say it clearly as "ah-dis-moi"; watch the Log for "Heard wake word". |
| Wakes up randomly | Lower Sensitivity, or switch to Porcupine. |
| Wake model download fails | Check your internet connection, or set another model URL (Settings → Wake word) and press Re-download. |
| "Invalid AccessKey" (Porcupine) | Re-copy the AccessKey from console.picovoice.ai; make sure the `.ppn` was made for **Web (WASM)** in the same language. |
| "Secure storage is not available" / "only obfuscated" (Linux) | Install and unlock a keyring (`gnome-keyring` or KWallet), or put keys in `.env.local`. |
| Linux: clicks/typing do nothing (Wayland) | Run `npm run setup:linux`, **log out and in**, check Settings → Computer control. |
| Linux: "No screenshot tool worked" | `sudo apt install scrot` (X11) or `grim` / `gnome-screenshot` (Wayland). |
| macOS: clicks/typing do nothing | Grant **Accessibility** to your terminal/IDE and Electron, then restart. |
| macOS: black screenshots | Grant **Screen Recording**, then restart. |
| Windows: no microphone | Settings → Privacy & security → Microphone → allow desktop apps. |
| Blank window after `npm start` | Run `npm run build` first. |

The **Log** button shows what happened, including tool errors.

---

## Development

```bash
npm run dev          # Vite + Electron with hot reload (all platforms)
npm run typecheck
npm run build        # production build into dist/
npm start            # run the built app
npm run setup:linux  # Linux computer-control dependencies
```

Project layout:

```
electron/
  main.cjs        window, IPC, tool definitions and execution
  settings.cjs    settings (+ .env defaults), model presets, encrypted API keys
  providers.cjs   images / search / vision / model checks (Gemini, OpenAI, OpenRouter, Exa)
  voice.cjs       OpenAI Realtime tokens; Gemini Live WebSocket with auto-resume
  computer.cjs    computer control: macOS, Linux X11 (xdotool), Linux Wayland (ydotool)
  wake.cjs        wake-word model download/convert, local asset protocol, Porcupine files
  assets/         bundled Porcupine language models (French, English)
src/
  lib/voice/      Gemini Live + OpenAI Realtime clients behind one interface
  lib/audio/      shared 16 kHz microphone capture + ring buffer
  lib/wake/       wake-word listener (Vosk / Porcupine) and sleep/wake controller
  components/     face, artifact panel, settings panel
scripts/
  setup-linux.sh     Linux computer-control setup (X11 + Wayland)
  electron-dev.cjs   cross-platform Electron launcher for `npm run dev`
```

Adding a model or provider:

- **Model presets:** edit `TASKS` in `electron/settings.cjs`.
- **Request code:** it lives in `electron/providers.cjs`, one function per provider per task.

## License

MIT.

- The bundled Porcupine model files are © Picovoice, under Apache 2.0.
- The default Vosk French model, downloaded at runtime, is by Alpha Cephei, under Apache 2.0.

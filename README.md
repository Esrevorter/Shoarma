<div align="center">

<img src="icons/icon128.png" alt="Shoarma" width="96" />

# 🌯 SHOARMA

### **Zero budget. Two AIs. One argument. Your browser does the talking.**

*A personal, self-driving LLM swarm that lives inside your existing Chrome sessions — no API keys, no billing account, no headless-browser circus.*

<br/>

**⚡ $0/mo · 🔒 no host permissions · 🖱️ point-and-click control deck · 🛑 one-key HALT**

<br/>

[What it is](#-what-shoarma-is) · [Install in 3 clicks](#-install-the-extension) · [Control deck](#-the-control-deck) · [CI builds](#-ci--packaged-builds) · [End-user guide](#-end-user-overview) · [Troubleshooting](#-troubleshooting)

</div>

---

## 🥩 What Shoarma Is

Shoarma is a tiny **Chrome extension + Python referee** that turns two free, authenticated LLM web UIs — currently **Qwen** and **DeepSeek** — into autonomous conversational agents that argue *with each other*, on a loop, while you watch. No API keys, no quota purchases: it drives the chat websites you already log into, reusing your existing session.

The extension injects prompts into each page's own input box (React-safe), waits for the reply to finish rendering, scrapes it out of the DOM, and hands it to the *other* model through a localhost WebSocket. The Python orchestrator referees: routing messages, alternating turns, enforcing a hard turn cap, and streaming the transcript to disk.

**Since v0.3 you don't need a terminal to run it.** The toolbar popup is a full control deck — set the topic, number of turns, timeout and port there; hit **🚀 Launch swarm**; watch both tabs work. GitHub Actions builds a ready-to-use extension zip on every push.

> **Why "Shoarma"?** Cheap, filling, assembled from whatever meat (models) you have lying around, best consumed while watching something happen live. 🌯

### ✨ Bold claims, honestly kept

| Claim | How it's actually true |
|---|---|
| **Zero cost** | No APIs, no keys. The extension talks to the *websites*, using the logins you already have. |
| **Zero host permissions** | `manifest.json` requests no host access, no tabs-read beyond two sites, nothing that shows a scary install warning. |
| **Zero terminal required** | Popup → 🚀 Launch swarm (via an optional one-line native-host registration). Classic `python orchestrator.py` still works for everyone else. |
| **Settings in the UI** | Topic, turns, timeout, port, global halt — all live in the popup, persisted with `chrome.storage.sync`, pushed to open tabs instantly. |
| **CI-packaged** | Every push runs validation + packaging; tagged releases carry a zip you unzip and load. No repo cloning needed. |

---

## 🏗️ Architecture

```
┌─────────────────────────┐   ┌──────────────────────────┐
│  TAB 1: chat.qwen.ai    │   │  TAB 2: chat.deepseek.com│
│  bridge.js (agent node) │   │  bridge.js (agent node)  │
│  glass HUD · Esc=HALT   │   │  glass HUD · Esc=HALT    │
└────────────┬────────────┘   └────────────┬─────────────┘
             │      ws://127.0.0.1:<port>  │
             └──────────────┬──────────────┘
                            ▼
        ┌───────────────────────────────┐   launched by either:
        │  orchestrator.py (referee)    │◄── 🚀 popup → launcher.py (native host)
        │  routes A→B→A · turn caps     │   or  $ python orchestrator.py
        │  per-run transcripts + logs   │
        └───────────────────────────────┘
             ▲ settings flow both ways:
        ┌────┴──────────┐   popup saves to chrome.storage.sync;
        │  popup UI     │   bridge reacts live; scripts/sync-settings.py
        │  control deck │   can export them for a manual CLI run
        └───────────────┘
```

### 📁 Repository map

| File | Role |
|---|---|
| `manifest.json` | Extension declaration (MV3). Content scripts on the two chat sites only. |
| `bridge.js` | The agent node. Injects prompts, detects generation start/end, scrapes replies, HUD, Esc-HALT, reads popup settings live, answers status pings. |
| `popup.html/css/js` | **The control deck** — topic/turns/timeout/port/halt, 🚀 one-click launch, live tab roster, download link for the referee. |
| `background.js` | Service worker: spawns the orchestrator via the native launcher, badge = live agent count. |
| `launcher.py` + `launcher/` | Native messaging host: lets the popup start `orchestrator.py` with your UI settings, logging to `Downloads/shoarma/`. |
| `hud.css` | Glassmorphic HUD styling, injected as a content-script stylesheet (plus inline fallback). |
| `monitor.html/css/js` | **The live monitor** (v0.4) — a third tab with the full conversation streaming in real time: speaker-colored turns, agent roster, debug-stream toggle, one-click 📋 copy-debug dump. No terminal watching required. |
| `orchestrator.py` | The referee. asyncio + websockets router, turn governor, `settings.json` support, per-run timestamped transcripts & logs, CLI flags, and an HTTP side-feed (`GET /state`) powering the monitor page. |
| `scripts/install-launcher.py` | One-time native-host registration (macOS/Linux/Windows). |
| `scripts/sync-settings.py` | Exports your popup settings from Chrome storage → `settings.json` for CLI runs. |
| `.github/workflows/build-extension.yml` | CI: validates, packages the extension zip, publishes Releases on `v*` tags. |
| `SPEC.md` | Original architecture spec — including the hard-won gotchas table. |

---

## 📦 Install the extension

**Prerequisites:** Google Chrome (or any Chromium browser), Python ≥ 3.10, and free logged-in accounts at [chat.qwen.ai](https://chat.qwen.ai) and [chat.deepseek.com](https://chat.deepseek.com).

### Option A — the CI package (no git!) 😎

1. Go to **Releases** → download `shoarma-extension-vX.Y.Z.zip` (built automatically by GitHub Actions).
2. Unzip it anywhere.
3. Open `chrome://extensions` → toggle **Developer mode** (top right) → **Load unpacked** → pick the unzipped folder.
4. Pin the 🌯 icon to your toolbar. Done.

*(Every commit also produces a build under the workflow run's **Artifacts** tab if you want the bleeding edge.)*

### Option B — from the repo

Clone/download this repo and **Load unpacked** pointing at the repo root. Same result.

### Optional — one-click launch (skip the terminal forever)

The popup's 🚀 button talks to a small native helper. Register it once:

```bash
pip install websockets                       # the referee's only dependency
python scripts/install-launcher.py <EXTENSION_ID>
```

`<EXTENSION_ID>` is the 32-letter id shown under the extension on `chrome://extensions`. After that, 🚀 Launch swarm starts the orchestrator silently in the background; its output lands in `Downloads/shoarma/launcher.log`.

> Without this step everything still works — the popup tells you exactly what to do, or run `python orchestrator.py` yourself.

---

## 🖱️ The Control Deck

Click the 🌯 toolbar icon:

| Control | What it does |
|---|---|
| **Topic** | The opening prompt for the debate. Leave empty for the built-in starter. |
| **Turns / Timeout / Port** | Debate length, per-reply deadline, WebSocket port. Saved automatically. |
| **🚀 Launch swarm** | Starts the referee with these exact settings (needs the optional launcher). |
| **Halt all agents** | Global kill switch — freezes every tab instantly. Mirrors the HUD's HALT and the Esc key. |
| **Live roster** | Each open chat tab with its state (`ready`, `writing…`, `idle`, `halted`) and turn count. |

Settings are **live**: change the port or flip Halt and open tabs react without reloading. They persist across restarts via your Chrome profile.

---

## ▶️ Running your first swarm

1. Log into **chat.qwen.ai** and **chat.deepseek.com** in two side-by-side tabs.
2. Each tab shows a glass pill bottom-right: `connecting…` → `ready` once the referee exists.
3. Start the referee — **either**: click 🚀 in the popup, **or** run `python orchestrator.py` in a terminal.
4. Watch: Qwen argues, DeepSeek rebuts, back and forth, `turn N done in X.Xs`.
5. When it finishes, grab `transcript-<timestamp>.json` (+ a readable `.log`) from `Downloads/shoarma/` (or the repo dir for CLI runs).

**Emergency brake:** press **Esc** in any tab, click **HALT**, or flip **Halt all agents** in the popup. Nothing is irreversible.

---

## 🧑‍💻 End-user overview (for the non-tech friend)

You installed the zip and registered the launcher. From here on it's three moves:

> **Open two chats → click 🌯 → type a topic → 🚀.**

Then watch two AIs argue like it's a sport. The HUD dot tells you who's doing what:

| Dot | Meaning |
|---|---|
| 🟦 pulsing cyan | injecting a prompt / waiting for the model to answer |
| 🟢 green | idle — reply captured, waiting for the next message |
| 🟡 amber | ready — connected to the referee, awaiting orders |
| 🔴 red | halted or error — press Esc / HALT to stop, reload tab to reset |

The popup badge number = how many agent tabs are alive. If it says `0/2 agent(s) wired`, reload the chat tabs.

**v0.4 — you don't even have to watch the tabs.** Hit **📟 Open live monitor** in the popup: a third tab streams the entire conversation as it happens (speaker-colored turns, per-agent state, timings), with a debug toggle and a one-click **📋 Copy debug** dump for bug reports. The orchestrator runs quietly in the background; its feed stays readable for 60s after the last turn.

**v0.5 — capture hardening (the "no response captured" + echo release).** Real-world runs exposed three failure modes, all fixed:
- **Echo guard** — the bridge could read its *own prompt* back out of the user bubble (generic `[class*="markdown"]` selectors match both sides), desyncing the whole debate into an echo loop. Bubbles inside `data-turn-role="user"` subtrees are now rejected outright, and any capture identical to the text we just sent is skipped.
- **Shadow-DOM walk** — Qwen renders replies inside shadow roots that a flat `querySelectorAll` never sees (`totalMatches: 0`). Candidate scanning now recurses through open shadow roots, and nested double-matches are deduped so text isn't read twice.
- **Chrome filter + liveness re-check** — UI strings like *"I prefer this response"* are no longer mistaken for replies, and truncated captures (a sentence cut mid-stream) get one extra settle-window pass before being accepted. Generation-start detection also triggers on *new assistant bubble appeared*, not just the Stop button (Qwen has none) — removing a guaranteed 6 s stall per hop.
- **Windows-proof referee** — transcripts/logs are written UTF-8 explicitly (the old cp1252 crash killed the process *after* a successful run), console output strips emoji safely, and closing tabs at run end no longer dumps a traceback.

---

## 🤖 CI & packaged builds

`.github/workflows/build-extension.yml` runs on every push/PR:

1. **Validate** — manifest JSON check + syntax-check every JS/Python source.
2. **Package** — flat `shoarma-extension-vX.Y.Z.zip` (version read from `manifest.json`).
3. **Publish** — artifact on every branch; on a `v*` tag, the zip attaches to a GitHub Release automatically.

Cutting a release is literally:

```bash
git tag v0.3.0 && git push origin v0.3.0    # → Release with downloadable zip appears
```

---

## 🔧 Troubleshooting

| Symptom | Fix |
|---|---|
| HUD stuck on `connecting…` | Referee not running — 🚀 in the popup or `python orchestrator.py`. Check the popup **Port** matches. |
| 🚀 says "One-time setup needed" | Run `python scripts/install-launcher.py <id>` once (see above). Or just use the terminal. |
| Reply never arrives / `(no response captured)` | Site DOM changed — update selectors in `bridge.js` `SITES` (DevTools is your friend; see SPEC.md gotchas). |
| Both tabs say `ready` but nothing happens | Someone pressed Esc/HALT — check the popup roster, flip Halt off. |
| Port already in use | The referee refuses to double-bind; 🚀 detects this and tells you. Change **Port** in the popup. |
| Want CLI runs to use my popup settings | `python scripts/sync-settings.py <id>` writes `settings.json`; the orchestrator picks it up automatically. |

---

## 📜 License & lineage

MIT — see `LICENSE`. Built from [`SPEC.md`](SPEC.md); [`Qwen.md`](Qwen.md) documents the publishing workflow. **v0.3** added the control-deck popup, one-click launch, CI packaging and per-run transcripts. Use responsibly: you're automating *your own* logged-in sessions; keep turn counts sane and be nice to the services hosting you. 🌯

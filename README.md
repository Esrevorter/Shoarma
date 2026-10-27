<div align="center">

<img src="icons/icon128.png" alt="Shoarma" width="96" />

# 🌯 SHOARMA

### **Zero budget. Two AIs. One argument. Your browser does the talking.**

*A personal, self-driving LLM swarm that lives inside your existing Chrome sessions — no API keys, no billing account, no headless-browser circus.*

<br/>

**⚡ $0/mo · 🖱️ point-and-click control deck · 🛑 one-key HALT · 🐍 Python now optional**

<br/>

[What it is](#-what-shoarma-is) · [Install](#-install-the-extension) · [Control deck](#️-the-control-deck) · [CI builds](#-ci--packaged-builds) · [Troubleshooting](#-troubleshooting) · [Wiki](https://github.com/Esrevorter/Shoarma/wiki)

</div>

---

## Current release: v0.9.20 — Start swarm provisions its own tabs

- **▶ Start swarm opens the chat tabs itself.** No more "open Qwen and DeepSeek first".
  If a bridge hasn't registered, the engine spawns the missing tab in the background;
  after an 8 s wait it force-reloads any existing-but-silent tab (login wall, dead
  content script), and only then fails with an actionable error. Verified by
  `test-v0920-autoprovision.js`.
- **v0.9.19 log hygiene** — runaway ERROR spam ("Receiving end does not exist" ×370),
  double-ingested monitor lines and per-turn chatter all eliminated; debug dumps are
  readable again.
- **v0.9.18 truthful monitor** — full markdown conversation bubbles (nothing clipped),
  ▶/■ control in zero-terminal engine mode, honest run statistics from the feed ring.

## The story so far

| Version | What landed |
|---|---|
| **v0.9.x** | The swarm became **fully browser-native**: `swarm-engine.js` (MV3 service worker) runs the whole A↔B loop — no Python, no WebSocket needed. Popup gained an *Orchestrator* selector (🌐 In-browser engine / 🖥️ Remote Python). Then: promise-safe chrome.* calls (worker can't die silently), late-reply adoption & ghost-send recovery, Ctrl+Enter submit detection for DeepSeek, monitor NaN-seq fix, log hygiene, auto-provision. |
| **v0.6–v0.8** | Start when *you* say start (arming, ▶ frames carry Topic/Turns), Qwen confirm-gate, no placeholder spirals; single-flight turn guard + cooldown retries; capture hardening (echo guard, shadow-DOM walk, chrome-word filter); Windows-proof UTF-8 referee. |
| **v0.4–v0.5** | The live **monitor page** (third tab, real-time transcript, 📋 Copy debug); capture hardening against DOM desyncs. |
| **v0.3** | Control-deck popup, CI packaging, per-run transcripts. |

## 🥩 What Shoarma Is

Shoarma is a **Chrome extension** that turns two free, authenticated LLM web UIs — currently **Qwen** and **DeepSeek** — into autonomous conversational agents that argue *with each other*, on a loop, while you watch. No API keys, no quota purchases: it drives the chat websites you already log into, reusing your existing session.

The extension injects prompts into each page's own input box (React-safe), waits for the reply to finish rendering, scrapes it out of the DOM, and hands it to the *other* model. **Since v0.9 the referee itself is a service worker inside the extension** (`swarm-engine.js`): tabs talk over `chrome.runtime` messaging — no sockets, no localhost, no terminal. A Python orchestrator (`orchestrator.py`) is still there for people who prefer a separate referee process ("Remote Python" mode).

> **Why "Shoarma"?** Cheap, filling, assembled from whatever meat (models) you have lying around, best consumed while watching something happen live. 🌯

### ✨ Bold claims, honestly kept

| Claim | How it's actually true |
|---|---|
| **Zero cost** | No APIs, no keys. The extension talks to the *websites*, using the logins you already have. |
| **No scary install warning** | `manifest.json` asks for `storage`, `tabs`, `downloads`, `scripting` and host access **only** to `chat.qwen.ai` + `chat.deepseek.com`. Nothing else. |
| **Zero terminal required** | Since v0.9 everything runs in the browser: popup → 🚀 Launch swarm → ▶ Start swarm. Python is optional (remote mode only). |
| **Settings in the UI** | Topic, turns, timeout, port, orchestrator mode, global halt — all live in the popup, persisted with `chrome.storage.sync`, pushed to open tabs instantly. |
| **CI-packaged** | Every push runs validation + packaging; tagged releases carry a zip you unzip and load. No repo cloning needed. |

---

## 🏗️ Architecture

```
┌─────────────────────────┐   ┌──────────────────────────┐
│  TAB 1: chat.qwen.ai    │   │  TAB 2: chat.deepseek.com│
│  bridge.js (agent node) │   │  bridge.js (agent node)  │
│  glass HUD · Esc=HALT   │   │  glass HUD · Esc=HALT    │
└────────────┬────────────┘   └────────────┬─────────────┘
             │  chrome.runtime messages    │
             └──────────────┬──────────────┘
                            ▼
        ┌───────────────────────────────────────┐
        │ swarm-engine.js  (MV3 service worker) │  DEFAULT MODE
        │ strict A↔B alternation · turn cap     │  no Python, no sockets
        │ arm/start/stop · transcripts          │
        │ auto-provision of missing tabs        │
        │ mirrors state/feed → chrome.storage   │
        └───────────────┬───────────────────────┘
                        ▼
        ┌───────────────────────────────────────┐   monitor.html — third tab,
        │  monitor page (live transcript view)  │   reads the storage mirrors
        └───────────────────────────────────────┘

  ALTERNATIVE ("Remote Python") MODE:
        bridge.js ──ws://127.0.0.1:<port>──► orchestrator.py
        (same protocol; adds HTTP GET /state side-feed for the monitor)
```

### 📁 Repository map

| File | Role |
|---|---|
| `manifest.json` | Extension declaration (MV3). Content scripts on the two chat sites only. |
| `swarm-engine.js` | **The in-browser referee** (service worker, since v0.9). Port of the orchestrator protocol over `chrome.runtime` messaging: register → arm → start → say/reply alternation → transcript; v0.9.8 promise-safe guards; v0.9.20 auto-provision of agent tabs. |
| `bridge.js` | The agent node. Injects prompts, detects generation start/end, scrapes replies (shadow-DOM walk, echo guard, chrome filter), HUD pill, Esc-HALT, ▶/■ buttons, dual transport (engine / WebSocket). |
| `popup.html/css/js` | **The control deck** — topic/turns/timeout/port, Orchestrator-mode selector, 🚀 launch/arm, ▶ Start / ■ Stop, live tab roster, activity log + copy. |
| `monitor.html/css/js` | **The live monitor** — third tab streaming the full conversation as markdown bubbles, agent roster, debug toggle, 📋 Copy debug, ▶/■ controls. Works in both modes. |
| `orchestrator.py` | Optional Python referee for remote mode: asyncio + websockets router, turn governor, `settings.json`, per-run transcripts/logs, HTTP `/state` side-feed. |
| `launcher.py` + `launcher/` + `scripts/install-launcher.py` | Legacy native-messaging host (retired in v0.9; kept for the old remote workflow). |
| `scripts/sync-settings.py` | Exports popup settings from Chrome storage → `settings.json` for CLI runs. |
| `hud.css` / `monitor.css` / `popup.css` | Glassmorphic styling for pill / monitor / popup. |
| `tools/build_release.py` | Canonical validator + zip builder (used by CI since v0.9.5; refuses to ship manifest-inconsistent bundles). |
| `tools/shoarma-probe*.js` + `tools/PROBE.md` | DOM probes that dump the real page markup when selectors break. |
| `tools/generate-docs-data.py` | Extracts doc ground-truth (version, SITES map, engine message cases, live releases) so README/Wiki can be checked against code. |
| `.github/workflows/build-extension.yml` | CI: validates, packages via `tools/build_release.py`, publishes Releases on `v*` tags. |
| `test-*.js`, `tests/` | Node regression suites (recovery, desync, monitor, autoprovision…) + compliance tests. Run them directly: `node test-v0920-autoprovision.js`. |
| `SPEC.md` | Original architecture spec — including the hard-won gotchas table. |
| `Qwen.md` | Session log: publishing workflow, root causes, verified release history. |
| `RULES.md` | Working agreement for agents on this repo (verify-first, honest docs). |

---

## 📦 Install the extension

**Prerequisites:** Google Chrome (or any Chromium browser). That's it — Python ≥ 3.10 is only needed if you want the optional remote-Python mode. Free logged-in accounts at [chat.qwen.ai](https://chat.qwen.ai) and [chat.deepseek.com](https://chat.deepseek.com).

### Option A — the CI package (no git!) 😎

1. Go to **Releases** → download `shoarma-vX.Y.Z-chrome.zip` from the latest tag (currently **v0.9.20**).
2. Unzip it anywhere.
3. Open `chrome://extensions` → toggle **Developer mode** (top right) → **Load unpacked** → pick the unzipped folder.
4. Pin the 🌯 icon to your toolbar. Done.

*(Every commit also produces a build under the workflow run's **Artifacts** tab if you want the bleeding edge.)*

### Option B — from the repo

Clone/download this repo and **Load unpacked** pointing at the repo root. Same result.

### Optional — remote-Python mode (legacy)

Prefer a separate referee process? `pip install websockets`, run `python orchestrator.py`, and set the popup's **Orchestrator** selector to **🖥️ Remote Python**. The native launcher (`scripts/install-launcher.py`) that used to spawn it from the 🚀 button was retired in v0.9 — start the process yourself in a terminal.

---

## 🖱️ The Control Deck

Click the 🌯 toolbar icon:

| Control | What it does |
|---|---|
| **Coach strip** | Step 1→2→3 guidance with a progress bar; tells you when both agents are wired. |
| **Topic** | The opening prompt for the debate. Leave empty for the built-in starter. |
| **Turns / Timeout / Port** | Debate length (1–50), per-reply deadline (30–600 s), WebSocket port (remote mode only — dimmed in engine mode). Saved automatically. |
| **Orchestrator** | 🌐 **In-browser engine** (default, no Python) or 🖥️ **Remote Python** orchestrator. |
| **🚀 Launch swarm** | Engine mode: arms the in-browser swarm. Remote mode: legacy launcher path (tells you to run `orchestrator.py` manually). |
| **▶ Start swarm / ■ Stop** | Starts/stops the run with the popup's Topic/Turns. Since v0.9.20 Start opens any missing chat tabs itself. |
| **📟 Open live monitor** | Opens the monitor tab. |
| **⬇ Export transcript** | Downloads the last run's transcript JSON. |
| **Halt all agents** | Global kill switch — freezes every tab instantly. Mirrors the HUD's ⏸ and the Esc key. |
| **Live roster** | Each open chat tab with its state (`ready`, `writing…`, `idle`, `halted`) and turn count. |
| **Activity log** | Centralized popup event log, 📋 Copy all / Clear — bug-report material. |

Settings are **live**: change the port or flip Halt and open tabs react without reloading. They persist across restarts via your Chrome profile.

---

## ▶️ Running your first swarm

1. Click 🌯 → **🚀 Launch swarm** (arms the engine), then **▶ Start swarm**.
   That's genuinely all — since v0.9.20 the engine opens the Qwen/DeepSeek tabs itself if they aren't registered yet. (You do need to be logged into both at least once; if provisioning stalls you'll get an explicit "check the opened tabs are logged in" hint.)
2. Watch: Qwen argues, DeepSeek rebuts, back and forth. Open **📟 Open live monitor** to follow the full conversation with timings.
3. When it finishes: **⬇ Export transcript** downloads the JSON; the monitor keeps the feed readable after the run.

**Emergency brake:** press **Esc** in any tab, click **⏸** on the HUD pill, or flip **Halt all agents** in the popup. Nothing is irreversible.

---

## 🧑‍💻 End-user overview (for the non-tech friend)

From here on it's three moves:

> **Click 🌯 → type a topic → 🚀 → ▶.**

Then watch two AIs argue like it's a sport. The HUD dot tells you who's doing what:

| Dot | Meaning |
|---|---|
| 🟦 pulsing cyan | injecting a prompt / waiting for the model to answer |
| 🟢 green | idle — reply captured, waiting for the next message |
| 🟡 amber | ready — connected to the referee, awaiting orders |
| 🔴 red | halted or error — press Esc / ⏸ to stop, reload tab to reset |

The popup badge number = how many agent tabs are alive. If the roster says `0/2 agent(s) wired`, reload the chat tabs (or just press ▶ Start swarm — it will try to fix things itself).

**The monitor page (v0.4, overhauled v0.9.18)** is the comfy seat: a third tab streaming the entire conversation as complete markdown bubbles (speaker-colored, nothing truncated), per-agent state, timings, a debug-stream toggle, and a one-click **📋 Copy debug** dump for bug reports. It works with zero terminals — it reads the engine's mirrors straight out of `chrome.storage`.

---

## 🤖 CI & packaged builds

`.github/workflows/build-extension.yml` runs on every push/PR:

1. **Validate** — manifest JSON check + `node --check` (bridge/swarm-engine/popup/monitor) + `py_compile` on all Python.
2. **Package** — `tools/build_release.py` (canonical builder since v0.9.5) zips exactly the runtime files and refuses to ship if any manifest-referenced path is missing or a retired file sneaks in.
3. **Publish** — artifact on every branch; on a `v*` tag, the zip attaches to a GitHub Release automatically.

Cutting a release is literally:

```bash
git tag v0.9.21 && git push origin v0.9.21    # → Release with downloadable zip appears
```

---

## 🩺 Troubleshooting & self-healing design

Shoarma assumes the worst of hostile web UIs and degrades gracefully:

| Symptom | What the code does |
|---|---|
| React composer ignores injected text | fiber probe (`reactHoldsText`) detects DOM/model desync → one bounded caret retype through the site's own input pipeline, then direct handler invocation |
| Enter inserts a newline instead of sending | declared `sendKey` per site (DeepSeek: Ctrl+Enter) + handler-signature sniffing (`detectEnterCombo`) before guessing |
| Site shows a feedback gate ("Good Response", "I prefer this response") | confirm-gate auto-click; the same strings are blacklisted from reply capture so UI chrome can never poison the thread |
| Nothing capturable after a send | one bounded capture retry per hop, then an honest `NO RESPONSE CAPTURED` diagnostic (bubble classes included) — never a placeholder relayed as an argument |
| Message accepted but composer emptied late ("ghost send") | final settle check treats it as submitted; a reply captured after a throw is *adopted*, not re-sent (v0.9.4) |
| Same message fails repeatedly | broken-record guard: max 2 attempts per identical prompt, then the run terminates cleanly instead of looping forever |
| Chat tabs not open when you press Start | v0.9.20 auto-provision: spawn missing tabs, then force-reload silent existing ones, then fail with an actionable hint |
| Monitor shows no data | engine mirrors its debug ring + full-text feed into `chrome.storage.local`; the monitor drains both every 800 ms and dedupes by sequence |
| MV3 worker dies mid-run | promise-safe `asPromise()/safeCatch()` wrappers + unhandled-rejection shield (v0.9.8) keep it alive; repeats coalesce into one counted line (v0.9.19) |

Every failure path emits structured debug lines; **📋 Copy debug** on the monitor gathers the whole story for a bug report.

## 🔧 Troubleshooting

| Symptom | Fix |
|---|---|
| HUD stuck on `connecting…` | Engine mode: the service worker may have gone dormant — click the 🌯 popup once to wake it, then reload the tab. Remote mode: referee not running — `python orchestrator.py`; check the popup **Port** matches. |
| 🚀 in remote mode says launcher retired | Expected since v0.9 — run `python orchestrator.py` in a terminal, or switch the Orchestrator selector back to 🌐 In-browser engine. |
| Reply never arrives / `(no response captured)` | Site DOM changed — run the probe in `tools/PROBE.md`, then update selectors in `bridge.js` `SITES` (DevTools is your friend; see SPEC.md gotchas). |
| Both tabs say `ready` but nothing happens | Someone pressed Esc/⏸ — check the popup roster, flip Halt off. |
| Start swarm times out ("agents did not register within 12 s") | One of the auto-opened tabs is stuck on a login wall — log in there once, press ▶ again. |
| Port already in use (remote mode) | The referee refuses to double-bind; change **Port** in the popup and relaunch. |
| Want CLI runs to use my popup settings | `python scripts/sync-settings.py <id>` writes `settings.json`; the orchestrator picks it up automatically. |

---

## 📜 License & lineage

MIT — see `LICENSE`. Built from [`SPEC.md`](SPEC.md); [`Qwen.md`](Qwen.md) documents the publishing workflow and per-version root-cause history; [`RULES.md`](RULES.md) is the working agreement that keeps docs and claims honest. **v0.3** added the control-deck popup and CI packaging; **v0.9** moved the whole swarm into the browser; **v0.9.20** is current. Use responsibly: you're automating *your own* logged-in sessions; keep turn counts sane and be nice to the services hosting you. 🌯

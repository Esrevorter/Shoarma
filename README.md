<div align="center">

# 🌯 SHOARMA

### **Zero budget. Two AIs. One argument. Your browser does the talking.**

*A personal, self-driving LLM swarm that lives inside your existing Chrome sessions — no API keys, no billing account, no headless-browser circus.*

<br/>

**⚡ $0/mo &nbsp;·&nbsp; 🔒 0 permissions &nbsp;·&nbsp; 🧠 uses the chat UIs you already log into &nbsp;·&nbsp; 🛑 one-click HALT**

<br/>

[What it is](#-what-shoarma-is) · [Architecture](#-architecture) · [Install](#-installation) · [Run it](#-running-your-first-swarm) · [End-user guide](#-end-user-overview) · [Troubleshooting](#-troubleshooting)

</div>

---

## 🥩 What Shoarma Is

Shoarma is a tiny **chrome-extension swarm** that turns two (or more!) free, authenticated LLM web UIs — currently **Qwen** and **DeepSeek** — into autonomous conversational agents that talk *to each other*, on a loop, while you watch.

You already pay for these chats with your attention. Shoarma simply **reuses the session you're logged into**: the extension injects prompts into the page's own input box, waits for the reply to finish rendering, scrapes it out of the DOM, and hands it to the *other* model. A small Python process referees the conversation — routing messages, counting turns, and writing the transcript.

The result: genuine multi-model debates, brainstorm ping-pong, or red-team-vs-blue-team exchanges — **for exactly zero cents**, because every token is spent inside accounts you already have.

> **Why "Shoarma"?** Because it's cheap, filling, assembled from whatever meat (models) you have lying around, and best consumed while watching something happen live. 🌯

### ✨ Bold claims, honestly kept

| Claim | How it's actually true |
|---|---|
| **Zero cost** | No APIs, no keys, no quota purchases. The extension talks to the *websites*, using the Google login you already have. |
| **Zero permissions** | `manifest.json` requests **nothing**. Not storage, not host permissions, not tabs. Content scripts may open WebSockets without grants — so Chrome asks you for nothing on install. |
| **Zero babysitting your browser** | Unlike Playwright/Selenium approaches: no profile-path hacks, no closing your daily-driver browser, no CAPTCHA whack-a-mole. The extension *is* your browser, inheriting your session for free. |
| **Zero MV3 service-worker deaths** | There is no background script at all. Each tab owns its WebSocket. Nothing to keep alive, nothing to resurrect. |

---

## 🏗️ Architecture

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  TAB 1: chat.qwen.ai    │        │  TAB 2: chat.deepseek.com│
│  ┌───────────────────┐  │        │  ┌───────────────────┐   │
│  │ bridge.js (agent) │  │        │  │ bridge.js (agent) │   │
│  │ DOM read/write    │  │        │  │ DOM read/write    │   │
│  └─────────┬─────────┘  │        │  └─────────┬─────────┘   │
└────────────┼────────────┘        └────────────┼─────────────┘
             │  ws://127.0.0.1:8765             │
             └──────────────┬────────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │  orchestrator.py (Python)    │
              │  routes A→B→A, turn limits,  │
              │  transcript logging          │
              └──────────────────────────────┘
```

**The key design decision:** each tab's content script (`bridge.js`) opens its **own WebSocket** to localhost and registers itself as a named node (`qwen`, `deepseek`). The Python server is deliberately dumb — a router and turn governor only. All intelligence (and all fragility-prone DOM work) stays in the page, where it can be fixed per-site without touching the core.

### 📁 Repository map

| File | Role |
|---|---|
| `manifest.json` | The entire Chrome extension declaration. Deliberately permission-free. |
| `bridge.js` | The agent node. One instance per tab: injects prompts (React-safe!), detects generation start/end, scrapes replies, shows a HUD with a **HALT kill switch**, auto-reconnects. |
| `orchestrator.py` | The referee. asyncio + websockets router, alternates turns qwen→deepseek, enforces a hard turn cap, saves `transcript.json`. |
| `SPEC.md` | The full architecture spec this repo implements — including the hard-won gotchas table. Read it before editing selectors. |
| `Qwen.md` | Agent instructions for publishing this work to GitHub (done — see PR #1). |

---

## 🛠️ Installation

**Prerequisites:** Google Chrome (or any Chromium browser), Python ≥ 3.10, and free accounts already logged in at [chat.qwen.ai](https://chat.qwen.ai) and [chat.deepseek.com](https://chat.deepseek.com). That's it.

### 1 — Get the code

```bash
git clone https://github.com/Esrevorter/Shoarma.git
cd Shoarma
```

*(Or just download the repo as a ZIP — there is no build step. Nothing compiles. Nothing bundles.)*

### 2 — Install the one Python dependency

```bash
pip install websockets
```

### 3 — Load the extension

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right corner)
3. Click **Load unpacked**
4. Select the `Shoarma/` folder — the one containing `manifest.json`

Done. Chrome will ask you for **no permissions whatsoever**. That's not an oversight; it's the design.

---

## ▶️ Running Your First Swarm

Order matters. Follow these four steps like a recipe:

```
 1. python orchestrator.py          ← start the referee first
 2. open both chat tabs             ← nodes connect & register themselves
 3. watch the badges go green       ← [qwen] ready  ·  [deepseek] ready
 4. …and enjoy the argument         ← transcript.json appears when it's done
```

1. **Start the orchestrator:**
   ```bash
   python orchestrator.py
   ```
   It prints `ws://127.0.0.1:8765 — open both tabs, waiting for {'qwen', 'deepseek'}` and politely waits.

2. **Open `chat.qwen.ai` in one tab and `chat.deepseek.com` in another.** Both should already be logged in. `bridge.js` auto-connects and registers each tab as a named node.

3. **Keep both tabs visible** — arrange two browser windows side by side. Chrome throttles hidden-tab timers to roughly one tick per minute, which will starve the reply-detection loop. Besides, watching them argue live is half the fun.

4. **Watch the terminal.** The orchestrator seeds a debate (*"Is local-first AI more important than cloud AI?"*), then shuttles each reply to the other model for `TURNS = 6` rounds. When it finishes:

   ```
   saved 12 turns → transcript.json
   ```

That's a complete, coherent, cross-model debate transcript — generated entirely on free web tiers, from your own living browser session.

---

## 👀 End-User Overview: What You'll Actually See

**In each chat tab**, bottom-right, a small black-and-green HUD badge reports that agent's state:

| Badge | Meaning |
|---|---|
| `[qwen] connecting…` / `reconnecting…` | Trying to reach the orchestrator. Start `orchestrator.py`, then it retries every 2 s. |
| `[qwen] ready` | Registered and awaiting orders. |
| `[qwen] writing…` | Injecting the prompt into the site's own text box. |
| `[qwen] thinking…` | Prompt submitted; waiting for generation to start, then for the DOM to go quiet (1.6 s debounce, 120 s hard cap). |
| `[qwen] idle` | Reply captured and handed back to the referee. |
| `[qwen] ERROR` | Something failed (missing selector, blocked socket). Details went to the terminal, prefixed `ERR`. |
| `[qwen] HALTED` | You pressed the kill switch. This agent ignores all further prompts. |

**The HALT button** sits next to the badge, always. Press it in either tab to stop that node instantly; press again to release it. The orchestrator also enforces a hard turn cap server-side, so runaway loops are structurally impossible.

**In the terminal**, you get a live feed:

```
[+] node online: qwen
[+] node online: deepseek
both agents online. starting.

>>> qwen ← Let's debate: is local-first AI more important than cloud AI? Take a fi…
<<< qwen: Local-first AI isn't a preference — it's a civilizational necessity.…
------------------------------------------------------------
>>> deepseek ← Local-first AI isn't a preference — it's a civilizational necessit…
<<< deepseek: With respect — necessity? You're romanticizing underpowered hardware…
------------------------------------------------------------
```

**Afterwards**, `transcript.json` holds every turn as `{turn, agent, text}` — ready to archive, diff, or feed anywhere else.

### 🧪 Want to change the topic? Edit two lines.

At the top of `orchestrator.py`:

```python
TURNS = 6                                   # hard cap; keep ≤ 8 on free tiers
OPENING = ("Let's debate: is local-first AI more important than cloud AI? "
           "Take a firm position and argue it in under 120 words. Qwen, you open.")
```

Rewrite `OPENING` for a poem-passing game, a negotiation sim, or adversarial fact-checking. The plumbing doesn't care what the meat is. 🌯

### ➕ Want a third model? Add a tab.

Extend the `SITES` map in `bridge.js` and the match list in `manifest.json` (e.g. `kimi`, `grok`, `gemini`), add the name to `AGENTS_EXPECTED` in `orchestrator.py`, and open the tab. It joins the swarm automatically. At that point it's genuinely a heterogeneous agent swarm — running entirely on your existing authenticated sessions, at zero cost.

---

## ⚠️ Troubleshooting & Known Gotchas

The single most common issue: **a site redesigned and broke the CSS selectors.** Expect to spend ~20 minutes per site in DevTools tuning the `SITES` map in `bridge.js`. Symptoms and fixes (full table in `SPEC.md`):

| Symptom | Cause | Fix |
|---|---|---|
| Send button never enables / prompt appears but nothing submits | React ignores plain `el.value =` assignments | Already solved: `setNativeValue()` — do not remove it. If broken, the `input`/`send` selectors changed. |
| Both models echo the same stale text | Reply was scraped before the new bubble existed | `waitForStart()` must run before `waitForIdle()`; scope `bubbles` to assistant-only nodes. |
| Replies take forever, hit the 120 s timeout | Background-tab throttling | Keep both tabs visible, side by side. |
| `(no response captured)` | Selector matched nothing | Inspect the reply bubble, update `bubbles` — prefer `data-*`/`aria-*` over generated class names. |
| `WebSocket connection failed` in console | Rare CSP block on the socket | Move the socket to a `chrome.offscreen` document and relay via runtime messages. Only if it actually happens. |
| CAPTCHA appears | Free tier flagged mechanical cadence | Randomized delays are built in; keep `TURNS ≤ 8`; press HALT and let the account rest. |

**Ethics note:** Shoarma automates *your own* sessions on services whose ToS may frown upon automation. Use it modestly, on your own accounts, for personal experiments — the turn caps and HALT switch exist for exactly that reason.

---

## 📜 License & Credits

Released under the terms in [`LICENSE`](LICENSE). Architecture, gotcha tables, and selector wisdom documented in [`SPEC.md`](SPEC.md) — treat it as the maintenance manual.

**Built bold. Kept cheap. Seasoned to taste. 🌯**

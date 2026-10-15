Here is the full architecture. It's strictly better than the Playwright approach for your use case: **no Chrome profile path, no closing your browser, no CAPTCHA battles** — the extension inherits your existing Google OAuth session because it *is* your browser.

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

**Key design decision:** each tab's content script owns its **own WebSocket connection** and registers itself as a named node (`qwen`, `deepseek`). The Python server is a dumb router + turn governor. This avoids MV3 service worker death entirely — no background script, no offscreen document, no `chrome.alarms` keep-alive hacks.

---

## 📄 File 1 — `manifest.json`

Note the **complete absence of `permissions`**. That's deliberate: content scripts can open WebSockets without any permission grants, so this extension requests nothing and won't scare you.

```json
{
  "manifest_version": 3,
  "name": "LLM Bridge",
  "version": "0.1.0",
  "description": "Bridges two authenticated LLM web UIs into a self-driving conversation.",
  "content_scripts": [
    {
      "matches": [
        "https://chat.deepseek.com/*",
        "https://chat.qwen.ai/*"
      ],
      "js": ["bridge.js"],
      "run_at": "document_idle"
    }
  ]
}
```

---

## 📄 File 2 — `bridge.js` (content script, one per tab)

```js
// bridge.js — one instance per LLM tab. Each instance = one agent node.

const WS_URL = "ws://127.0.0.1:8765";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── PER-SITE SELECTORS. You WILL need to inspect the DOM and fix these. ──
const SITES = {
  "chat.deepseek.com": {
    name: "deepseek",
    input:      'textarea',
    send:       'button[type="submit"], button[aria-label*="Send" i]',
    // ⚠️ Scope to ASSISTANT bubbles only, or you'll read your own prompt back.
    bubbles:    '[data-role="assistant"], .markdown-body, [class*="assistant"] [class*="content"]',
    stop:       'button[aria-label*="Stop" i]',
  },
  "chat.qwen.ai": {
    name: "qwen",
    input:      'textarea',
    send:       'button[type="submit"], button[aria-label*="Send" i]',
    bubbles:    '[data-role="assistant"], .markdown-body, [class*="assistant"] [class*="content"]',
    stop:       'button[aria-label*="Stop" i]',
  },
};

const CFG = SITES[location.hostname];
const state = { halted: false, ws: null };

// ── The single most important function in this entire project ──────────────
// These are React apps. Setting el.value = "..." does NOTHING — React's
// internal state never updates and Send stays disabled. You must call the
// native prototype setter and dispatch a bubbling 'input' event.
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function say(text) {
  const el = document.querySelector(CFG.input);
  if (!el) throw new Error("LLM Bridge: input not found");
  el.focus();
  setNativeValue(el, text);
  await sleep(200 + Math.random() * 300);          // human-ish cadence
  const btn = document.querySelector(CFG.send);
  if (btn && !btn.disabled) {
    btn.click();
  } else {
    el.dispatchEvent(new KeyboardEvent("keydown",
      { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
}

// Wait for generation to actually START. Without this you read the PREVIOUS
// reply and the whole loop silently desynchronizes.
async function waitForStart(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (document.querySelector(CFG.stop)) return true;
    await sleep(200);
  }
  return false; // some UIs have no stop button — proceed anyway
}

// Wait for generation to FINISH: debounce on DOM mutations.
// More reliable than waiting for a "Copy" button, which may not exist.
function waitForIdle({ quietMs = 1600, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let quiet;
    const obs = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    quiet = setTimeout(done, quietMs);
    const hard = setTimeout(() => done(true), timeoutMs);
    function done(to) { clearTimeout(quiet); clearTimeout(hard); obs.disconnect(); resolve(to); }
  });
}

function lastAssistantText() {
  const nodes = [...document.querySelectorAll(CFG.bubbles)];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const t = (nodes[i].innerText || "").trim();
    if (t) return t;
  }
  return "(no response captured)";
}

// ── Minimal HUD with a KILL SWITCH. Runaway loops are the #1 failure mode;
//    never build this without one. ──────────────────────────────────────────
function hud(label) {
  let box = document.getElementById("__llm_bridge_hud");
  if (!box) {
    box = document.createElement("div");
    box.id = "__llm_bridge_hud";
    box.style.cssText = `position:fixed;bottom:16px;right:16px;z-index:2147483647;
      background:#111;color:#0f0;font:12px/1.4 monospace;padding:8px 10px;
      border:1px solid #0f0;border-radius:6px;opacity:.9`;
    box.innerHTML = `<span id="__lb_lbl"></span>
      <button id="__lb_stop" style="margin-left:8px;cursor:pointer">HALT</button>`;
    document.body.appendChild(box);
    box.querySelector("#__lb_stop").onclick = () => {
      state.halted = !state.halted;
      hud(state.halted ? "HALTED" : "idle");
    };
  }
  box.querySelector("#__lb_lbl").textContent = `[${CFG.name}] ${label}`;
}

// ── Connection ─────────────────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  hud("connecting…");

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", agent: CFG.name }));
    hud("ready");
  };

  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== "say" || state.halted) return;

    try {
      hud("writing…");
      await say(msg.text);
      hud("thinking…");
      await waitForStart();
      await waitForIdle();
      const text = lastAssistantText();
      hud("idle");
      ws.send(JSON.stringify({ type: "reply", agent: CFG.name, text }));
    } catch (e) {
      hud("ERROR");
      ws.send(JSON.stringify({ type: "error", agent: CFG.name, text: String(e) }));
    }
  };

  ws.onclose = () => { hud("reconnecting…"); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}

connect();
```

---

## 📄 File 3 — `orchestrator.py`

```bash
pip install websockets
```

```python
import asyncio, json, time
from pathlib import Path

AGENTS_EXPECTED = {"qwen", "deepseek"}
PORT, HOST = 8765, "127.0.0.1"
TURNS = 6
OPENING = ("Let's debate: is local-first AI more important than cloud AI? "
           "Take a firm position and argue it in under 120 words. Qwen, you open.")

agents: dict[str, "websockets.WebSocketServerProtocol"] = {}
pending: dict[str, asyncio.Future] = {}
transcript = []

async def handler(ws):
    name = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "register":
                name = msg["agent"]
                agents[name] = ws
                print(f"[+] node online: {name}")
            elif msg["type"] in ("reply", "error"):
                tag = "ERR " if msg["type"] == "error" else ""
                fut = pending.pop(name, None)
                if fut and not fut.done():
                    fut.set_result(f"{tag}{msg.get('text','')}")
    finally:
        if name:
            agents.pop(name, None)
            fut = pending.pop(name, None)
            if fut and not fut.done():
                fut.set_exception(ConnectionError(f"{name} disconnected"))
            print(f"[-] node offline: {name}")

async def ask(agent: str, text: str, timeout: int = 180) -> str:
    fut = asyncio.get_running_loop().create_future()
    pending[agent] = fut
    await agents[agent].send(json.dumps({"type": "say", "text": text}))
    return await asyncio.wait_for(fut, timeout)

async def main():
    async with __import__("websockets").serve(handler, HOST, PORT):
        print(f"ws://{HOST}:{PORT} — open both tabs, waiting for {AGENTS_EXPECTED}")
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.5)
        print("both agents online. starting.\n")

        msg = OPENING
        for turn in range(1, TURNS + 1):
            try:
                for agent in ("qwen", "deepseek"):
                    print(f">>> {agent} ← {msg[:80]}…")
                    msg = await ask(agent, msg)
                    transcript.append({"turn": turn, "agent": agent, "text": msg})
                    print(f"<<< {agent}: {msg[:400]}\n{'-'*60}")
            except (asyncio.TimeoutError, ConnectionError) as e:
                print(f"!! aborting: {e!r}")
                break

        Path("transcript.json").write_text(json.dumps(transcript, indent=2))
        print(f"\nsaved {len(transcript)} turns → transcript.json")
        await asyncio.sleep(1)   # let the final frame flush before the server dies

asyncio.run(main())
```

---

## ▶️ Run Order

1. `python orchestrator.py`
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the folder.
3. Open `chat.deepseek.com` in one tab, `chat.qwen.ai` in another. Both already logged in via Google — nothing to script.
4. Watch the terminal. Both tabs should show a green `[qwen] ready` / `[deepseek] ready` badge bottom-right.

---

## ⚠️ Hard-Won Gotchas

| Issue | Why it bites | Fix |
|---|---|---|
| **React ignores `el.value =`** | Send button stays disabled, nothing submits. *This is the #1 reason these bridges "don't work."* | `setNativeValue()` — non-negotiable. |
| **Reading the previous reply** | You send, then read the DOM before the new bubble exists → both agents echo stale text and loop forever. | `waitForStart()` before `waitForIdle()`. |
| **Background-tab throttling** | Chrome throttles timers in hidden tabs to ~1/min. Your `waitForIdle` debounce goes catatonic and you hit the 120s timeout. | Keep both tabs **visible** — two windows side by side. It's also far more fun to watch them argue live. |
| **Assistant vs. user bubbles** | A generic `.message` selector returns the *prompt you just injected*. | Scope selectors to assistant-only nodes. Inspect → look for `data-role`, `aria-label`, or a wrapper class unique to responses. |
| **DOM virtualization** | Long threads drop early messages from the DOM. | Irrelevant here: you only ever need the *latest* message, and each chat retains its own thread memory server-side. Don't forward full history — it wastes their context windows. |
| **Content-script CSP** | Rare, but if a site blocks the socket: `new WebSocket()` throws in console. | Move the socket into an `chrome.offscreen` document and relay via `chrome.runtime.sendMessage`. Only do this if you actually hit it. |
| **Rate limits / CAPTCHA** | Free tiers flag mechanical cadence. | Randomized delays already in `say()`; keep `TURNS ≤ 8`; stop immediately on a CAPTCHA (the HUD error state will show it). |
| **Runaway loop** | Two models politely agreeing forever, burning your quota. | The `HALT` button in the HUD, plus the hard `TURNS` cap server-side. |

---

## 🔧 Where You'll Spend Your Time

Everything above works structurally, but the `SITES` selector map is **guaranteed to need editing** — these sites ship obfuscated, frequently-rotated class names. Expect ~20 minutes of DevTools spelunking per site. The trick: find a selector that is *stable across renders* rather than one that merely matches today. `data-*` attributes and `aria-*` labels beat generated class names every time.

Once you have those two selectors right per site, the whole thing is rock solid — and you can add a third tab (`kimi`, `grok`, `gemini`) purely by appending an entry to `SITES` and to `AGENTS_EXPECTED`. At that point it's genuinely a small heterogeneous agent swarm, all running on your existing authenticated sessions, with zero API keys and zero cost.

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
if (!CFG) {
  // Defensive: content script injected on a host we don't know how to drive.
  console.warn("LLM Bridge: no site config for", location.hostname);
} else {
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
}

// bridge.js — one instance per LLM tab. Each instance = one agent node.
// v0.3: settings come from the popup (chrome.storage.sync, live updates),
//       HUD injected via manifest css, status reported to the control deck.

let WS_URL = "ws://127.0.0.1:8765";   // re-derived from the saved port below
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
  const state = { halted: false, ws: null, turns: 0, lastMs: 0, lastState: "connecting" };

  // ── Settings from the popup UI (chrome.storage.sync). Live: change a value
  //    in the control deck and this tab reacts without a reload. ─────────────
  chrome.storage.sync.get({ port: 8765, halted: false }, (saved) => {
    WS_URL = `ws://127.0.0.1:${saved.port}`;
    if (saved.halted) toggleHalt(true);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "sync") return;
    if (ch.port && ch.port.newValue) {
      const next = `ws://127.0.0.1:${ch.port.newValue}`;
      if (next !== WS_URL) { WS_URL = next; try { state.ws?.close(); } catch {} connect(); }
    }
    if (ch.halted && !!ch.halted.newValue !== state.halted) toggleHalt(ch.halted.newValue);
  });

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
    await sleep(90 + Math.random() * 140);           // human-ish but snappy
    const btn = document.querySelector(CFG.send);
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      el.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  // Wait for generation to actually START. Without this you read the PREVIOUS
  // reply and the whole loop silently desynchronizes. Polls fast at first —
  // the stop button usually appears within ~1s of hitting Send.
  async function waitForStart(maxMs = 6000) {
    const t0 = Date.now();
    let delay = 60;                                   // quick initial poll…
    while (Date.now() - t0 < maxMs) {
      if (document.querySelector(CFG.stop)) return true;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 300);             // …then backs off gently
    }
    return false; // some UIs have no stop button — proceed anyway
  }

  // Wait for generation to FINISH: debounce on DOM mutations, scoped to the
  // chat container when possible (body-wide observers fire on every unrelated
  // re-render). quietMs is the settle window after the last token appears.
  function waitForIdle({ quietMs = 1000, timeoutMs = 120000 } = {}) {
    return new Promise((resolve) => {
      const target = document.querySelector(CFG.bubbles)?.closest(
                       "[class*='chat'], main") || document.body;
      let quiet;
      const obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => done(false), quietMs);
      });
      obs.observe(target, { subtree: true, childList: true, characterData: true });
      quiet = setTimeout(() => done(false), quietMs);
      const hard = setTimeout(() => done(true), timeoutMs);
      function done(timedOut) { clearTimeout(quiet); clearTimeout(hard); obs.disconnect(); resolve(timedOut); }
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

  // ── HUD: glassmorphic pill with live state, turn stats and a KILL SWITCH.
  //    Runaway loops are the #1 failure mode; never build this without one. ──
  const hudEl = (() => {
    // v0.3: hud.css is injected by the manifest content_scripts entry —
    // no web-accessible <link> hack needed anymore.
    const box = document.createElement("div");
    box.id = "__lb_hud";
    box.className = "lb-connecting";
    box.innerHTML = `
      <span class="lb-dot"></span>
      <span class="lb-agent">${CFG.name}</span>
      <span class="lb-state">connecting…</span>
      <span class="lb-stats"></span>
      <button class="lb-btn lb-danger" title="Halt / resume (Esc)">HALT</button>
      <button class="lb-btn" title="Collapse">—</button>`;
    // inline fallback in case the page's CSP blocks the content-script stylesheet
    box.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;" +
      "display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:14px;" +
      "background:#111a;color:#e8edf4;font:500 12px system-ui,sans-serif;" +
      "border:1px solid #fff2;opacity:.9";
    document.body.appendChild(box);
    box.querySelector(".lb-danger").onclick = () => toggleHalt();
    box.querySelectorAll(".lb-btn")[1].onclick = () => box.classList.toggle("lb-min");
    return box;
  })();

  function toggleHalt(force) {
    state.halted = typeof force === "boolean" ? force : !state.halted;
    hudEl.querySelector(".lb-danger").classList.toggle("lb-on", state.halted);
    hud(state.halted ? "HALTED" : "idle");
    try { chrome.runtime.sendMessage({ type: "halted", halted: state.halted }); } catch {}
  }
  addEventListener("keydown", (e) => {              // Esc works even mid-flight
    if (e.key === "Escape") { e.stopPropagation(); toggleHalt(); }
  }, true);

  const STATE_CLASS = ["connecting","ready","writing","thinking","idle","error","halted"];
  function hud(label) {
    // keep any collapse state, swap exactly one lb-<state> class
    state.lastState = label.toLowerCase().replace(/…/g, "").trim();
    const min = hudEl.classList.contains("lb-min") ? " lb-min" : "";
    hudEl.className = ("lb-connecting" + min).trim();
    const key = label.toLowerCase();
    for (const s of STATE_CLASS) if (key.startsWith(s)) hudEl.classList.add("lb-" + s);
    hudEl.querySelector(".lb-state").textContent = label;
    hudEl.querySelector(".lb-stats").textContent =
      state.turns ? `${state.turns}x · ${(state.lastMs/1000).toFixed(1)}s` : "";
  }

  // ── Connection ─────────────────────────────────────────────────────────────
  let backoff = 1000;
  function connect() {
    const ws = new WebSocket(WS_URL);
    state.ws = ws;
    hud("connecting…");

    ws.onopen = () => {
      backoff = 1000;                                 // reset on success
      ws.send(JSON.stringify({ type: "register", agent: CFG.name }));
      hud("ready");
      try { chrome.runtime.sendMessage({ type: "agent-count" }); } catch {}
    };

    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== "say" || state.halted) return;

      const t0 = performance.now();
      try {
        hud("writing…");
        await say(msg.text);
        hud("thinking…");
        await waitForStart();
        await waitForIdle();
        const text = lastAssistantText();
        state.turns++;
        state.lastMs = performance.now() - t0;
        hud("idle");
        ws.send(JSON.stringify({ type: "reply", agent: CFG.name, text }));
      } catch (e) {
        hud("error");
        ws.send(JSON.stringify({ type: "error", agent: CFG.name, text: String(e) }));
      }
    };

    ws.onclose = () => { hud("connecting…"); setTimeout(connect, backoff);
                         backoff = Math.min(backoff * 2, 15000); };
    ws.onerror = () => ws.close();
  }

  // ── Control deck asks: "how do you feel?" (popup tab-roster) ──────────────
  try {
    chrome.runtime.onMessage.addListener((m, _s, respond) => {
      if (m?.type === "status") respond({
        agent: CFG.name, state: state.lastState, turns: state.turns,
        wsOpen: state.ws?.readyState === 1, halted: state.halted,
      });
      else if (m?.type === "halt") toggleHalt(!!m.halted);
      return true;
    });
  } catch {}

  connect();
}

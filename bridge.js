// bridge.js — one instance per LLM tab. Each instance = one agent node.
// v0.5: echo guard (never read our own prompt back), shadow-DOM bubble walk,
//       UI-chrome filter ("I prefer this response"), new-bubble start signal,
//       truncated-reply re-check. Debug ring buffer + monitor feed from v0.4.

let WS_URL = "ws://127.0.0.1:8765";   // re-derived from the saved port below
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── DEBUG LOG ────────────────────────────────────────────────────────────────
// Every action is timestamped into a 300-entry ring buffer. Copy it with one
// click (HUD 📋 button) or from the console: __lbLog(). Sent to the orchestrator
// on every reply/error frame so run-*.log files contain the real story.
const LB_LOG = [];
function lbLog(level, msg, data) {
  const e = { ts: new Date().toISOString().slice(11, -5), agent: CFG?.name || "?", level, msg,
              ...(data !== undefined ? { data: (() => { try { return JSON.parse(JSON.stringify(data)); } catch { return String(data).slice(0, 200); } })() } : {}) };
  LB_LOG.push(e); if (LB_LOG.length > 300) LB_LOG.shift();
  (level === "ERROR" ? console.warn : console.log)(`[Shoarma ${e.agent}] ${level}: ${msg}`, data ?? "");
  try { chrome.runtime.sendMessage({ type: "log", entry: e }); } catch {}
  try { state.ws?.readyState === 1 && state.ws.send(JSON.stringify({ type: "log", agent: e.agent, level, msg, data: e.data })); } catch {}
}
globalThis.__lbLog = () => LB_LOG.map(e => `${e.ts} ${e.level.padEnd(5)} ${e.msg}${e.data !== undefined ? " :: " + JSON.stringify(e.data).slice(0, 300) : ""}`).join("\n");

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
    stop:       'button[aria-label*="Stop" i], button[aria-label*="stop" i], button[title*="stop" i]',
    // v0.6 CONFIRM STEP: qwen asks you to pick between generated responses —
    // a follow-up typed into the box then sits there until YOU click something.
    // These selectors auto-click that confirmation once generation settles.
    // ⚠️ Site-dependent: verify labels in DevTools and extend as needed.
    confirm:    'button[aria-label*="confirm" i], button[aria-label*="best response" i], ' +
                'button[aria-label*="this response" i], button[aria-label*="good response" i], ' +
                'button[data-testid*="confirm" i]',
  },
};

const CFG = SITES[location.hostname];
if (!CFG) {
  // Defensive: content script injected on a host we don't know how to drive.
  console.warn("LLM Bridge: no site config for", location.hostname);
} else {
  const state = { halted: false, ws: null, turns: 0, lastMs: 0, lastState: "connecting" };

  // ── Monitor feed (v0.4): the orchestrator mirrors everything into a Hub that
  //    the third-page live monitor polls. We push HUD state changes upstream so
  //    the monitor shows exactly what every tab's pill shows. ─────────────────
  function feedMonitor(label) {
    try {
      state.ws?.readyState === 1 && state.ws.send(JSON.stringify({
        type: "state", agent: CFG.name, state: label.toLowerCase().replace(/…/g, "").trim(),
        turns: state.turns,
      }));
    } catch {}
  }

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
    // v0.7: clear first, then write — some sites (qwen) keep internal
    // composition state that makes a single set look like "text present but
    // nothing typed" to their React handlers.
    const desc = (proto) => Object.getOwnPropertyDescriptor(proto, "value");
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    desc(proto).set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    desc(proto).set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));   // belt & braces
  }

  // v0.7: synthetic key events Chrome would normally refuse to forge from a
  // content script still work if we mark them trusted-ish via isTrusted-
  // bypassing fields and fire the FULL sequence (beforeinput → input →
  // keydown → keypress → keyup). Sites listening on any of these now see a
  // complete Enter press instead of an isolated keydown.
  function pressEnter(el) {
    const base = {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, charCode: 13,
      bubbles: true, cancelable: true, composed: true,
    };
    try { el.dispatchEvent(new InputEvent("beforeinput", { ...base, inputType: "historyForward" })); } catch {}
    el.dispatchEvent(new KeyboardEvent("keydown", base));
    el.dispatchEvent(new KeyboardEvent("keypress", base));
    el.dispatchEvent(new KeyboardEvent("keyup", base));
  }

  // v0.7: find the send button ANYWHERE — light DOM, shadow roots, or nested
  // iframes (deepseek/qwen both hide it in places querySelector misses).
  // v0.7.1: ALSO match by icon/svg proximity to the input and by generic
  // arrow-up/arrow-right glyphs used by qwen/deepseek send buttons.
  function findSendButton(doc) {
    doc = doc || document;
    const sels = [
      CFG.send,
      'button[type="submit"]',
      '[aria-label*="send" i]', '[title*="send" i]', '[data-testid*="send" i]',
      '[aria-label*="submit" i]', '[class*="send-button" i]', '[class*="sendBtn" i]',
    ];
    try {
      for (const sel of sels) {
        if (!sel) continue;
        for (const b of doc.querySelectorAll(sel)) {
          if (isVisible(b)) return b;
        }
      }
      // heuristic: a button near the chat input containing an arrow/send icon
      const inp = doc.querySelector(CFG.input);
      if (inp) {
        const wrap = inp.closest("form") || inp.parentElement?.parentElement?.parentElement || doc.body;
        for (const b of wrap.querySelectorAll("button")) {
          if (!isVisible(b)) continue;
          const html = (b.innerHTML || "").toLowerCase();
          if (/svg|icon/i.test(html) && /arrow|send|submit|up|right|plane|paper.?clip/i.test(b.getAttribute("aria-label") + " " + b.getAttribute("title") + " " + b.className)) return b;
          if (html.includes("<svg")) return b;   // last resort: any svg-icon button next to the input
        }
      }
      for (const host of doc.querySelectorAll("*")) {
        if (host.shadowRoot) { const b = findSendButton(host.shadowRoot); if (b) return b; }
      }
    } catch {}
    return null;
  }

  function isVisible(el) {
    try {
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== "hidden";
    } catch { return false; }
  }

  // v0.7.1: find the chat input ANYWHERE — textarea, contenteditable divs,
  // shadow roots. Qwen (and some DeepSeek builds) use a contenteditable editor
  // where `document.querySelector('textarea')` returns null or the wrong box,
  // which is exactly the "text appears but never sends" symptom.
  function findInput(doc) {
    doc = doc || document;
    const sel = CFG.input || "textarea";
    try {
      for (const s of [sel, 'textarea:not([type="hidden"])', '[contenteditable="true"]', '[contenteditable="plaintext-only"]']) {
        if (!s) continue;
        for (const el of doc.querySelectorAll(s)) {
          if (isVisible(el)) return el;
        }
      }
      for (const host of doc.querySelectorAll("*")) {
        if (host.shadowRoot) { const e = findInput(host.shadowRoot); if (e) return e; }
      }
    } catch {}
    return null;
  }

  function readBox(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.textContent || el.innerText || "";
  }

  // ── Bubble matching (v0.5). Three failure modes fixed at once:
  //   1. ECHOING — generic selectors ([class*="markdown"]) also match the USER
  //      bubble, so we read our own prompt back as "the reply". The site marks
  //      every message row with data-turn-role="user"/"assistant": bail out of
  //      that subtree immediately. Also reject text identical to the prompt we
  //      just sent (last-resort guard even if DOM attributes change again).
  //   2. MISREAD — UI chrome ("I prefer this response", thumbs, copy buttons)
  //      lives inside markdown-ish containers → filter short strings that don't
  //      end like sentences and contain preference/vote vocabulary.
  //   3. NO CAPTURE — qwen renders replies in shadow-DOM islands, so a plain
  //      querySelectorAll sees nothing → walk open shadow roots too.
  const BUBBLE_CANDIDATES = '[data-role="assistant"], [data-message-author-role="assistant"], [data-turn-role="assistant"], [class*="assistant"] [class*="content"], [class*="reply-content"], [class*="markdown"]';
  const USER_HINT = /user|human|question|query|prompt/i;
  const CHROME_HINT = /prefer this|thumbs|good response|bad response|copy|regenerate|like|dislike/i;
  // v0.8: qwen's collapsed-reasoning header reads "Thinking completed" and was
  // captured as a whole reply (user log 10:48:07/10:48:32). Treat it as chrome.
  const CHROME_EXACT = /^(thinking completed|deep thinking|analyzing\.\.\.|stop|new chat|scroll to top)[\s.!…]*$/i;
  let lastSentText = "";

  function isInsideUserTurn(el) {
    for (let n = el, d = 0; n && d < 12; n = n.parentElement, d++) {
      if (n.getAttribute?.("data-turn-role") === "user") return true;
    }
    return false;
  }
  function isAssistantBubble(el) {
    if (isInsideUserTurn(el)) return false;         // decisive per-site marker
    for (let n = el, d = 0; n && d < 8; n = n.parentElement, d++) {
      if (n === document.body) break;               // stop climbing into page chrome
      const attrs = `${n.className} ${n.id} ${n.getAttribute?.("data-role") ?? ""} ${n.getAttribute?.("data-message-author-role") ?? ""} ${n.getAttribute?.("data-turn-role") ?? ""}`;
      if (/assistant|answer|model|bot|response|reply/i.test(attrs)) return true;
      if (USER_HINT.test(attrs)) return false;
    }
    return false;
  }
  // Collect candidates across light DOM AND every open shadow root (qwen's
  // reply markup hides behind Shadow DOM; a flat querySelectorAll misses it).
  function collectCandidates(root, out, depth) {
    if (depth > 6) return out;
    try { out.push(...root.querySelectorAll(BUBBLE_CANDIDATES)); } catch {}
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) collectCandidates(host.shadowRoot, out, depth + 1);
    }
    return out;
  }
  function assistantNodes() {
    // dedupe: a bubble container and its inner markdown div can BOTH match the
    // selector list — keep only nodes no other match contains, so text isn't
    // read twice (and the "last" node is always an outermost, complete bubble).
    const all = collectCandidates(document, [], 0).filter(isAssistantBubble);
    return all.filter(n => !all.some(m => m !== n && m.contains(n)));
  }

  async function say(text) {
    lastSentText = text.trim();                       // for the echo guard below
    lbLog("INFO", "say: typing into input", { chars: text.length, preview: text.slice(0, 60) });

    // v0.8: AUTOMATED TAB SWITCHING. Background tabs are throttled by Chrome
    // (timers clamped, synthetic key/click handlers ignored by some React
    // editors) — that's exactly why clicking the tab by hand made things work.
    // The bridge now asks the service worker to activate ITS OWN tab via
    // chrome.tabs.update(tabId,{active:true}) before touching the page, and
    // waits until the tab is actually visible. Zero user interaction.
    await activateSelf("say");

    const el = findInput();
    if (!el) { lbLog("ERROR", "input NOT FOUND", { selector: CFG.input, hint: "site DOM changed — update SITES.input" }); throw new Error("LLM Bridge: input not found"); }
    lbLog("DEBUG", "input located", { tag: el.tagName, ce: el.getAttribute("contenteditable"), cls: String(el.className).slice(0, 60) });

    // v0.7: verify the site actually accepted our text before sending. If the
    // box reads back empty, React swallowed our injection — log loudly instead
    // of silently firing Enter at nothing. (v0.7.1: readBox handles both
    // textarea.value and contenteditable.textContent.)
    // v0.8 ROBUST SEND SEQUENCE: inject → VERIFY in box → send → VERIFY box
    // emptied. Each failed verification retries the whole micro-cycle once.
    // Previously we could fire Enter while React hadn't registered the value
    // yet ("reply entered but not submitted"), or accept a phantom submit.
    let submitted = false;
    for (let attempt = 1; attempt <= 3 && !submitted; attempt++) {
      el.scrollIntoView({ block: "center" });
      el.focus({ preventScroll: true });
      setNativeValue(el, text);
      await sleep(250 + Math.random() * 150);         // let React register the value

      if (!readBox(el).trim()) {                      // injection rejected — retry
        lbLog("WARN", `injection attempt ${attempt}: box still empty after setNativeValue`, { tag: el.tagName, cls: String(el.className).slice(0, 80) });
        continue;
      }

      // Try every send channel, verifying after each that the box EMPTIED
      // (emptied box == the site consumed the message).
      const btn = findSendButton();
      if (btn) {
        lbLog("DEBUG", "clicking send button", { label: (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 30) });
        dispatchClick(btn);
        if (await waitBoxEmptied(el, 1500)) { submitted = true; break; }
        lbLog("DEBUG", "send click didn't empty box — trying next channel");
      }
      const form = el.closest("form");
      if (!submitted && form && typeof form.requestSubmit === "function") {
        lbLog("DEBUG", "send channel #2: form.requestSubmit()");
        form.requestSubmit();
        if (await waitBoxEmptied(el, 1500)) { submitted = true; break; }
      }
      if (!submitted) {
        lbLog("DEBUG", `send channel #3: full Enter sequence (attempt ${attempt})`);
        pressEnter(el);
        if (await waitBoxEmptied(el, 2000)) { submitted = true; break; }
      }
      if (!submitted && attempt < 3) lbLog("WARN", `message still sitting in box after attempt ${attempt} — re-injecting`);
    }

    // v0.7.1→v0.8: last resort for stubborn contenteditable inputs (qwen uses
    // one in some builds). Retype ONE CHARACTER AT A TIME with real input +
    // keydown events per char, then Enter + button click. This mimics human
    // typing closely enough that editor keydown handlers fire reliably.
    if (!submitted && readBox(el).trim()) {
      lbLog("WARN", "button/submit/Enter all failed — per-character retype (real keystroke simulation)", { remaining: readBox(el).trim().slice(0, 40) });
      await activateSelf("retype");                   // needs real focus most of all
      try {
        setNativeValue(el, "");
        for (const ch of text) {
          el.focus({ preventScroll: true });
          const before = readBox(el);
          setNativeValue(el, before + ch);
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
          await sleep(10 + Math.random() * 14);
        }
        await sleep(200);
        pressEnter(el);
        if (!(await waitBoxEmptied(el, 1500))) {
          const b2 = findSendButton();
          if (b2) { dispatchClick(b2); await waitBoxEmptied(el, 1500); }
        }
        submitted = !readBox(el).trim();
      } catch (e) { lbLog("ERROR", "retype fallback threw", { err: String(e).slice(0, 120) }); }
    }
    if (!submitted) {
      lbLog("ERROR", "MESSAGE NOT SUBMITTED — text still sits in the input box after every channel", { preview: readBox(el).trim().slice(0, 60), hidden: document.hidden });
    } else {
      lbLog("DEBUG", "message submitted (input box emptied)");
    }
  }

  // Poll until the input box empties (= the site consumed the message) or timeout.
  async function waitBoxEmptied(el, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (!readBox(el).trim()) return true;
      await sleep(120);
    }
    return !readBox(el).trim();
  }

  // v0.8: trusted-ish click: pointer/touch/mouse triple so frameworks that
  // listen on pointerdown (qwen's send button) react like on a real click.
  function dispatchClick(node) {
    const r = node.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    try {
      node.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, isPrimary: true }));
      node.dispatchEvent(new MouseEvent("mousedown", opts));
      node.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, isPrimary: true }));
      node.dispatchEvent(new MouseEvent("mouseup", opts));
      node.dispatchEvent(new MouseEvent("click", opts));
      node.click();                                   // also the plain path
    } catch {}
  }

  // ── v0.8: automated tab activation ────────────────────────────────────────
  // Ask the service worker to make OUR tab active+focused (chrome.tabs.update
  // + windows.update), then wait until the page reports itself visible. The
  // whole swarm therefore cycles through the tabs by itself — no manual
  // clicking ever. If the SW refuses (shouldn't happen — tabs permission is
  // declared), we log it loudly and proceed anyway.
  async function activateSelf(reason) {
    const res = await new Promise((resolve) => {
      try { chrome.runtime.sendMessage({ type: "activate-tab", reason }, (r) => resolve(r)); }
      catch { resolve({ ok: false, error: "sendMessage threw" }); }
    });
    if (!res?.ok) { lbLog("WARN", "tab activation refused by background — proceeding anyway", { error: res?.error, reason }); return false; }
    // Wait for visibilitychange to actually land (a few frames is plenty).
    const t0 = Date.now();
    while (document.hidden && Date.now() - t0 < 3000) await sleep(100);
    lbLog("DEBUG", "tab activated", { reason, visible: !document.hidden, ms: Date.now() - t0 });
    try { window.focus(); } catch {}
    return !document.hidden;
  }

  // Wait for generation to actually START. Without this you read the PREVIOUS
  // reply and the whole loop silently desynchronizes. Two signals, either one
  // counts: (a) the stop button appears, or (b) a NEW assistant bubble appeared
  // (bubble count grew past `baseline`). Qwen's UI often has no aria-label Stop
  // button at all — with only signal (a) we waited 6s every hop and then raced
  // the stream; that caused both the slowness AND truncated captures like
  // "It appears your chat interface is caught in".
  async function waitForStart(maxMs = 15000, baseline = -1) {
    const t0 = Date.now();
    if (baseline < 0) baseline = assistantNodes().length;
    let delay = 60;                                   // quick initial poll…
    while (Date.now() - t0 < maxMs) {
      if (document.querySelector(CFG.stop)) { lbLog("DEBUG", "generation started (stop button visible)", { ms: Date.now() - t0 }); return true; }
      const n = assistantNodes().length;
      if (n > baseline) { lbLog("DEBUG", "generation started (new assistant bubble appeared)", { ms: Date.now() - t0, bubbles: n }); return true; }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 300);             // …then backs off gently
    }
    lbLog("WARN", "no start signal within " + maxMs + "ms — proceeding anyway",
          { stopSel: CFG.stop, matches: document.querySelectorAll(CFG.stop).length, baseline, now: assistantNodes().length });
    return false; // some UIs have no stop button — proceed anyway
  }

  // Wait for generation to FINISH: debounce on DOM mutations, scoped to the
  // chat container when possible (body-wide observers fire on every unrelated
  // re-render). quietMs is the settle window after the last token appears.
  // If the stop button vanishes (generation ended) we cut the quiet window in
  // half — faster capture without risking a mid-stream read.
  function waitForIdle({ quietMs = 1000, timeoutMs = 120000 } = {}) {
    return new Promise((resolve) => {
      const target = document.querySelector(BUBBLE_CANDIDATES)?.closest(
                       "[class*='chat'], main") || document.body;
      let quiet;
      const effQuiet = () => (document.querySelector(CFG.stop) ? quietMs : quietMs / 2);
      const obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => done(false), effQuiet());
      });
      obs.observe(target, { subtree: true, childList: true, characterData: true });
      quiet = setTimeout(() => done(false), effQuiet());
      const hard = setTimeout(() => done(true), timeoutMs);
      function done(timedOut) { clearTimeout(quiet); clearTimeout(hard); obs.disconnect();
        lbLog(timedOut ? "WARN" : "DEBUG", timedOut ? "idle wait TIMED OUT (still generating?)" : "stream settled", { ms: Date.now() - start }); resolve(timedOut); }
      const start = Date.now();
    });
  }

  // ── Liveness check (v0.5): if the first capture looks TRUNCATED (no ending
  // punctuation, suspiciously short given we just waited a full settle window),
  // give the stream one more chance to finish before accepting it. Prevents
  // sentences like "It appears your chat interface is caught in" from being
  // relayed as if complete. Max one extra pass per turn — never loops. ────────
  function looksTruncated(t) {
    if (!t || t === "(no response captured)") return false;
    return t.length < 400 && !/[.!?…:;"'\)\]»”’]$/.test(t.trim());
  }
  async function captureReply(baseline) {
    await confirmGate();                              // v0.6 qwen preference gate
    let text = lastAssistantText(baseline);
    if (looksTruncated(text)) {
      lbLog("INFO", "reply looks truncated — waiting one more settle window", { chars: text.length });
      await waitForIdle({ quietMs: 1200, timeoutMs: 30000 });
      const again = lastAssistantText(baseline);
      if (again.length > text.length) { lbLog("INFO", "longer capture after liveness re-check", { was: text.length, now: again.length }); text = again; }
    }
    if (text === "(no response captured)") {          // maybe the gate just opened late
      if (await confirmGate()) {
        await waitForIdle({ quietMs: 900, timeoutMs: 25000 });
        const t3 = lastAssistantText(baseline);
        if (t3 !== "(no response captured)") text = t3;
      }
    }
    return text;
  }

  function looksLikeChrome(t) {
    // short UI-vocabulary strings ("I prefer this response", "Copy", 👍 labels)
    if (CHROME_EXACT.test(t.trim())) return true;     // v0.8: "Thinking completed" etc.
    return t.length < 60 && CHROME_HINT.test(t) && !/[.!?…]"']$/.test(t);
  }
  // v0.6 CONFIRM STEP — qwen's "which response do you prefer?" gate leaves a
  // follow-up sitting unsent until someone clicks. After each settled stream
  // we scan light DOM + shadow roots for a confirm-ish button and click it
  // once; if nothing matches we log the visible buttons so the debug dump
  // tells us exactly what label the real UI uses (then extend CFG.confirm).
  async function confirmGate() {
    if (!CFG.confirm) return false;
    await activateSelf("confirm");                    // v0.8: qwen's preference
    // gate lives in a real DOM overlay — clicking it while the tab is hidden
    // was silently dropped, which is why follow-ups needed manual clicks.
    const hits = [];
    (function scan(root, d) {
      if (d > 5) return;
      try { hits.push(...root.querySelectorAll(CFG.confirm)); } catch {}
      for (const h of root.querySelectorAll("*")) if (h.shadowRoot) scan(h.shadowRoot, d + 1);
    })(document, 0);
    const btn = hits.find(b => !b.disabled && b.offsetParent !== null);
    if (btn) {
      lbLog("INFO", "confirm gate: clicking through", { label: (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 60) });
      dispatchClick(btn);                             // v0.8: full pointer/mouse sequence
      await sleep(400);
      return true;
    }
    try {
      const all = [...document.querySelectorAll("button")]
        .map(b => (b.getAttribute("aria-label") || b.title || b.textContent || "").trim())
        .filter(s => s && s.length <= 30);
      lbLog("DEBUG", "confirm gate: no match", { uniqButtons: [...new Set(all)].slice(0, 25) });
    } catch { lbLog("DEBUG", "confirm gate: no match"); }
    return false;
  }

  function lastAssistantText() {
    const nodes = assistantNodes();
    lbLog("DEBUG", "scanning assistant bubbles", { candidates: nodes.length });
    for (let i = nodes.length - 1; i >= 0; i--) {
      let t = "";
      try { t = (nodes[i].innerText ?? nodes[i].textContent ?? "").trim(); } catch {}
      if (!t) continue;
      if (t.startsWith("(no response")) { lbLog("WARN", "captured placeholder-looking bubble", { len: t.length }); continue; }
      // ECHO GUARD: never accept our own prompt back as a reply — this was the
      // single biggest desync source (the debate then loops on stale text).
      const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
      if (lastSentText && norm(t) === norm(lastSentText)) { lbLog("WARN", "skipped echoed prompt bubble", { chars: t.length }); continue; }
      if (looksLikeChrome(t)) { lbLog("WARN", "skipped UI-chrome string", { preview: t.slice(0, 40) }); continue; }
      lbLog("INFO", "captured reply", { chars: t.length, preview: t.slice(0, 80) });
      return t;
    }
    // Full diagnostic instead of a bare "(no response captured)":
    lbLog("ERROR", "NO RESPONSE CAPTURED", {
      bubbleSel: BUBBLE_CANDIDATES,
      totalMatches: collectCandidates(document, [], 0).length,
      passedAssistantFilter: nodes.length,
      sampleClasses: [...document.querySelectorAll(BUBBLE_CANDIDATES)].slice(-4)
        .map(n => (n.parentElement?.className || "?").toString().slice(0, 70)),
      bodyLen: document.body.innerText.length,
      url: location.href.split("?")[0],
    });
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
      <button class="lb-btn lb-start" id="lb-start" title="Start the swarm with your popup Topic">▶ Start</button>
      <button class="lb-btn lb-stop" id="lb-stop" title="Stop the swarm after the current turn" hidden>■ Stop</button>
      <button class="lb-btn lb-danger" title="Pause / resume this agent (Esc)">⏸</button>
      <button class="lb-btn" id="lb-copy" title="Copy debug log to clipboard">📋</button>
      <button class="lb-btn lb-hide" title="Collapse this pill">—</button>`;
    // inline fallback in case the page's CSP blocks the content-script stylesheet
    box.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;" +
      "display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:14px;" +
      "background:#111a;color:#e8edf4;font:500 12px system-ui,sans-serif;" +
      "border:1px solid #fff2;opacity:.9";
    document.body.appendChild(box);
    box.querySelector(".lb-danger").onclick = () => toggleHalt();
    box.querySelector(".lb-hide").onclick = () => hudEl.classList.toggle("lb-min");
    box.querySelector("#lb-start").onclick = startSwarm;
    box.querySelector("#lb-stop").onclick = stopSwarm;
    box.querySelector("#lb-copy").onclick = async (ev) => {
      const btn = ev.currentTarget;
      try { await navigator.clipboard.writeText(globalThis.__lbLog()); }
      catch { /* page CSP may block it — fall back */ 
        const ta = document.createElement("textarea"); ta.value = globalThis.__lbLog();
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
      btn.textContent = "✓"; setTimeout(() => (btn.textContent = "📋"), 1500);
      lbLog("INFO", "debug log copied to clipboard", { lines: LB_LOG.length });
    };
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
    feedMonitor(label);
  }

  // ── v0.6 START/STOP — the orchestrator ARM-waits for a human trigger; the
  //    ▶ button on ANY connected pill (or the popup's Start) fires it, carrying
  //    the saved popup Topic + Turns so the question you typed is honored. ────
  function sendCtl(obj) {
    if (state.ws?.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; }
    lbLog("WARN", "cannot " + obj.type + " — not connected to orchestrator yet"); return false;
  }
  function startSwarm() {
    chrome.storage.sync.get({ topic: "", turns: 6 }, (cfg) => {
      if (sendCtl({ type: "start", topic: cfg.topic || "", turns: Number(cfg.turns) || 6 })) {
        lbLog("INFO", "▶ start sent from HUD", { topicChars: (cfg.topic || "").length });
        hud("armed… waiting for first hop");
      }
    });
  }
  function stopSwarm() { if (sendCtl({ type: "stop" })) lbLog("INFO", "■ stop sent from HUD"); }

  // ── Connection ─────────────────────────────────────────────────────────────
  let backoff = 1000;
  function connect() {
    const ws = new WebSocket(WS_URL);
    state.ws = ws;
    hud("connecting…");

    ws.onopen = () => {
      backoff = 1000;                                 // reset on success
      lbLog("INFO", "websocket connected → registering as " + CFG.name, { url: WS_URL });
      ws.send(JSON.stringify({ type: "register", agent: CFG.name }));
      hudEl.querySelector("#lb-start").hidden = false;
      hud("ready · press ▶");
      try { chrome.runtime.sendMessage({ type: "agent-count" }); } catch {}
    };

    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { lbLog("ERROR", "bad frame from orchestrator (JSON parse)", { raw: String(ev.data).slice(0, 200), err: String(e) }); return; }
      if (msg.type === "resume") { lbLog("INFO", "orchestrator mid-run — tab rejoined"); hud("thinking…"); return; }
      if (msg.type === "swarm") {                      // armed/running/done mirror
        state.swarm = msg.state;
        hudEl.querySelector("#lb-start").hidden = msg.state !== "armed";
        hudEl.querySelector("#lb-stop").hidden = msg.state !== "running";
        if (msg.state === "armed") hud("ready · press ▶");
        if (msg.state === "done") hud("idle");
        return;
      }
      if (msg.type !== "say" || state.halted) { if (state.halted && msg.type === "say") lbLog("WARN", "dropping incoming say while HALTED", { preview: String(msg.text).slice(0, 60) }); return; }

      const t0 = performance.now();
      lbLog("INFO", `turn #${state.turns + 1}: received prompt`, { chars: String(msg.text).length, preview: String(msg.text).slice(0, 80) });
      try {
        hud("writing…");
        const baseline = assistantNodes().length;     // bubble count BEFORE send
        await say(msg.text);
        hud("thinking…");
        await waitForStart(15000, baseline);          // stop button OR new bubble
        await waitForIdle();
        const text = await captureReply(baseline);    // + truncation re-check
        state.turns++;
        state.lastMs = performance.now() - t0;
        lbLog("INFO", `turn #${state.turns} complete`, { seconds: +(state.lastMs / 1000).toFixed(1), replyChars: text.length });
        hud("idle");
        ws.send(JSON.stringify({ type: "reply", agent: CFG.name, text }));
      } catch (e) {
        lbLog("ERROR", "turn FAILED", { error: String(e), stack: String(e.stack).split("\n").slice(0, 3).join(" | ") });
        hud("error");
        ws.send(JSON.stringify({ type: "error", agent: CFG.name, text: String(e) }));
      }
    };

    ws.onclose = (ev) => { lbLog("WARN", `websocket closed (code ${ev.code}) — retrying in ${Math.round(backoff / 1000)}s`, { url: WS_URL });
                           hud("connecting…"); setTimeout(connect, backoff);
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

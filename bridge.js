// bridge.js — one instance per LLM tab. Each instance = one agent node.
// v0.5: echo guard (never read our own prompt back), shadow-DOM bubble walk,
//       UI-chrome filter ("I prefer this response"), new-bubble start signal,
//       truncated-reply re-check. Debug ring buffer + monitor feed from v0.4.

let WS_URL = "ws://127.0.0.1:8765";   // re-derived from the saved port below
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── TRANSPORT ABSTRACTION (v0.9) ────────────────────────────────────────────
// Two ways to reach an orchestrator:
//   • "engine": the in-browser swarm-engine.js service worker (python-free
//     default) — chrome.runtime messaging, no sockets, no localhost.
//   • "ws": a remote orchestrator.py over ws://127.0.0.1:<port>.
// Both expose the same frame vocabulary: register / say / reply / send_failed
// / error / start / stop / halted / clear_input / state / swarm.
let transport = null;                 // { mode, send(obj), alive() }
function setEngineTransport() {
  transport = {
    mode: "engine",
    send(obj) { try { chrome.runtime.sendMessage({ ...obj, agent: CFG.name }); } catch {} },
    alive() { return true; },
  };
}
function setWsTransport(ws) {
  transport = {
    mode: "ws",
    send(obj) { try { ws.readyState === 1 && ws.send(JSON.stringify(obj)); } catch {} },
    alive() { return ws.readyState === 1; },
  };
}

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
  try { transport?.send({ type: "log", agent: e.agent, level, msg, data: e.data }); } catch {}
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
  let busy = false;                                   // v0.8.3: single-flight turn guard
  let pendingSay = null;                              // v0.8.3: newest say queued while busy

  // ── Monitor feed (v0.4): the orchestrator mirrors everything into a Hub that
  //    the third-page live monitor polls. We push HUD state changes upstream so
  //    the monitor shows exactly what every tab's pill shows. ─────────────────
  function feedMonitor(label) {
    try {
      transport?.send({
        type: "state", agent: CFG.name, state: label.toLowerCase().replace(/…/g, "").trim(),
        turns: state.turns,
      });
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
    if (isCE(el)) { setCEValue(el, value); return; }
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

  // ── v0.8.2: contenteditable support. Qwen's editor is sometimes a plain
  // <textarea> and sometimes a CE div ("ime-text-area") whose React handler
  // IGNORES synthetic events on the host and reads its model from the hidden
  // IME proxy textarea instead. That's why 9k-char messages sat in the box
  // forever: text was visible, state was empty, Send stayed disabled.
  // The reliable path for CE editors is an *executed* beforeinput event with
  // inputType "insertFromDrop"/"insertText" — execCommand routes through the
  // browser's own editing pipeline so the framework sees real mutations.
  const isCE = (el) => !!el && (el.getAttribute?.("contenteditable") === "true" ||
                                 el.getAttribute?.("contenteditable") === "plaintext-only");
  function setCEValue(el, value) {
    try { document.execCommand("selectAll"); } catch {}
    let ok = false;
    try {
      const evt = new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: "insertFromDrop", data: value,
      });
      ok = el.dispatchEvent(evt) === false;           // false ⇒ app called preventDefault ⇒ handled
    } catch {}
    if (!ok) {
      try { ok = document.execCommand("insertText", false, value); } catch { ok = false; }
    }
    if (!ok || !readBox(el).trim()) {                 // last resort: direct DOM write
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  }
  function ceInsertAtCaret(el, chunk) {
    // v0.8.2: retype fallback used to rewrite the WHOLE buffer per character —
    // O(n²), ~140s for a 9k message, and it interleaved every char with the
    // site's own caret writes (the scrambled boxes in the user log). Now we
    // insert small chunks at the caret via one executed beforeinput each.
    try {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const inside = range && (el.contains(range.startContainer) || range.startContainer === el);
      if (!inside) {                                   // place caret at end of editor
        const r = document.createRange();
        r.selectNodeContents(el); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      }
    } catch {}
    let ok = false;
    try {
      const evt = new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: "insertText", data: chunk,
      });
      ok = el.dispatchEvent(evt) === false;
    } catch {}
    if (!ok) { try { ok = document.execCommand("insertText", false, chunk); } catch { ok = false; } }
    if (!ok) {                                         // manual append fallback
      try { el.appendChild(document.createTextNode(chunk)); } catch {}
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: chunk }));
    }
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
      // v0.8.2: the site's OWN input selector wins (a real <textarea> is never
      // mistaken for the hidden IME proxy textarea CE editors keep around).
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

  // ── v0.8.2: React state probe. The single most useful diagnostic we ever
  // lacked: a box can LOOK full (readBox returns text) while React's internal
  // value is "" — which is exactly why send clicks silently did nothing and
  // turns captured STALE replies. Reading the element's __reactFiber/__reactProps
  // chain tells us whether our injection actually landed in the app's model.
  function reactValueOf(el) {
    try {
      for (const k of Object.keys(el)) {
        if (!k.startsWith("__reactFiber$") && !k.startsWith("__reactProps$")) continue;
        let node = el[k], hops = 0;
        while (node && hops++ < 30) {
          const p = node.memoizedProps || node.pendingProps;
          if (p && typeof p.value === "string") return p.value;
          node = node.return;
        }
      }
    } catch {}
    return null;                                       // no fiber found — unknown
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
  let lastCapturedNorm = "";                          // v0.8.3: stale-reply guard

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
      // v0.8.2: React-state verification. If the fiber's controlled value is
      // "" while the DOM looks full, NO send channel can work — the app
      // literally believes the box is empty. Log it loudly and skip straight
      // to the retype fallback instead of burning 3 × 6 seconds on dead clicks.
      const rv = reactValueOf(el);
      if (rv !== null && !rv.trim() && text.trim()) {
        lbLog("WARN", `injection attempt ${attempt}: DOM full but React state EMPTY — synthetic events ignored by editor`,
              { tag: el.tagName, ce: isCE(el), domChars: readBox(el).length });
        if (attempt < 3) continue;
      } else if (rv !== null) {
        lbLog("DEBUG", `react state ok (${rv.length} chars)`, { attempt });
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

    // v0.7.1→v0.8→v0.8.2: last resort for stubborn editors. The old retype
    // rewrote the ENTIRE buffer per character (O(n²), ~140s for a 9k message)
    // and its synthetic events fed the site's caret handler too — producing
    // interleaved garbage like "H:e\nrOeb'jse...". New approach: clear once,
    // then insert SMALL CHUNKS at the caret via executed beforeinput /
    // execCommand so React commits state between chunks. ~30× faster and the
    // text lands in order.
    if (!submitted && readBox(el).trim()) {
      lbLog("WARN", "button/submit/Enter all failed — chunked caret retype", { remaining: readBox(el).trim().slice(0, 40) });
      await activateSelf("retype");                   // needs real focus most of all
      try {
        setNativeValue(el, "");                       // ONE clean clear
        el.focus({ preventScroll: true });
        const CH = isCE(el) ? 64 : 120;               // CE handlers commit slower
        for (let i = 0; i < text.length; i += CH) {
          el.focus({ preventScroll: true });
          const chunk = text.slice(i, i + CH);
          if (isCE(el)) ceInsertAtCaret(el, chunk);
          else {
            const before = readBox(el);
            const d = Object.getOwnPropertyDescriptor(
              el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
            d.set.call(el, before + chunk);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: chunk }));
          }
          await sleep(isCE(el) ? 30 : 15);
        }
        await sleep(250);
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
      // v0.9: tell the orchestrator/engine explicitly so it can cool down and
      // re-dispatch instead of us throwing a generic error mid-turn.
      try { transport?.send({ type: "send_failed", agent: CFG.name, preview: readBox(el).trim().slice(0, 80) }); } catch {}
      throw new Error("LLM Bridge: message not submitted");   // v0.8.2: FAIL LOUDLY
    }
    lbLog("DEBUG", "message submitted (input box emptied)");
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
    // v0.8.2: the STOP-BUTTON signal alone is NOT proof of a new turn — qwen
    // keeps one in the DOM between chats, so we "confirmed" starts that never
    // happened and then captured the PREVIOUS reply (turns #4/#10/#11 in the
    // user log returned byte-identical text seconds after a failed send).
    // New rule: require either a genuinely NEW bubble, or an existing last
    // bubble whose TEXT GREW after we saw the stop button.
    let sawStop = false;
    const lastLen = () => { const n = assistantNodes(); return n.length ? norm(n[n.length - 1].innerText ?? "").length : 0; };
    const baseLen = lastLen();
    while (Date.now() - t0 < maxMs) {
      const nowStop = !!document.querySelector(CFG.stop);
      if (nowStop) sawStop = true;
      const n = assistantNodes().length;
      if (n > baseline) { lbLog("DEBUG", "generation started (new assistant bubble appeared)", { ms: Date.now() - t0, bubbles: n }); return true; }
      if (sawStop && lastLen() > baseLen + 20) { lbLog("DEBUG", "generation started (stop button + last bubble growing)", { ms: Date.now() - t0 }); return true; }
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

  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();

  function looksLikeChrome(t) {
    // short UI-vocabulary strings ("I prefer this response", "Copy", 👍 labels)
    if (CHROME_EXACT.test(t.trim())) return true;     // v0.8: "Thinking completed" etc.
    // v0.8.2: qwen's error toast ("Oops! There was an issue connecting to…")
    // and bare reasoning headers were relayed as full replies (user log
    // 14:57/15:05). Treat them as chrome so the orchestrator retries the hop.
    if (/^oops!?\b/i.test(t.trim()) || /was an issue connecting|service is currently exhausted|rate.?limit/i.test(t)) return true;
    if (/^(thinking|deep thinking|analyzing)\b.{0,30}$/i.test(t.trim())) return true;
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

  function lastAssistantText(baseline = -1) {
    let nodes = assistantNodes();
    // v0.8.3: FRESH-BUBBLE GUARANTEE. The user log showed byte-identical
    // replies captured seconds after a FAILED send (turns #4/#10/#11 relayed
    // the same 9364-char text). Bubbles can be re-rendered/reordered so the
    // plain index cut misses; now we additionally require that the chosen
    // bubble is NOT a known previous-turn text before accepting it.
    if (baseline >= 0 && nodes.length > baseline) nodes = nodes.slice(baseline);
    lbLog("DEBUG", "scanning assistant bubbles", { candidates: nodes.length });
    for (let i = nodes.length - 1; i >= 0; i--) {
      let t = "";
      try { t = (nodes[i].innerText ?? nodes[i].textContent ?? "").trim(); } catch {}
      if (!t) continue;
      if (t.startsWith("(no response")) { lbLog("WARN", "captured placeholder-looking bubble", { len: t.length }); continue; }
      // ECHO GUARD: never accept our own prompt back as a reply — this was the
      // single biggest desync source (the debate then loops on stale text).
      if (lastSentText && norm(t) === norm(lastSentText)) { lbLog("WARN", "skipped echoed prompt bubble", { chars: t.length }); continue; }
      // v0.8.3: stale-reply guard — a bubble whose text equals the reply we
      // ALREADY relayed last turn is not new; skipping it turns the phantom
      // "byte-identical reply seconds after a failed send" into an honest
      // "(no response captured)" that ask_robust retries instead of relaying.
      if (lastCapturedNorm && norm(t) === lastCapturedNorm) { lbLog("WARN", "skipped stale previous-turn reply", { chars: t.length }); continue; }
      if (looksLikeChrome(t)) { lbLog("WARN", "skipped UI-chrome string", { preview: t.slice(0, 40) }); continue; }
      lbLog("INFO", "captured reply", { chars: t.length, preview: t.slice(0, 80) });
      lastCapturedNorm = norm(t);                     // remember for next turn
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
    if (transport?.mode === "ws") {
      // v0.8.1: remote orchestrator needs an explicit frame — it holds ALL
      // dispatch while any agent halts, so the debate can't keep typing into
      // the other tab. In engine mode the runtime message below IS the engine.
      try { sendCtl({ type: "halted", halted: state.halted }); } catch {}
    }
    try { chrome.runtime.sendMessage({ type: "halted", halted: state.halted, reason: "local" }); } catch {}
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
    if (transport?.alive()) { transport.send(obj); return true; }
    lbLog("WARN", "cannot " + obj.type + " — no orchestrator transport is live yet"); return false;
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

  // ── Turn runner — shared by BOTH transports (v0.9) ───────────────────────
  // Extracted from the old ws.onmessage so the in-browser engine can drive the
  // exact same turn logic over chrome.runtime messages. Returns {queued:true}
  // when a say arrives while a turn is still in flight (single-flight guard).
  async function runTurn(text) {
    const t0 = performance.now();
    lbLog("INFO", `turn #${state.turns + 1}: received prompt`, { chars: String(text).length, preview: String(text).slice(0, 80) });
    hud("writing…");
    let textToSay = String(text);
    let textP = "(no response captured)";
    try {
      for (;;) {
        const baseline = assistantNodes().length;      // bubble count BEFORE send
        await say(textToSay);
        hud("thinking…");
        await waitForStart(15000, baseline);           // stop button OR new bubble
        await waitForIdle();
        textP = await captureReply(baseline);          // + truncation re-check
        if (textP !== "(no response captured)" || !pendingSay) break;
        textToSay = pendingSay;                        // failed phantom turn — resend what we have queued
        pendingSay = null;
      }
      state.turns++;
      state.lastMs = performance.now() - t0;
      lbLog("INFO", `turn #${state.turns} complete`, { seconds: +(state.lastMs / 1000).toFixed(1), replyChars: textP.length });
      hud("idle");
      transport?.send({ type: "reply", agent: CFG.name, text: textP });
    } catch (e) {
      lbLog("ERROR", "turn FAILED", { error: String(e), stack: String(e.stack).split("\n").slice(0, 3).join(" | ") });
      hud("error");
      transport?.send({ type: "error", agent: CFG.name, text: String(e) });
    } finally {
      busy = false;
      if (pendingSay && !state.halted) {               // drain queued say after failure/idle capture
        const q = pendingSay; pendingSay = null;
        lbLog("INFO", "draining queued say", { chars: q.length });
        handleOrchestratorFrame({ type: "say", text: q });
      }
    }
  }

  function handleOrchestratorFrame(msg) {              // msg already parsed
    if (msg.type === "clear_input") {                  // v0.8.3: flush a jammed editor before retrying
      try {
        const el = findInput();
        if (el && readBox(el).trim()) {
          setNativeValue(el, "");
          if (isCE(el)) { try { document.execCommand("selectAll"); document.execCommand("delete"); } catch {} }
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward", data: null }));
          lbLog("INFO", "clear_input: flushed stuck text from input box", { chars: String(msg.text || "").length });
        } else {
          lbLog("DEBUG", "clear_input: box already empty");
        }
      } catch (e) { lbLog("WARN", "clear_input failed", { err: String(e).slice(0, 100) }); }
      return;
    }
    if (msg.type === "registered") {                   // v0.9: engine acknowledged us
      lbLog("INFO", "registered with in-browser swarm engine", { agent: msg.agent });
      hudEl.querySelector("#lb-start").hidden = false;
      hud("ready · press ▶");
      return;
    }
    if (msg.type === "resume") { lbLog("INFO", "orchestrator mid-run — tab rejoined"); hud("thinking…"); return; }
    if (msg.type === "swarm") {                        // armed/running/done mirror
      state.swarm = msg.state;
      hudEl.querySelector("#lb-start").hidden = msg.state !== "armed";
      hudEl.querySelector("#lb-stop").hidden = msg.state !== "running";
      if (msg.state === "armed") hud("ready · press ▶");
      if (msg.state === "done") hud("idle");
      if (msg.state === "halted" && !state.halted) hud("idle · halted elsewhere ⏸");
      return;
    }
    if (msg.type === "engine-log") {                   // mirror engine lines into our ring buffer
      const e = msg.entry || {};
      LB_LOG.push({ ts: new Date(e.ts || Date.now()).toISOString().slice(11, -5), agent: "engine",
                    level: e.level || "INFO", msg: e.msg || "", ...(e.data !== undefined ? { data: e.data } : {}) });
      if (LB_LOG.length > 300) LB_LOG.shift();
      return;
    }
    if (msg.type !== "say" || state.halted) { if (state.halted && msg.type === "say") lbLog("WARN", "dropping incoming say while HALTED", { preview: String(msg.text).slice(0, 60) }); return; }
    if (busy) {                                        // v0.8.3: single-flight guard.
      lbLog("WARN", "say arrived while a turn is still in flight — queueing behind it",
            { preview: String(msg.text).slice(0, 40) });
      pendingSay = String(msg.text);                   // keep only the newest; older dupes were the retry storm
      return;
    }
    busy = true;
    runTurn(msg.text);
  }

  // ── Connection ─────────────────────────────────────────────────────────────
  // v0.9: default transport is the in-browser swarm engine (python-free).
  // If the user points us at a port AND enables remote mode, we use the
  // classic WebSocket to orchestrator.py instead. Engine-first means zero
  // localhost sockets unless explicitly asked for.
  let backoff = 1000;
  function connectEngineMode() {
    setEngineTransport();
    hud("connecting…");
    transport.send({ type: "register", agent: CFG.name });
    try { chrome.runtime.sendMessage({ type: "agent-count" }); } catch {}
  }
  function connect() {
    chrome.storage.sync.get({ bridgeMode: "engine" }, ({ bridgeMode }) => {
      if (bridgeMode === "engine") { connectEngineMode(); return; }
      const ws = new WebSocket(WS_URL);
      state.ws = ws;
      setWsTransport(ws);
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
        handleOrchestratorFrame(msg);
      };

      ws.onclose = (ev) => { lbLog("WARN", `websocket closed (code ${ev.code}) — retrying in ${Math.round(backoff / 1000)}s`, { url: WS_URL });
                             hud("connecting…"); setTimeout(connect, backoff);
                             backoff = Math.min(backoff * 2, 15000); };
      ws.onerror = () => ws.close();
    });
  }

  // v0.9: runtime message listener for engine-mode frames (chrome.runtime path)
  try {
    chrome.runtime.onMessage.addListener((m, _s, respond) => {
      if (!m) return;
      if (["say", "swarm", "clear_input", "registered", "resume", "engine-log"].includes(m.type)) {
        handleOrchestratorFrame(m);
        respond({ ok: true, queued: busy });
        return true;
      }
      if (m?.type === "halted" && typeof m.halted === "boolean" && m.reason !== "local") {
        toggleHalt(m.halted); respond({ ok: true }); return true;
      }
    });
  } catch {}

  // ── Control deck asks: "how do you feel?" (popup tab-roster) ──────────────
  try {
    chrome.runtime.onMessage.addListener((m, _s, respond) => {
      if (m?.type === "status") respond({
        agent: CFG.name, state: state.lastState, turns: state.turns,
        wsOpen: transport?.alive() ?? false, halted: state.halted, transport: transport?.mode || "none",
      });
      else if (m?.type === "halt") toggleHalt(!!m.halted);
      return true;
    });
  } catch {}

  connect();
}

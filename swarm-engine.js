// swarm-engine.js — Shoarma v0.9: the orchestrator, reborn inside the browser.
// A MV3 service worker has no DOM and cannot host a WebSocket server, but it
// does not need one: content-bridge agents talk to US directly via
// chrome.runtime messaging instead of ws://127.0.0.1. This module is a faithful
// port of orchestrator.py's protocol (register → armed → start → say/reply
// alternation → transcript) with the v0.8.3 hardening built in:
//   • single-flight per agent (engine queues frames while an agent is busy),
//   • cool_down between retry attempts (clear_input + progressive wait),
//   • strict A↔B alternation, turn budget, HALT/stop broadcast,
//   • transcript persisted to chrome.storage.local AND downloadable as JSON.
//
// The Python orchestrator remains available for headless/terminal users;
// nothing here requires it.

const ENGINE = {
  agents: new Map(),        // name -> { tabId, ready, busy, queue: [] }
  state: "idle",            // idle | armed | running | done | halted
  topic: "",
  turns: 6,
  timeout: 180,             // seconds per reply (mirrors popup config)
  current: null,            // agent expected to receive the next prompt
  partnerOf: {},            // agent -> next speaker
  lastText: "",             // prompt currently in flight
  turnCount: 0,
  transcript: [],           // {role, agent, text, ts, captured}
  timers: {},               // named setTimeout ids we can cancel
};

const TOPIC_FALLBACK =
  "Two AI assistants take turns building on each other's ideas. " +
  "Begin with a thought-provoking opening statement on the topic.";

// ── logging (same shape as before so monitor keeps working) ────────────────
function engLog(level, msg, data) {
  const entry = { level, msg, data: data ?? {}, ts: Date.now(), agent: "engine" };
  console.log(`[Shoarma engine] ${level}: ${msg}`, data ?? "");
  for (const a of ENGINE.agents.values()) {
    try { chrome.tabs.sendMessage(a.tabId, { type: "engine-log", entry }); } catch {}
  }
  // keep a rolling debug ring for the monitor page
  chrome.storage.local.get({ debugRing: [] }, ({ debugRing }) => {
    debugRing.push(entry);
    if (debugRing.length > 300) debugRing = debugRing.slice(-300);
    chrome.storage.local.set({ debugRing });
  });
}

// ── broadcast swarm state everywhere (HUD pills, popup, monitor) ───────────
function broadcastState() {
  const payload = { type: "swarm", state: ENGINE.state, turn: ENGINE.turnCount,
                    agents: [...ENGINE.agents.keys()], topicChars: ENGINE.topic.length };
  chrome.storage.local.set({ swarmState: payload });
  for (const a of ENGINE.agents.values()) {
    try { chrome.tabs.sendMessage(a.tabId, payload); } catch {}
  }
}

// ── transport: send a frame to one agent, honoring its busy queue ─────────
function deliver(name, frame) {
  const a = ENGINE.agents.get(name);
  if (!a) return false;
  const send = () => {
    try {
      chrome.tabs.sendMessage(a.tabId, frame).then((res) => {
        if (frame.type === "say" && res?.queued) a.busy = true; // bridge says single-flight active
      }).catch(() => { /* tab gone — cleanup happens on next dispatch */ });
    } catch {}
  };
  if (frame.type !== "say") { send(); return true; }
  if (a.busy) {
    a.queue = [frame];         // newest-only, exactly like v0.8.3 pendingSay
    engLog("WARN", `agent ${name} mid-turn — queued newest say behind it`,
           { preview: String(frame.text).slice(0, 40) });
  } else {
    a.busy = true;
    send();
  }
  return true;
}

// bridge finished (or failed) a turn → release the agent, flush its queue
function releaseAgent(name) {
  const a = ENGINE.agents.get(name);
  if (!a) return;
  a.busy = false;
  const next = a.queue.shift();
  if (next) deliver(name, next);
}

// ── run lifecycle ──────────────────────────────────────────────────────────
function arm(topic, turns, timeout) {
  ENGINE.topic = (topic || "").trim() || TOPIC_FALLBACK;
  ENGINE.turns = Math.min(Math.max(Number(turns) || 6, 1), 50);
  ENGINE.timeout = Math.min(Math.max(Number(timeout) || 180, 15), 600);
  ENGINE.transcript = [];
  ENGINE.turnCount = 0;
  ENGINE.startedAt = Date.now();
  const names = [...ENGINE.agents.keys()].sort();
  if (names.length < 2) {
    ENGINE.state = "idle";
    engLog("ERROR", "cannot arm — need two registered agents (deepseek + qwen tabs open)");
    broadcastState();
    return false;
  }
  // strict alternation ring: A->B->A...
  ENGINE.partnerOf = {};
  for (let i = 0; i < names.length; i++) ENGINE.partnerOf[names[i]] = names[(i + 1) % names.length];
  ENGINE.current = names[0];
  ENGINE.state = "armed";
  engLog("INFO", `armed · agents=${names.join(",")} · turns≤${ENGINE.turns}`,
         { topicPreview: ENGINE.topic.slice(0, 60) });
  broadcastState();
  return true;
}

function startRun(startFrame) {
  if (ENGINE.state !== "armed") {
    engLog("WARN", "start ignored — engine not armed", { state: ENGINE.state });
    return;
  }
  if (startFrame?.topic) { ENGINE.topic = String(startFrame.topic); }
  if (startFrame?.turns) { ENGINE.turns = Math.min(Number(startFrame.turns) || ENGINE.turns, 50); }
  ENGINE.state = "running";
  broadcastState();
  engLog("INFO", "▶ run started — seeding first hop", { chars: ENGINE.topic.length });
  sendPromptToCurrent(ENGINE.topic);
}

function sendPromptToCurrent(text) {
  const to = ENGINE.current;
  if (!to || !ENGINE.agents.has(to)) { finishRun("target agent vanished"); return; }
  ENGINE.lastText = text;
  deliver(to, { type: "say", text });
  armReplyTimeout();
}

function armReplyTimeout() {
  clearTimeout(ENGINE.timers.reply);
  ENGINE.timers.reply = setTimeout(() => {
    settleAttempt(false);                             // v0.9.2: unblock any retry awaiting this attempt
    engLog("ERROR", "reply timed out — halting run gracefully", { seconds: ENGINE.timeout });
    haltAll("timeout");
    finishRun("timeout");
  }, ENGINE.timeout * 1000);
}

// cool-down between retries (v0.8.3): flush the jammed editor, wait, re-dispatch
function coolDown(seconds) {
  return new Promise((res) => {
    for (const a of ENGINE.agents.values()) {
      try { chrome.tabs.sendMessage(a.tabId, { type: "clear_input" }); } catch {}
    }
    engLog("WARN", `cool-down: flushed inputs, waiting ${seconds}s before retry`);
    setTimeout(res, seconds * 1000);
  });
}

let retrying = false;
// v0.9.2: promise-based attempt tracking. The old boolean flag was set by
// ANY frame that touched it (including a queued say merely being accepted),
// so cool-down retries could be declared "successful" without a real reply,
// and a failure reported mid-retry would re-queue behind a phantom busy state
// (user log 19:12:59: "queued newest say behind it" → instant give-up).
let _attemptPromise = null;
function lastAttemptSucceeded() { return _attemptPromise; }

async function handleFailedTurn(fromName) {
  if (retrying || ENGINE.state !== "running") return;
  retrying = true;
  try {
    for (const wait of [5, 10]) {
      await coolDown(wait);
      if (ENGINE.state !== "running") return;
      // v0.9.2: force-release the target agent first — the bridge is done
      // (it just reported failure), so any lingering busy/queue is stale.
      releaseAgent(ENGINE.current);
      engLog("INFO", `re-dispatching current prompt to ${ENGINE.current}`, { after: wait + "s" });
      const okP = new Promise((res) => { _attemptResolve = res; });
      _attemptPromise = okP;
      deliver(ENGINE.current, { type: "say", text: ENGINE.lastText });
      armReplyTimeout();
      // wait until THIS attempt resolves (reply / send_failed / timeout), max 45s
      const won = await Promise.race([okP, new Promise((r) => setTimeout(() => r("timeout"), 45000))]);
      if (won === true) { _attemptPromise = null; return; }   // attempt succeeded
      _attemptPromise = null;
      if (ENGINE.state !== "running") return;                  // halted meanwhile
    }
    engLog("ERROR", "give up: prompt failed after 2 cool-down retries — halting run");
    haltAll("send-failures");
    finishRun("send-failed");
  } finally { retrying = false; }
}

let _attemptResolve = null;
function settleAttempt(v) { try { _attemptResolve?.(v); } catch {} _attemptResolve = null; }

// ── what bridges send us ───────────────────────────────────────────────────
function onRegister(msg, senderTabId) {
  const name = String(msg.agent || "").toLowerCase();
  if (!name) return;
  const prev = ENGINE.agents.get(name);
  ENGINE.agents.set(name, { tabId: senderTabId, ready: true, busy: !!prev?.busy, queue: [] });
  engLog("INFO", `agent registered: ${name}`, { tabId: senderTabId });
  try { chrome.tabs.sendMessage(senderTabId, { type: "registered", agent: name }); } catch {}
  if (ENGINE.state === "idle" && ENGINE.agents.size >= 2) arm(ENGINE.topic || "", ENGINE.turns, ENGINE.timeout);
  else broadcastState();
}

function onReply(msg, fromName) {
  settleAttempt(true);                                // v0.9.2: resolve cool-down retry
  clearTimeout(ENGINE.timers.reply);
  const from = ENGINE.agents.get(fromName);
  if (from) releaseAgent(fromName);
  if (ENGINE.state !== "running") return;
  const text = String(msg.text || "");
  const captured = msg.captured !== false;
  ENGINE.transcript.push({ role: captured ? "assistant" : "error", agent: fromName,
                           text, ts: Date.now(), captured });
  ENGINE.turnCount += 1;
  engLog(captured ? "INFO" : "WARN", `turn #${ENGINE.turnCount} ${captured ? "complete" : "FAILED"} :: ${fromName}`,
         { chars: text.length, preview: text.slice(0, 60) });
  if (ENGINE.turnCount >= ENGINE.turns * 2) { finishRun("turn-budget"); return; }
  // hand the reply to the partner agent (strict alternation)
  const next = ENGINE.partnerOf[fromName] || [...ENGINE.agents.keys()].find(n => n !== fromName);
  if (!next) { finishRun("no-partner"); return; }
  ENGINE.current = next;
  sendPromptToCurrent(text || "(empty reply — please continue the thread)");
}

function onSendFailure(msg, fromName) {
  settleAttempt(false);                               // v0.9.2: resolve cool-down retry now
  const from = ENGINE.agents.get(fromName);
  if (from) releaseAgent(fromName);
  if (ENGINE.state !== "running") return;
  clearTimeout(ENGINE.timers.reply);
  engLog("ERROR", `bridge reports MESSAGE NOT SUBMITTED (${fromName})`,
         { preview: String(msg.preview || "").slice(0, 60) });
  handleFailedTurn(fromName);
}

function haltAll(reason) {
  for (const a of ENGINE.agents.values()) {
    try { chrome.tabs.sendMessage(a.tabId, { type: "halted", halted: true, reason }); } catch {}
  }
}

function finishRun(reason) {
  clearTimeout(ENGINE.timers.reply);
  ENGINE.state = "done";
  engLog("INFO", `run finished (${reason}) — ${ENGINE.transcript.length} entries`,
         { turns: ENGINE.turnCount });
  persistTranscript();
  broadcastState();
  setTimeout(() => { if (ENGINE.state === "done") { ENGINE.state = "idle"; ENGINE.turnCount = 0; broadcastState(); } }, 8000);
}

function stopRun() {
  if (ENGINE.state !== "running") { engLog("WARN", "stop ignored — not running"); return; }
  haltAll("user-stop");
  finishRun("stopped-by-user");
}

// ── persistence: storage + one-click download ──────────────────────────────
function persistTranscript() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rec = { version: chrome.runtime.getManifest().version, topic: ENGINE.topic,
                startedAt: ENGINE.startedAt, savedAt: Date.now(), entries: ENGINE.transcript };
  chrome.storage.local.set({ [`transcript-${stamp}`]: rec, lastTranscript: rec });
  engLog("INFO", "transcript saved to extension storage", { key: `transcript-${stamp}` });
}

function downloadLastTranscript() {
  chrome.storage.local.get({ lastTranscript: null }, ({ lastTranscript }) => {
    if (!lastTranscript) { engLog("WARN", "no transcript to export yet"); return; }
    const blob = new Blob([JSON.stringify(lastTranscript, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `shoarma-transcript-${Date.now()}.json`, saveAs: true },
      (id) => { if (id != null) setTimeout(() => URL.revokeObjectURL(url), 60_000); });
  });
}

// ── message router (this is the "WebSocket server", minus the socket) ──────
chrome.runtime.onMessage.addListener(async (msg, sender, respond) => {
  const tabId = sender.tab?.id;
  const fromName = String(msg?.agent || "").toLowerCase();
  switch (msg?.type) {
    case "register":       onRegister(msg, tabId); respond({ ok: true }); return false;
    case "ready":          if (fromName) releaseAgent(fromName); respond({ ok: true }); return false;
    case "reply":          onReply(msg, fromName); respond({ ok: true }); return false;
    case "send_failed":    onSendFailure(msg, fromName); respond({ ok: true }); return false;
    // v0.9.2: bridge throws this when say() fails for ANY reason (input not
    // found, injection rejected, send channels exhausted). Without it the
    // engine waited on its reply timeout while cool-down retries re-queued
    // behind a phantom busy agent (user log 19:12:41→19:13:02).
    case "error": {
      if (ENGINE.state === "running") {
        onSendFailure({ preview: String(msg.text || "").slice(0, 80) }, fromName);
      }
      respond({ ok: true }); return false;
    }
    case "start": {
      const cfg = await chrome.storage.sync.get({ turns: 6, timeout: 180 });
      if (ENGINE.state !== "armed") arm(msg.topic || "", msg.turns || cfg.turns, msg.timeout || cfg.timeout);
      startRun(msg); respond({ ok: true }); return false;
  }
    case "stop":           stopRun(); respond({ ok: true }); return false;
    case "arm":            respond({ ok: arm(msg.topic, msg.turns, msg.timeout) }); return false;
    case "engine-state":   respond({ state: ENGINE.state, agents: [...ENGINE.agents.keys()],
                                     turn: ENGINE.turnCount, turns: ENGINE.turns }); return false;
    case "export-transcript": downloadLastTranscript(); respond({ ok: true }); return false;
    case "open-monitor":
      chrome.tabs.create({ url: chrome.runtime.getURL("monitor.html") });
      respond({ ok: true }); return false;
    case "agent-count":    bumpBadge(tabId); respond({ ok: true }); return false;
    // ── v0.8: automated tab activation — bridge asks us to foreground its own
    //    tab before touching the page (background tabs are throttled). We also
    //    mirror halted toggles to every agent so a HALT in one tab stops all.
    case "activate-tab": {
      const tid = sender.tab?.id;
      if (tid == null) { respond({ ok: false, error: "no tab" }); return false; }
      focusTab(tid).then(() => respond({ ok: true }),
        (e) => respond({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    case "halted": {
      const src = sender.tab?.id;
      for (const a of ENGINE.agents.values()) {
        if (a.tabId === src) continue;                // don't echo back to initiator
        try { chrome.tabs.sendMessage(a.tabId, { type: "halted", halted: !!msg.halted, reason: "remote" }); } catch {}
      }
      respond({ ok: true }); return false;
    }
    // legacy remote-mode launcher: retired with the in-browser engine (v0.9).
    // The popup's error path turns this rejection into the friendly
    // "run python orchestrator.py manually" hint.
    case "launch":
      respond({ ok: false, error: "Native launcher is retired in v0.9 — switch the Orchestrator selector to 🌐 In-browser engine, or run `python orchestrator.py` manually for remote mode." });
      return false;
    default: return false; // status / log reach the bridges directly
  }
});

// ── tab focus helper (v0.8 semantics, moved here from background.js) ───────
let lastFocus = { tabId: -1, ts: 0 };
async function focusTab(tabId) {
  const now = Date.now();
  if (tabId === lastFocus.tabId && now - lastFocus.ts < 400) return;  // already focused
  lastFocus = { tabId, ts: now };
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) { try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {} }
}

// ── badge: how many agent tabs are alive ────────────────────────────────────
const liveTabs = new Set();
function bumpBadge(tabId) {
  if (tabId != null) liveTabs.add(tabId);
  chrome.action.setBadgeText({ text: liveTabs.size ? String(liveTabs.size) : "" });
}
chrome.tabs.onRemoved.addListener((tabId) => { liveTabs.delete(tabId); bumpBadge(null); });

// ── legacy remote mode: the native launcher shim (background.js) can't be
// hot-loaded into this worker (MV3 workers are fixed at registration), so in
// remote mode the popup tells users to run `python orchestrator.py` — same WS
// protocol, zero extra setup beyond Python. chrome.runtime.sendMessage with
// type:"launch" simply rejects ("legacy launcher not registered") and the
// popup's existing error path prints the friendly manual-run hint.

// prune dead tabs (agent closed/navigated away)
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [name, a] of [...ENGINE.agents]) {
    if (a.tabId === tabId) {
      ENGINE.agents.delete(name);
      engLog("WARN", `agent ${name} disconnected (tab closed)`, { state: ENGINE.state });
      if (ENGINE.state === "running" && (name === ENGINE.current)) {
        clearTimeout(ENGINE.timers.reply);
        finishRun("agent-lost");
      }
      broadcastState();
    }
  }
});

engLog("INFO", "swarm engine online — python-free mode active (in-browser orchestrator)");

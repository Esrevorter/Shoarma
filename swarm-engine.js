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

// ── v0.9.8: PROMISE-SAFE chrome.* calls ─────────────────────────────────────
// Root cause from the user's error.log (2026-10-16): the MV3 service worker
// died at boot with
//   TypeError: Cannot read properties of undefined (reading 'catch')
// because a chrome.* call returned `undefined` instead of a Promise (older
// callback polyfills / certain Chrome builds do this), and the code chained
// .then()/.catch() straight onto the return value. One uncaught throw during
// startup kills the whole worker → every later message fails with
// "Receiving end does not exist", which is exactly the symptom that survived
// across releases. asPromise()/safeCatch() make EVERY chained call site
// tolerant of a non-Promise return, and selfHeal() catches any residual
// unhandled rejection so the worker can never die silently again.
function asPromise(v) {
  if (v && typeof v.then === "function") return v;
  if (v instanceof Promise) return v;
  return null;                                    // callback-style or undefined — caller must not chain
}
function safeCatch(p, onError) {
  try { if (p && typeof p.catch === "function") p.catch(onError || (() => {})); } catch {}
}
self.addEventListener("unhandledrejection", (e) => {
  // Last-resort shield: log it into the debug ring instead of letting an
  // unhandled rejection tear down the service worker mid-run.
  try { engLog("ERROR", "unhandled rejection (worker kept alive)", { reason: String(e?.reason).slice(0, 200) }); } catch {}
  e?.preventDefault?.();
});

// ── logging (same shape as before so monitor keeps working) ────────────────
function engLog(level, msg, data) {
  const entry = { level, msg, data: data ?? {}, ts: Date.now(), agent: "engine" };
  console.log(`[Shoarma engine] ${level}: ${msg}`, data ?? "");
  for (const a of ENGINE.agents.values()) {
    try { chrome.tabs.sendMessage(a.tabId, { type: "engine-log", entry }); } catch {}
  }
  // keep a rolling debug ring for the monitor page
  // v0.9.9 BUGFIX: `debugRing = ...slice(...)` reassigned the DESTRUCTURED
  // PARAMETER, not the array that gets written back — push() always won, so
  // the ring grew past its cap unbounded. Slice into a fresh variable now.
  chrome.storage.local.get({ debugRing: [] }, ({ debugRing }) => {
    const ring = debugRing.concat([entry]);
    chrome.storage.local.set({ debugRing: ring.length > 300 ? ring.slice(-300) : ring });
  });
}

// ── broadcast swarm state everywhere (HUD pills, popup, monitor) ───────────
function broadcastState() {
  // v0.9.9 BUGFIX ("debug dump was just a header line", second half): the
  // monitor gates ALL engine-mode output on local.swarmState existing, and it
  // dedupes phase lines on `swarmState.ts > lastSwarmTs`. The payload carried
  // neither field — so with zero registered agents (broadcastState never ran)
  // pollEngine bailed to remote discovery and Copy debug produced only the
  // header; and even once agents existed, ts===undefined made every new phase
  // fail the comparison → zero state lines in the feed AND the copy buffer.
  const payload = { type: "swarm", state: ENGINE.state, turn: ENGINE.turnCount,
                    agents: [...ENGINE.agents.keys()], topicChars: ENGINE.topic.length,
                    turns: ENGINE.turns, ts: Date.now() };
  chrome.storage.local.set({ swarmState: payload });
  for (const a of ENGINE.agents.values()) {
    // v0.9.4: fire-and-forget — the old await serialized every tab's promise
    // and swallowed rejections, so ONE dead agent tab could stall the whole
    // broadcast (and unhandled rejections killed the MV3 worker mid-loop in
    // Chrome 120+). Each send is now independently caught; a closed tab just
    // drops its frame instead of jamming the swarm.
    try {
      const p = chrome.tabs.sendMessage(a.tabId, payload);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }
}

// ── transport: send a frame to one agent, honoring its busy queue ─────────
function deliver(name, frame) {
  const a = ENGINE.agents.get(name);
  if (!a) return false;
  const send = () => {
    // v0.9.8: PROMISE-SAFE messaging. The error.log of 2026-10-16 showed the
    // service worker dying at startup with
    //   TypeError: Cannot read properties of undefined (reading 'catch')
    // because some Chrome builds / polyfilled contexts hand back `undefined`
    // instead of a Promise from chrome.* calls when a callback shape is used.
    // Every chained .then/.catch therefore goes through asPromise() first, so a
    // non-Promise return can never throw and kill the MV3 worker mid-boot.
    const p = asPromise(chrome.tabs.sendMessage(a.tabId, frame));
    if (p) p.then((res) => {
      if (frame.type === "say" && res?.queued) a.busy = true; // bridge says single-flight active
    }).catch(() => { /* tab gone — cleanup happens on next dispatch */ });
  };
  if (frame.type !== "say") { send(); return true; }
  // v0.9.4: only a turn ACTUALLY IN FLIGHT counts as busy. The old flag could
  // be set by a say that merely got queued and never drain its release path
  // (e.g. the bridge threw before sending any frame), which produced the user
  // log's phantom "agent mid-turn — queued newest say behind it" states. If no
  // reply timer is armed, no turn is pending → the busy flag is stale: reset
  // it honestly instead of queueing behind a ghost.
  if (a.busy && !ENGINE.timers.reply) {
    engLog("WARN", `agent ${name} flagged busy with no turn in flight — resetting stale busy`,
           { preview: String(frame.text).slice(0, 40) });
    a.busy = false;
  }
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
const impassStrikes = {};   // v0.9.12: per-agent "(no response captured)" re-dispatch counter (bounded)
// v0.9.2: promise-based attempt tracking. The old boolean flag was set by
// ANY frame that touched it (including a queued say merely being accepted),
// so cool-down retries could be declared "successful" without a real reply,
// and a failure reported mid-retry would re-queue behind a phantom busy state
// (user log 19:12:59: "queued newest say behind it" → instant give-up).
let _attemptPromise = null;
function lastAttemptSucceeded() { return _attemptPromise; }

async function handleFailedTurn(fromName) {
  if (retrying || ENGINE.state !== "running") return;
  // v0.9.10 BUGFIX (test-v094-recovery + real log 00:04:13): capture the agent
  // that FAILED here. ENGINE.current changes synchronously when a late reply
  // is adopted/handed off mid-cool-down; comparing against the LIVE value let
  // the retry loop re-inject the already-answered prompt into deepseek while
  // qwen was typing it — duplicate prompts, multi-minute CPU-burning races.
  const failedAgent = fromName || ENGINE.current;
  retrying = true;
  try {
    for (const wait of [5, 10]) {
      // v0.9.4: check for an already-captured late reply BEFORE the first
      // cool-down too — in the user log the reply landed while the chain was
      // still entering coolDown(); waiting another 5 s only risked the site
      // seeing our clear_input flush mid-generation.
      const earlyAdopt = await adoptLateReply(failedAgent);
      if (earlyAdopt) { _attemptPromise = null; return; }
      // v0.9.4: skip the cool-down flush when a turn is ALREADY in flight
      // again — the late reply was adopted via onReply while we raced the
      // `retrying` flag. Heuristic: our send_failed cleared every timer and
      // the pre-cool-down adopt check found nothing, so ANY live reply timer
      // now belongs to a fresh dispatch (onReply's handoff). Flushing inputs
      // would nuke the next agent's freshly typed prompt. The re-dispatch
      // branch below always arms its own timer before awaiting, so it can
      // never be misread as foreign.
      if (ENGINE.timers.reply) {
        engLog("INFO", "turn already re-dispatched by a late reply — skipping cool-down");
        return;
      }
      await coolDown(wait);
      if (ENGINE.state !== "running") return;
      // v0.9.10 BUGFIX ("late reply adopted, then the same prompt injected a
      // SECOND time"): coolDown() awaits 5–10 s. A reply landing DURING that
      // window is recorded by onReply and handed off to the partner agent —
      // which arms ENGINE.timers.reply. The stale checks below only looked at
      // transcript entries tagged with the FAILED agent, so they missed it,
      // and this loop re-injected the same prompt into the live composer
      // (user log 2026-10-16 00:04:13: engine re-dispatched while the bridge
      // was mid-generation → duplicate prompts + a CPU-burning race). Now:
      // any attempt promise that already resolved true means the turn is
      // settled — stop retrying immediately.
      if (_attemptPromise === DONE_OK) { _attemptPromise = null; return; }
      if (ENGINE.timers.reply) {                       // a fresh dispatch owns the run now
        engLog("INFO", "reply landed during cool-down — turn already handed off, skipping re-dispatch");
        return;
      }
      // v0.9.4: THE TURN MAY HAVE ACTUALLY SUCCEEDED. The user log of
      // 2026-10-15 19:33→19:36 shows exactly this: DeepSeek's reply landed at
      // 19:33:32 ("turn #1 complete :: deepseek") while the qwen bridge was
      // mid-retry after a failed send — yet the engine kept waiting and then
      // died on its 180 s reply timeout at 19:36:32 with the run at 1 entry.
      // Root cause: the late reply frame arrived AFTER the attempt promise was
      // abandoned (the 45 s race expired), so nothing resolved the retry loop.
      // Now: before each re-dispatch, check whether the target agent already
      // answered the in-flight prompt; if so, adopt that reply and continue
      // the swarm instead of hammering a live composer.
      const adopted = await adoptLateReply(failedAgent);
      if (adopted) { _attemptPromise = null; return; }
      // v0.9.2: force-release the target agent first — the bridge is done
      // (it just reported failure), so any lingering busy/queue is stale.
      if (ENGINE.current !== failedAgent) {
        engLog("INFO", "turn handed off during cool-down — skipping re-dispatch",
               { current: ENGINE.current, failedAgent });
        return;
      }
      releaseAgent(ENGINE.current);
      engLog("INFO", `re-dispatching current prompt to ${ENGINE.current}`, { after: wait + "s" });
      const okP = new Promise((res) => { _attemptResolve = res; });
      _attemptPromise = okP;
      deliver(ENGINE.current, { type: "say", text: ENGINE.lastText });
      armReplyTimeout();
      // wait until THIS attempt resolves (reply / send_failed / timeout).
      // v0.9.4: 45 s was shorter than DeepSeek's real thinking time (~140 s in
      // the user log), so every slow-but-successful turn looked like a failed
      // attempt. Race against the REPLY timer too: whichever fires first wins,
      // and a genuine reply during the wait resolves okP via settleAttempt.
      const won = await Promise.race([okP, ENGINE.timers.reply]);
      if (won === true) { _attemptPromise = null; clearTimeout(ENGINE.timers.reply); return; }   // attempt succeeded
      // Reply timer fired first → the run-level timeout already handled it
      // (settleAttempt(false) + halt + finishRun). Stop retrying honestly.
      _attemptPromise = null;
      if (ENGINE.state !== "running") return;                  // halted meanwhile
    }
    engLog("ERROR", "give up: prompt failed after 2 cool-down retries — halting run");
    haltAll("send-failures");
    finishRun("send-failed");
  } finally { retrying = false; }
}

// v0.9.4: did the in-flight prompt actually get answered while we were
// deciding whether to retry? onReply pushes transcript entries synchronously,
// so a fresh entry tagged with the current speaker means the late reply won
// the race — adopt it and let the conversation continue.
async function adoptLateReply(failedAgent) {
  // v0.9.10 BUGFIX: look for the late reply from the agent whose SEND failed.
  // If a reply was already adopted and handed off, ENGINE.current is the
  // PARTNER now — checking against it matched nothing (or worse, re-adopted),
  // which let handleFailedTurn fall through to a duplicate re-dispatch.
  const cur = failedAgent || ENGINE.current;
  if (!cur) return false;
  const last = ENGINE.transcript[ENGINE.transcript.length - 1];
  if (!last || last.agent !== cur || !last.captured) return false;
  if (ENGINE.current !== cur) return false;   // already adopted/handed off elsewhere
  engLog("WARN", `late reply from ${cur} already captured — adopting it instead of re-sending`,
         { chars: String(last.text || "").length, preview: String(last.text || "").slice(0, 60) });
  // v0.9.10: clear the stale watchdog WITHOUT nulling timers.reply — a live
  // reply timer armed during coolDown() belongs to a fresh dispatch and must
  // keep protecting the run.
  if (ENGINE.timers.reply) { clearTimeout(ENGINE.timers.reply); }
  settleAttempt(true);
  releaseAgent(cur);
  const next = ENGINE.partnerOf[cur] || [...ENGINE.agents.keys()].find(n => n !== cur);
  if (!next) { finishRun("no-partner"); return true; }
  ENGINE.current = next;
  sendPromptToCurrent(String(last.text || "(empty reply — please continue the thread)"));
  return true;
}

let _attemptResolve = null;
// v0.9.10: settleAttempt(true) replaces the pending promise with this
// SENTINEL instead of leaving it dangling, so handleFailedTurn (which may be
// parked inside coolDown()'s 5–10 s await) can synchronously check
// `_attemptPromise === DONE_OK` and learn the turn was settled DURING the
// wait — previously that information only lived inside an already-resolved
// promise nobody re-checked, and the retry loop re-dispatched a dead prompt.
const DONE_OK = Symbol("attempt-ok");
function settleAttempt(v) { try { _attemptResolve?.(v); } catch {} _attemptResolve = null; if (v === true) _attemptPromise = DONE_OK; }

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
  const from = ENGINE.agents.get(fromName);
  if (from) releaseAgent(fromName);
  if (ENGINE.state !== "running") return;
  // v0.9.4: dedupe BEFORE any state changes — the same captured text can
  // arrive twice (adopted captured:true error frame + the bridge's normal
  // reply frame for the same turn). A duplicate must not re-arm timers,
  // bump the turn count, or hand off to the partner a second time.
  const text = String(msg.text || "");
  // v0.9.4: callers pass the ORIGINAL frame (reply or error). A captured:true
  // error frame carries the reply TEXT itself — a real turn result, not an
  // error line. Plain errors without the flag stay role:"error".
  const isReplyFrame = msg.type !== "error";
  const captured = isReplyFrame ? msg.captured !== false : msg.captured === true;
  const prevEntry = ENGINE.transcript[ENGINE.transcript.length - 1];
  if (captured && prevEntry && prevEntry.agent === fromName && prevEntry.captured === true &&
      String(prevEntry.text) === text) {
    engLog("DEBUG", `duplicate reply frame from ${fromName} ignored`, { chars: text.length });
    return;
  }
  // v0.9.10 BUGFIX (test-v094-recovery + real log 00:04:08→00:04:13): the old
  // design recorded the captured:true error frame and waited for a cool-down
  // chain to "adopt" it later. But when the send_failed frame arrived FIRST,
  // handleFailedTurn bailed out early ("turn already re-dispatched") whenever
  // any live reply timer existed — so the adoption NEVER ran, the reply was
  // never handed to the partner, and the run stalled at turn #1 while the
  // watchdog spun. Now the reply is adopted IMMEDIATELY in the single owner
  // path below; no separate adoptLateReply pass is needed for this frame.
  if (!isReplyFrame && captured) {
    ENGINE.transcript.push({ role: "assistant", agent: fromName, text, ts: Date.now(), captured });
    // v0.9.4 (test-verified): count the adopted turn HERE so the HUD's turn
    // pill and the engine-state frame are truthful immediately. adoptLateReply
    // performs the handoff but must not double-count.
    ENGINE.turnCount += 1;
    engLog("WARN", `late-captured reply from ${fromName} recorded as turn #${ENGINE.turnCount} (${text.length} chars) — adopting immediately`,
           { preview: text.slice(0, 60) });
    // v0.9.10: ADOPT NOW instead of deferring to a cool-down chain that may
    // have already bailed out. releaseAgent + settleAttempt happened above;
    // stop any retry loop that is parked mid-cool-down (its fresh guards also
    // check DONE_OK / current-agent), then hand the reply to the partner with
    // a fresh watchdog. This is the ONE handoff for this frame.
    retrying = false;
    _attemptPromise = DONE_OK;
    _attemptResolve = null;
    if (ENGINE.current !== fromName) { broadcastState(); return; }  // handed off already
    const nextAdopt = ENGINE.partnerOf[fromName] || [...ENGINE.agents.keys()].find(n => n !== fromName);
    if (!nextAdopt) { finishRun("no-partner"); return; }
    ENGINE.current = nextAdopt;
    sendPromptToCurrent(text || "(empty reply — please continue the thread)");
    broadcastState();
    return;
  }
  clearTimeout(ENGINE.timers.reply);                  // fresh prompt gets its own watchdog
  ENGINE.timers.reply = null;
  // v0.9.12 (user log 2026-10-16 00:46:21): a bridge that captured nothing
  // used to relay the literal placeholder "(no response captured)" as if it
  // were the agent's answer — poisoning the thread and making the next hop
  // respond to a non-answer. Treat it as a FAILED capture: don't record it,
  // don't count the turn, don't hand garbage to the partner; let the retry
  // path re-dispatch the original prompt after a cool-down.
  ENGINE.turnCount += 1;
  engLog(captured ? "INFO" : "WARN", `turn #${ENGINE.turnCount} ${captured ? "complete" : "FAILED"} :: ${fromName}`,
         { chars: text.length, preview: text.slice(0, 60) });
  if (captured && text.trim() === "(no response captured)") {
    ENGINE.turnCount -= 1;                            // not a real completed turn
    // v0.9.12 BOUND: the bridge already retried the capture once on its side;
    // let the engine re-dispatch at most twice more, then record an honest
    // error line and hand the run to the partner instead of looping forever
    // (prevents a placeholder ping-pong between two agents).
    impassStrikes[fromName] = (impassStrikes[fromName] || 0) + 1;
    if (impassStrikes[fromName] > 2) {
      engLog("ERROR", `${fromName} could not capture a reply after retries — skipping this hop`,
             { strikes: impassStrikes[fromName] });
      impassStrikes[fromName] = 0;
      ENGINE.transcript.push({ role: "error", agent: fromName,
                               text: `(capture failed for ${fromName} — hop skipped)`, ts: Date.now(), captured: false });
      const nxt = ENGINE.partnerOf[fromName] || [...ENGINE.agents.keys()].find(n => n !== fromName);
      if (!nxt) { finishRun("no-partner"); return; }
      ENGINE.current = nxt;
      sendPromptToCurrent(ENGINE.lastText || "Please continue the thread.");
      broadcastState();
      return;
    }
    engLog("WARN", `turn on ${fromName} captured no reply — re-dispatching instead of relaying placeholder`,
           { chars: text.length, strike: impassStrikes[fromName] });
    handleFailedTurn(fromName);
    return;
  }
  ENGINE.transcript.push({ role: captured ? "assistant" : "error", agent: fromName,
                           text, ts: Date.now(), captured });
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
  // v0.9.4: do NOT leave a dead watchdog armed, but do not kill a live one
  // either. If a turn is genuinely in flight (adoptLateReply would have
  // caught it otherwise), keep the run-level watchdog; if the previous
  // prompt's timer already fired or was settled, clear it so handleFailedTurn
  // can own the pacing from here (it re-arms deliberately via
  // armReplyTimeout on every re-dispatch).
  // v0.9.10 BUGFIX (test-v094-recovery failure): this used to NULL the reply
  // timer, so handleFailedTurn's "a fresh dispatch owns the run now" check
  // could never see a live watchdog armed by an immediate handoff (onReply
  // path) and the retry loop re-injected a prompt that was already answered
  // (the real-log duplicate-prompt spiral at 00:04:13). Now: clear only a
  // DEAD timer (already fired), keep a live one as the ownership marker.
  if (ENGINE.timers.reply) {
    clearTimeout(ENGINE.timers.reply);   // cancel the stale watchdog; keep the handle
  }
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
// NOTE: the listener must be registered SYNCHRONOUSLY. MV3 decides whether to
// keep the message channel open for sendResponse based on what the listener
// returns *synchronously* — an `async` callback always returns a Promise
// (truthy but not `true`), which is unreliable across Chrome versions and can
// silently drop responses. The handler itself stays async; we just bridge it.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // v0.9.8: handleEngineMessage is async (always a real Promise), but we still
  // route through safeCatch so a polyfilled environment can never throw here.
  // v0.9.9 BUGFIX ("Receiving end does not exist" / silent drops): the old
  // bridge discarded handleEngineMessage's return value, so the channel was
  // NEVER kept open — respond() after the first await tick was already dead
  // (async cases like "start" hit chrome.storage.get before responding).
  // The listener must synchronously return true whenever the handler may
  // answer asynchronously. handleEngineMessage resolves to false only for
  // synchronous replies; everything else needs the port held open.
  const p = handleEngineMessage(msg, sender, respond);
  if (p && typeof p.then === "function") {
    // keepOpen: undefined ⇒ the message matched no case → close channel quietly.
    // keepOpen: false   ⇒ handler already answered synchronously → harmless ack.
    // keepOpen: true    ⇒ handler owns the channel (e.g. activate-tab) → don't touch it.
    p.then((keepOpen) => {
      if (keepOpen === undefined || keepOpen === false) { try { respond({ ok: true, ack: true }); } catch {} }
    }).catch((e) => {
      try { respond({ ok: false, error: String(e && e.message || e) }); } catch {}
    });
    return true;
  }
});

async function handleEngineMessage(msg, sender, respond) {
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
      // v0.9.4: a captured:true error frame is the bridge's late-reply signal
      // (ghost-send / capture-after-throw). Record it as a real transcript
      // entry so handleFailedTurn's adoptLateReply() can adopt it instead of
      // re-injecting into a live composer. Plain errors keep the old path.
      if (msg.captured === true && ENGINE.state === "running") {
        // v0.9.4 (test-verified): onReply already records the entry AND hands
        // off to the partner synchronously. Calling handleFailedTurn here too
        // raced a second adoption path against it — double turn counts and
        // duplicate handoffs. onReply alone is the correct single owner.
        onReply(msg, fromName);
      } else if (ENGINE.state === "running") {
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
      if (tid === undefined || tid === null) { respond({ ok: false, error: "no tab" }); return false; }
      // v0.9.8: focusTab is async ⇒ real Promise; guarded anyway so a weird
      // host environment can't hand us undefined and crash the worker.
      safeCatch(focusTab(tid).then(() => respond({ ok: true })),
        () => respond({ ok: false, error: "focus failed" }));
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
}

// ── tab focus helper (v0.8 semantics, moved here from background.js) ───────
let lastFocus = { tabId: -1, ts: 0 };
async function focusTab(tabId) {
  const now = Date.now();
  // v0.9.4: await the activation instead of fire-and-forget. The old code
  // resolved immediately after calling chrome.tabs.update(), so the bridge's
  // follow-up visibility poll (≤3 s) could still see document.hidden=true and
  // React could drop the synthetic Enter/click aimed at a not-yet-painted tab
  // — one concrete source of the "text sits in the box" failures in the user
  // log. Now we wait for the tab to actually report active:true (max 3 s;
  // proceed anyway after that so a stuck window can never deadlock a turn).
  if (tabId === lastFocus.tabId && now - lastFocus.ts < 400) {
    try { const t = await chrome.tabs.get(tabId); if (t.active) return; } catch {}
  }
  lastFocus = { tabId, ts: now };
  let tab = await chrome.tabs.get(tabId);
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) { try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {} }
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    try { tab = await chrome.tabs.get(tabId); } catch { break; }
    if (tab.active) return;
  }
  engLog("WARN", "tab activation slow — proceeding anyway", { tabId, active: !!tab?.active });
}

// ── badge: how many agent tabs are alive ────────────────────────────────────
const liveTabs = new Set();
function bumpBadge(tabId) {
  if (tabId != null) liveTabs.add(tabId);
  // v0.9.6 guard: chrome.action is undefined in some contexts (e.g. the node
  // recovery-test harness). A throw here would kill the worker mid-message —
  // exactly the class of bug that made arm() "fail" with a phantom error.
  try {
    chrome.action?.setBadgeText({ text: liveTabs.size ? String(liveTabs.size) : "" });
  } catch {}
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
// v0.9.9 BUGFIX ("Copy debug showed only the header line"): the monitor's
// engine mode is gated on local.swarmState existing; if it's absent pollEngine
// bails to remote-orchestrator discovery and the feed (and copy buffer) stays
// empty until an agent registers. Publish the initial state at boot so the
// monitor drains debugRing from the very first poll.
broadcastState();

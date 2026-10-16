// test-d7-post-run-rearm.js — v0.9.14 D7 regression: swarm-engine onRegister
// must NOT auto-arm when a bridge re-registers shortly after a finished run
// (state "done" → "idle" transition). The old code tripped
// `state === "idle" && agents.size >= 2` and armed with the stale ENGINE.topic,
// ghost-seeding the previous conversation ("until next time" replies in the
// user's logs) and resetting the orchestrator feed sequence (breaking monitor
// dedupe). Uses the SAME deterministic virtual-clock harness as
// test-v094-recovery.js so it never flakes on wall-clock timing.
const fs = require("fs");

let now = 0;
const timers = [];
global.setTimeout = (fn, ms) => { const t = { at: now + (ms || 0), fn }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
// Real Date.now() replaced by the virtual clock so the POST_RUN_REARM_WINDOW_MS
// check inside onRegister is exercised deterministically.
const realDateNow = Date.now;
Date.now = () => now;

function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = timers.filter(t => t.at <= target && !t.done).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.done = true; now = due.at; due.fn();
    while (timers.some(t => !t.done && t.at <= now)) { } // let sync chains settle
  }
  now = target;
}

const listeners = [];
const sentByTab = new Map();
const storeLocal = {};
global.chrome = {
  runtime: {
    getManifest: () => ({ version: "0.9.14-test" }),
    onMessage: { addListener: (f) => listeners.push(f) },
    sendMessage: () => Promise.resolve(),
  },
  storage: {
    local: { set: (o) => Object.assign(storeLocal, o), get: (d, cb) => cb({ ...d }) },
    sync:  { get: (d) => Promise.resolve({ ...d }) },
  },
  tabs: {
    create: () => {},
    onRemoved: { addListener: () => {} },
    get: (id) => Promise.resolve({ id, active: true, windowId: 1 }),
    update: (id) => Promise.resolve({ id, active: true, windowId: 1 }),
    sendMessage: (tabId, frame) => {
      if (!sentByTab.has(tabId)) sentByTab.set(tabId, []);
      sentByTab.get(tabId).push(frame);
      return Promise.resolve({ ok: true });
    },
  },
  windows: { update: () => Promise.resolve({}) },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  downloads: { download: () => {} },
};

const src = fs.readFileSync(__dirname + "/swarm-engine.js", "utf8");
if (typeof self === "undefined") globalThis.self = { addEventListener() {} };
eval(src);
const route = listeners[0];

const engState = () => storeLocal.swarmState || { state: "idle" };
const T_DEEP = 1667005679, T_QWEN = 1667005680;
const feed = (m) => route(m, { tab: { id: m.$tab } }, () => {});
const settle = () => new Promise(r => setImmediate(r));
const countSaysTo = (tabId) => (sentByTab.get(tabId) || []).filter(f => f.type === "say").length;

(async () => {
// ── cold start: two registrations DO auto-arm (legit first use) ────────────
feed({ type: "register", agent: "qwen", $tab: T_QWEN });
feed({ type: "register", agent: "deepseek", $tab: T_DEEP });
assert(engState().state === "armed", "cold-start double register still auto-arms");

// ── run to completion via turn-budget (fast, deterministic) ────────────────
await feed({ type: "start", topic: "Ghost-seed probe topic", turns: 1, $tab: T_QWEN });
await settle();
assert(engState().state === "running", "run started");
const seedBefore = countSaysTo(T_DEEP) + countSaysTo(T_QWEN);
assert(seedBefore === 1, "exactly one seed say delivered");

// deepseek answers -> turn budget (turns*2 hops... turns=1 => budget hit on reply)
const deepSay = (sentByTab.get(T_DEEP) || []).filter(f => f.type === "say").pop();
feed({ type: "reply", agent: "deepseek", text: "See you until next time!", captured: true, $tab: T_DEEP });
await settle();
// handoff to qwen happened; qwen replies too -> finishRun(turn-budget)
feed({ type: "reply", agent: "qwen", text: "Agreed, until next time.", captured: true, $tab: T_QWEN });
await settle();
assert(engState().state === "done", "run finished (turn-budget) — state done");

// ── D7 core: the run ends, and bridges re-register ~1 s later — BEFORE the
//    done → idle timer fires (the exact scenario in the user's logs: tab
//    restore / SW restart re-registers within seconds of finishRun). The old
//    code armed immediately once state flipped to "idle" with the stale topic
//    and ghost-seeded a say. New guard: suppressed for 8 s after the run end.
advance(1_000);                                       // now == 1 s after finishRun, still "done"
const saysBefore = countSaysTo(T_DEEP) + countSaysTo(T_QWEN);
feed({ type: "register", agent: "qwen", $tab: T_QWEN });
feed({ type: "register", agent: "deepseek", $tab: T_DEEP });
await settle();
advance(7_500);                                       // done → idle transition fires at +8000
await settle();
assert(engState().state === "idle", "D7: post-run re-register does NOT auto-arm (stays idle after done→idle)");
const saysAfter = countSaysTo(T_DEEP) + countSaysTo(T_QWEN);
assert(saysAfter === saysBefore, "D7: no ghost seed say was delivered to either chat tab");

// ── explicit user Start still works despite the fresh stamp ────────────────
await feed({ type: "start", topic: "Fresh user-initiated topic", turns: 1, $tab: T_QWEN });
await settle();
assert(engState().state === "running", "explicit start overrides the post-run guard");
const saysStarted = countSaysTo(T_DEEP) + countSaysTo(T_QWEN);
assert(saysStarted === saysBefore + 1, "user-initiated run seeds exactly one new say");

// stop it cleanly, then verify a LATE re-register (> 8 s after end) may arm
feed({ type: "stop", $tab: T_QWEN });
await settle();
assert(engState().state === "done", "stop finishes the run");
advance(10_000);                                      // now ~8.5 s after the second run ended — outside the guard window
feed({ type: "register", agent: "qwen", $tab: T_QWEN });
feed({ type: "register", agent: "deepseek", $tab: T_DEEP });
await settle();
assert(engState().state === "armed", "re-register well after the window (cold-ish start) may auto-arm again");

console.log("\nALL D7 POST-RUN RE-ARM TESTS PASSED ✔");
process.exit(0);
})().catch(e => { console.error("TEST HARNESS ERROR:", e); process.exit(1); });

function assert(cond, what) {
  if (!cond) { console.error("FAILED: " + what); process.exit(1); }
  console.log("ok - " + what);
}

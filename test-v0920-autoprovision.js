// v0.9.20 regression test: AUTO-PROVISION — clicking "Start swarm" with zero
// chat tabs open must (a) spawn the missing qwen/deepseek tabs itself,
// (b) wait for their bridges to register, and only then arm+start. Before
// this feature, start ignored the missing tabs and arm() failed with
// "cannot arm — need two registered agents", forcing the user to open both
// tabs manually before every run. Loads the REAL swarm-engine.js under a
// stubbed chrome API (same harness style as test-v094-recovery.js).
const fs = require("fs");

let now = 0;
const timers = [];
global.setTimeout = (fn, ms) => { const t = { at: now + (ms || 0), fn }; timers.push(t); return t; };
global.clearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = timers.filter(t => t.at <= target && !t.done).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.done = true; now = due.at; due.fn();
  }
  now = target;
}

const listeners = [];
const createdTabs = [];        // urls passed to chrome.tabs.create
const reloadedTabs = [];       // ids passed to chrome.tabs.reload
const existingTabUrls = new Set();  // what chrome.tabs.query returns
let tabSeq = 500;
const storeLocal = {};
const pruneListeners = [];     // chrome.tabs.onRemoved callbacks (agent prune)
global.chrome = {
  runtime: {
    getManifest: () => ({ version: "0.9.20-test" }),
    onMessage: { addListener: (f) => listeners.push(f) },
    sendMessage: () => Promise.resolve(),
  },
  storage: {
    local: { set: (o) => Object.assign(storeLocal, o), get: (d, cb) => cb({ ...d }) },
    sync:  { get: (d) => Promise.resolve({ ...d }) },
  },
  tabs: {
    create: (opts) => { createdTabs.push(opts.url); existingTabUrls.add(opts.url); return Promise.resolve({ id: ++tabSeq }); },
    query: ({ url }) => {
      const pat = String(url).replace(/\*/g, ".*");
      const hits = [...existingTabUrls].filter(u => new RegExp("^" + pat + "$").test(u));
      return Promise.resolve(hits.map((u, i) => ({ id: 100 + i, url: u })));
    },
    reload: (id) => { reloadedTabs.push(id); return Promise.resolve(); },
    onRemoved: { addListener: (f) => pruneListeners.push(f) },
    get: (id) => Promise.resolve({ id, active: true, windowId: 1 }),
    update: (id) => Promise.resolve({ id, active: true, windowId: 1 }),
    sendMessage: () => Promise.resolve({ ok: true }),
  },
  windows: { update: () => Promise.resolve({}) },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  downloads: { download: () => {} },
};

const src = fs.readFileSync(__dirname + "/swarm-engine.js", "utf8");
if (typeof self === "undefined") globalThis.self = { addEventListener() {} };
eval(src);
const route = listeners[0];

let failures = 0;
const assert = (cond, name) => {
  if (cond) console.log("ok - " + name);
  else { console.error("NOT OK - " + name); failures++; }
};
const engState = () => storeLocal.swarmState || { state: "idle" };

(async () => {
// ── scenario 1: zero tabs open → Start must auto-provision both ────────────
existingTabUrls.clear(); createdTabs.length = 0; reloadedTabs.length = 0;
let startResp = null;
const p = route({ type: "start", topic: "Prove tab automation works.", turns: 2 },
                {}, (r) => { startResp = r; });
// The top-level listener returns literal `true` for async cases (MV3 keep-open
// rule); the inner handler's return value is a private detail — assert the
// contract where it is actually observable: the response only arrives AFTER
// the register frames, i.e. provisioning kept the channel alive.
assert(startResp === null, "start did NOT answer prematurely while agents were still missing");
for (let i = 0; i < 5; i++) await Promise.resolve();   // let the first awaits run
assert(createdTabs.some(u => /chat\.qwen\.ai/.test(u)) &&
       createdTabs.some(u => /chat\.deepseek\.com/.test(u)),
       "both missing agent tabs were created automatically");

// bridges of the new tabs register ~3 s later (SPA boot). The engine's wait
// loop uses real setTimeout — pump virtual time AND flush the microtask queue
// each step so its awaited continuation actually runs.
advance(3000);
route({ type: "register", agent: "qwen" },     { tab: { id: 501 } }, () => {});
route({ type: "register", agent: "deepseek" }, { tab: { id: 502 } }, () => {});
for (let i = 0; i < 80 && startResp === null; i++) {
  advance(200);
  for (let j = 0; j < 10; j++) await Promise.resolve();
}
assert(startResp !== null, "start resolved once both agents registered");
assert(startResp && startResp.ok === true, "start succeeded after auto-provision");
assert(engState().state === "running", "run is actually running now");

// ── scenario 2: all tabs already registered → no new tabs, instant start ──
createdTabs.length = 0;
route({ type: "stop" }, {}, () => {});
// stopRun finishes the run; next start re-arms. Agents still registered.
let resp2 = null;
await route({ type: "start", topic: "Second run, tabs already live.", turns: 2 }, {}, (r) => { resp2 = r; });
assert(resp2 && resp2.ok === true, "start with live agents succeeds immediately");
assert(createdTabs.length === 0, "no duplicate tabs spawned when agents are registered");

// ── scenario 3: tab exists but bridge never registers → forced reload ──────
// Drop both registrations via the engine's own onRemoved prune listener
// (simulates closing the tabs), but leave the URLs in existingTabUrls so
// query() still sees stale tabs — exactly the "opened but dead bridge" case.
for (const l of pruneListeners) { try { l(501); l(502); } catch {} }
reloadedTabs.length = 0;
await ensureAgentTabs(true);
assert(reloadedTabs.length >= 1, "force pass reloads existing-but-unregistered tabs");
reloadedTabs.length = 0;
await ensureAgentTabs(false);
assert(reloadedTabs.length === 0, "non-force pass never reloads (only spawns missing tabs)");

console.log(failures ? `${failures} FAILURES` : "ALL v0.9.20 AUTO-PROVISION TESTS PASSED \u2714");
process.exit(failures ? 1 : 0);
})();

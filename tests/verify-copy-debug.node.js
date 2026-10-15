#!/usr/bin/env node
// tests/verify-copy-debug.node.js — v0.9.9 live-replica verification.
// Reproduces the user's report ("debug dump = header line only") end to end:
//   1. boots the REAL swarm-engine.js in a vm sandbox with a faithful mock of
//      chrome.* (MV3 service-worker surface);
//   2. boots the REAL monitor.js against a mock extension page/DOM;
//   3. lets one poll tick run;
//   4. clicks "Copy debug" and asserts the clipboard contains engine lines.
// Exits non-zero on any assertion failure.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
  if (!cond) failures++;
};

// ── shared chrome.storage.local backing (engine + monitor see the same store) ─
const localStore = {};
const storageListeners = [];
function notifyStorage(area, ch) { storageListeners.slice().forEach((f) => { try { f(ch, area); } catch {} }); }

// ── tabs registry for message routing ────────────────────────────────────────
const tabHandlers = new Map();          // tabId -> onMessage(msg, respond)
let nextTabId = 100;
const allTabs = [];                    // tabs visible to chrome.tabs.query
function addAgentTab(url) {
  const id = nextTabId++;
  tabHandlers.set(id, () => {});        // placeholder; scenario B installs its own
  const t = { id, url };
  allTabs.push(t);
  return t;
}
const createdTabs = [];

const chromeMock = {
  runtime: {
    id: "shoarma-test",
    getURL: (p) => "chrome-extension://shoarma-test/" + p,
    onMessage: {
      _ls: [],
      addListener(f) { this._ls.push(f); },
    },
    sendMessage(msg, opts) {
      // popup/sidepanel -> engine: run every registered listener synchronously
      // like Chrome does; first explicit respond() wins. `opts.tab` simulates
      // a message coming FROM a content-script tab (sender.tab.id populated).
      return new Promise((resolve, reject) => {
        let answered = false;
        const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
        let keepOpen = false;
        const sender = { tab: opts?.tab || null };
        for (const f of chromeMock.runtime.onMessage._ls) {
          try { if (f(msg, sender, respond) === true) keepOpen = true; } catch (e) { reject(e); return; }
        }
        if (!keepOpen && !answered) setTimeout(() => {
          if (!answered) reject(new Error("Receiving end does not exist"));
        }, 5);
      });
    },
    getManifest: () => ({ version: "0.9.9-test" }),
  },  storage: {
    local: {
      get(defs, cb) {
        const out = {};
        for (const k of Object.keys(typeof defs === "object" && defs !== null ? defs : {}))
          out[k] = k in localStore ? localStore[k] : defs[k];
        const p = Promise.resolve(out);
        if (cb) { p.then((v) => cb(v)); return; }
        return p;
      },
      set(obj, cb) {
        Object.assign(localStore, JSON.parse(JSON.stringify(obj)));
        notifyStorage("local", Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: v }])));
        const p = Promise.resolve();
        if (cb) p.then(() => cb());
        return p;
      },
    },
    sync: {
      _d: {},
      get(defs, cb) {
        const out = {};
        for (const k of Object.keys(defs || {})) out[k] = k in this._d ? this._d[k] : defs[k];
        const p = Promise.resolve(out);
        if (cb) { p.then((v) => cb(v)); return; }
        return p;
      },
      set(o) { Object.assign(this._d, o); return Promise.resolve(); },
    },
    onChanged: { addListener(f) { storageListeners.push(f); } },
  },
  tabs: {
    query(q) {
      const pat = [].concat(q.url || []);
      return Promise.resolve(allTabs.filter((t) => pat.some((p) => {
        const rx = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        return rx.test(t.url);
      })));
    },
    create(opts) { createdTabs.push(opts); return Promise.resolve({ id: 999 }); },
    get: (id) => Promise.resolve({ id, active: true }),
    update: (id) => Promise.resolve({ id, active: true }),
    sendMessage(tabId, msg) {
      const h = tabHandlers.get(tabId);
      // Faithful to Chrome: an unlisted/closed tab rejects. engLog's fan-out is
      // wrapped in try{} by the engine, so a synchronous throw here exercises
      // exactly the same catch path as production.
      if (!h) throw new Error("Receiving end does not exist");
      return new Promise((resolve, reject) => {
        let answered = false;
        const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
        h(msg, respond);
        setTimeout(() => { if (!answered) resolve(undefined); }, 3);
      });
    },
    onRemoved: { addListener() {} },
  },
  windows: { update: () => Promise.resolve({}) },
  action: { setBadgeText: () => Promise.resolve() },
};

// ── 1. boot the real engine ──────────────────────────────────────────────────
const engineSrc = fs.readFileSync(path.join(ROOT, "swarm-engine.js"), "utf8");
const engineCtx = vm.createContext({ chrome: chromeMock, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL: require("url"), self: { addEventListener() {} } });
vm.runInContext(engineSrc, engineCtx, { filename: "swarm-engine.js" });

// ── 2. mock DOM + fetch, then boot the real monitor ──────────────────────────
class El {
  constructor(id) { this.id = id; this.children = []; this.dataset = {}; this.style = {};
    this._text = ""; this._html = ""; this.checked = false; this.hidden = false; this.className = ""; }
  set textContent(v) { this._text = String(v); } get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); if (v === "") this.children = []; } get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  remove() { if (this.parent) this.parent.removeChild(this); }
  select() {} querySelector(sel) { return new El(this.id + sel); } querySelectorAll() { return []; }
  addEventListener(ev, f) { (this._ev ||= {})[ev] = f; }
  get scrollHeight() { return 100; } get scrollTop() { return 0; } get clientHeight() { return 100; }
}
// faithful ClassList so monitor.js DOM code ($( 'copy' ).classList.add /
// toggle / remove) runs exactly like in the browser
Object.defineProperty(El.prototype, "classList", {
  get() {
    if (!this._cl) {
      const self = this;
      const set = () => new Set(String(self.className || "").split(/\s+/).filter(Boolean));
      this._cl = {
        add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); self.className = [...s].join(" "); },
        remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); self.className = [...s].join(" "); },
        contains: (c) => set().has(c),
        toggle: (c, force) => { const s = set(); const on = force === undefined ? !s.has(c) : !!force;
          on ? s.add(c) : s.delete(c); self.className = [...s].join(" "); return on; },
      };
    }
    return this._cl;
  },
});
const els = {};
const $mock = (id) => (els[id] ||= new El(id));
const feed = $mock("feed");
const clipboard = { written: null };
globalThis.navigator = { clipboard: { writeText: async (t) => { clipboard.written = t; } } };
const docMock = {
  getElementById: $mock,
  createElement: (tag) => { const e = new El(tag + "-" + Math.random()); e.isCreated = true; return e; },
  querySelectorAll: () => [],
  addEventListener: (ev, f) => { (docMock._ev ||= {})[ev] = f; },
  body: { appendChild() {}, removeChild() {} },
};
const fetchMock = () => Promise.reject(new Error("no orchestrator running")); // remote discovery must fail

const monitorSrc = fs.readFileSync(path.join(ROOT, "monitor.js"), "utf8");
const timerQueue = [];                 // capture setInterval/setTimeout so we can drive ticks deterministically
let intervalSeq = 1000;
// Chrome's setTimeout/setInterval return NUMBERS (ids), not the raw function —
// monitor.js stores refreshBridgeTabs()'s result into bridgeTabs, so a real
// extension page would never see "undefined" there. Mirror that contract.
const monCtx = vm.createContext({
  chrome: chromeMock, console, document: docMock, navigator: globalThis.navigator,
  fetch: fetchMock, URL,
  setTimeout: (f, ms) => { timerQueue.push(f); return ++intervalSeq; },
  setInterval: (f, ms) => { timerQueue.push(f); return ++intervalSeq; },
  clearInterval: () => {}, clearTimeout: () => {}, location: { hostname: "chrome-extension" },
});
vm.runInContext(monitorSrc + "\n;globalThis.__M = { drainEngineRing };", monCtx, { filename: "monitor.js" });
// fire DOMContentLoaded so the poll loop registers
(docMock._ev?.DOMContentLoaded || (() => {}))();

const pump = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    const batch = timerQueue.splice(0);
    for (const f of batch) { try { await f(); } catch {} }
    // drain promise continuations between top-level awaits, like a real event loop
    for (let j = 0; j < 8; j++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));   // real timers let storage callbacks settle
    for (let j = 0; j < 8; j++) await new Promise((r) => setImmediate(r));
  }
};

(async () => {
  await pump(2);   // initial discoverPort/pollEngine cycles

  // ── A. the reported bug scenario: ZERO agent tabs, engine booted ──────────
  ok("A1 engine published swarmState at boot (gate opens)", !!localStore.swarmState,
     "swarmState=" + JSON.stringify(localStore.swarmState));
  ok("A2 swarmState carries ts + turns (dedupe fields)",
     Number.isFinite(localStore.swarmState?.ts) && Number.isFinite(localStore.swarmState?.turns),
     JSON.stringify(localStore.swarmState));
  ok("A3 engine wrote its boot line into local.debugRing", Array.isArray(localStore.debugRing) && localStore.debugRing.length >= 1,
     "ring=" + JSON.stringify(localStore.debugRing));

  await pump(1);   // one more pollEngine tick with drainEngineRing active
  const rendered = feed.children.map((c) => c.textContent).filter(Boolean);
  ok("A4 monitor FEED rendered engine lines without any agent tab",
     rendered.some((t) => /swarm engine online/.test(t)), JSON.stringify(rendered));

  // simulate the user clicking "📋 Copy debug"
  await els["copy"].onclick();
  const dump = clipboard.written || "";
  ok("A5 clipboard dump starts with the header", dump.startsWith("=== Shoarma debug dump ·"), dump.slice(0, 60));
  ok("A6 clipboard dump CONTAINS ENGINE LINES (the fix)", /swarm engine online/.test(dump) && /state → /.test(dump),
     "dump was:\n" + dump);

  // ── B. full lifecycle: two agents register, run starts, phases appear ──────
  const t1 = addAgentTab("https://chat.qwen.ai/c/1"), t2 = addAgentTab("https://chat.deepseek.com/c/2");
  const seenByBridge = [];
  tabHandlers.set(t1.id, (m, respond) => { if (m.type === "status") respond({ agent: "qwen", state: "idle", turns: 0, log: [] }); if (m.type === "engine-log") seenByBridge.push(m.entry); });
  tabHandlers.set(t2.id, (m, respond) => { if (m.type === "status") respond({ agent: "deepseek", state: "idle", turns: 0, log: [] }); if (m.type === "engine-log") seenByBridge.push(m.entry); });

  const reg1 = await chromeMock.runtime.sendMessage({ type: "register", agent: "qwen" }, { tab: t1 });
  const reg2 = await chromeMock.runtime.sendMessage({ type: "register", agent: "deepseek" }, { tab: t2 });
  ok("B1 register responses arrive via the fixed listener bridge (ack pattern works)",
     reg1 && reg2 && (reg1.ok === true || reg1.ack === true), JSON.stringify([reg1, reg2]));

  const st = await chromeMock.runtime.sendMessage({ type: "engine-state" });
  ok("B2 engine-state answers after async hops (channel kept open correctly)",
     st && st.state === "armed" && st.agents.length === 2, JSON.stringify(st));

  const started = await chromeMock.runtime.sendMessage({ type: "start", topic: "test topic" });
  ok("B3 start (async: storage.get before respond) does NOT hit 'Receiving end does not exist'",
     started && (started.ok === true || started.ack === true), JSON.stringify(started));

  for (let i = 0; i < 8; i++) { await pump(1); if ((localStore.debugRing || []).length >= 5) break; }

  ok("B4 engine fan-out reached both bridges' engine-log mirrors", seenByBridge.length > 0, "mirror=" + seenByBridge.length);

  // One-shot drain of the engine ring — exactly what pollEngine's first await
  // does on a real tick (the harness's timer queue is consumed by pump(), so
  // we invoke the same production function directly to close that gap).
  await monCtx.__M.drainEngineRing();

  await els["copy"].onclick();
  const dump2 = clipboard.written || "";
  ok("B5 dump shows registration + run-start lines",
     /agent registered: qwen/.test(dump2) && /run started/.test(dump2), dump2.split("\n").slice(-8).join("\n"));
  const stateLines = dump2.split("\n").filter((l) => /state → /.test(l));
  ok("B6 phase lines are DEDUPED (≤ number of real transitions, no flood)",
     stateLines.length >= 1 && stateLines.length <= 4, "lines=" + stateLines.length);

  // ── C. unknown messages don't wedge senders ────────────────────────────────
  const ack = await chromeMock.runtime.sendMessage({ type: "some-unknown-type" });
  ok("C1 unknown message gets a harmless ack instead of hanging/rejecting",
     ack && ack.ack === true, JSON.stringify(ack));

  console.log(failures ? `\nRESULT: ${failures} FAILURE(S)` : "\nRESULT: ALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });

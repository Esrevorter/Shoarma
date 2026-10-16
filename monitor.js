// monitor.js — the third page: live view of the swarm, no tab-switching.
// v0.5.1 discovery ladder (the old file://-only approach failed on Windows —
// Chrome blocks local-file fetches → "offline · waiting for orchestrator"):
//   1. chrome.storage.sync.port → probe http://127.0.0.1:<port>/state directly
//      (the WS port now answers plain HTTP too) and read feedPort from /state;
//   2. file:// port files (works when the extension dir is readable);
//   3. common fallback ports.
// Polls every 800ms; renders new conversation turns and (optionally) debug
// lines; one-click "Copy debug" gathers EVERYTHING for a bug report.

const $ = (id) => document.getElementById(id);
let httpPort = null;                 // discovered feed port (may == ws port)
let lastSeq = 0;
let DEBUG_LINES = [];          // mirror of everything we render, for copy-paste
const MAX_DOM_EVENTS = 400;

async function tryFetchState(portOrUrl) {
  const url = String(portOrUrl).startsWith("http")
    ? portOrUrl : `http://127.0.0.1:${portOrUrl}/state`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1200);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) return null;
    const st = await r.json();
    if (st && typeof st === "object" && "events" in st) return st;
    return null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

function homeCandidates() {
  return [
    "file:///tmp/shoarma/monitor-port.txt",
    "file:///tmp/shoarma-monitor-port.txt",
  ];
}

async function discoverPort() {
  // 1. saved config port — the orchestrator's WS port also serves /state
  const cfg = await chrome.storage.sync.get({ port: 8765 });
  const cands = [`http://127.0.0.1:${cfg.port}/state`];
  // 2. file:// port files (if readable)
  for (const u of homeCandidates()) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (r.ok) {
        const p = parseInt((await r.text()).trim(), 10);
        if (p > 0 && p < 65536) cands.push(`http://127.0.0.1:${p}/state`);
      }
    } catch {}
  }
  // 3. cheap sweep of likely ephemeral range? No — instead retry the saved
  //    port each poll; that covers restarts without hammering the network.
  for (const c of cands) {
    const st = await tryFetchState(c);
    if (st) {
      // prefer the dedicated side-feed port the orchestrator advertises
      if (st.feedPort && st.feedPort > 0) return st.feedPort;
      return parseInt(c.split("/")[2].split(":")[1], 10);
    }
  }
  return null;
}

// v0.6: the monitor can start/stop the swarm too — direct WS to the port.
let ctlWs = null, ctlBackoff = 1000;
function ctlConnect() {
  chrome.storage.sync.get({ port: 8765 }, ({ port }) => {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ctlWs = ws;
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "swarm") {
          const b1 = document.getElementById("ctl-start"), b2 = document.getElementById("ctl-stop");
          if (b1) b1.style.display = m.state === "armed" ? "" : "none";
          if (b2) b2.style.display = m.state === "running" ? "" : "none";
        }
      };
      ws.onclose = () => { ctlWs = null; setTimeout(ctlConnect, Math.min(ctlBackoff = ctlBackoff * 1.5, 5000)); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch {}
  });
}
ctlConnect();
document.addEventListener("click", (e) => {
  if (e.target.id === "ctl-start") {
    chrome.storage.sync.get({ topic: "", turns: 6 }, (cfg) => {
      if (ctlWs?.readyState === 1) ctlWs.send(JSON.stringify({ type: "start", topic: cfg.topic, turns: cfg.turns }));
      e.target.disabled = true; e.target.textContent = "▶ starting…";
      setTimeout(() => { e.target.disabled = false; e.target.textContent = "▶ Start swarm"; }, 3000);
    });
  }
  if (e.target.id === "ctl-stop" && ctlWs?.readyState === 1) ctlWs.send(JSON.stringify({ type: "stop" }));
});

chrome.storage.sync.get({ halted: false }, (cfg) => {
  $("halted").checked = !!cfg.halted;
  poll(); setInterval(poll, 800);
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "sync" && ch.halted) $("halted").checked = !!ch.halted.newValue;
  if (area === "sync" && ch.port) httpPort = null;   // re-discover on port change
});
$("halted").onchange = () => chrome.storage.sync.set({ halted: $("halted").checked });
$("show-debug").onchange = applyDebugVisibility;

// ── ENGINE MODE (v0.9): the monitor reads the in-browser swarm engine straight
//    out of chrome.storage — no localhost, no Python. The engine mirrors every
//    log line into local.debugRing and its phase into local.swarmState; agent
//    pills come from querying the bridges directly. Remote mode keeps the
//    classic HTTP/WS feed below untouched. ────────────────────────────────────
let bridgeTabs = [];                       // tabs with a live bridge instance
async function refreshBridgeTabs() {
  try { bridgeTabs = await chrome.tabs.query({ url: ["https://chat.qwen.ai/*", "https://chat.deepseek.com/*"] }); }
  catch { bridgeTabs = []; }
}
refreshBridgeTabs(); setInterval(refreshBridgeTabs, 5000);

const seenEngineSeq = new Set();           // dedupe engine lines mirrored to tabs
let lastSwarmTs = 0;                       // v0.9.9: don't re-render the same broadcast every poll
// v0.9.9 BUGFIX ("debug dump was just a header line"): pollEngine only asked
// BRIDGE TABS for their log mirrors. With zero registered agents — or when the
// engine's sendMessage fan-out finds no listeners — nothing reached DEBUG_LINES
// and Copy debug produced only the header. The engine always mirrors its own
// ring into local.debugRing, so read it there too (deduped via seenEngineSeq).
async function drainEngineRing() {
  const { debugRing } = await chrome.storage.local.get({ debugRing: [] });
  if (!Array.isArray(debugRing)) return;
  for (const e of debugRing.slice(-300)) {
    const key = `${e.ts}|${e.agent}|${e.msg}`;
    if (seenEngineSeq.has(key)) continue;
    seenEngineSeq.add(key);
    // v0.9.10 BUGFIX ("monitor totally not working — nothing shows up"):
    // renderEvent unconditionally did lastSeq = Math.max(lastSeq, ev.seq) and
    // engine lines carry NO seq → undefined → Math.max(...) = NaN → lastSeq
    // became NaN on the FIRST drained line. Thereafter every remote-mode
    // event failed `ev.seq > lastSeq` (NaN comparisons are always false), so
    // the feed AND the copy buffer stayed empty forever — exactly the dead
    // monitor reported after a run where the ring had filled fine.
    renderEvent({ type: "log", agent: e.agent || "engine", level: e.level, msg: e.msg,
                  data: e.data, ts: new Date(e.ts || Date.now()).toLocaleTimeString(), seq: 0 });
  }
}
async function pollEngine() {
  const { swarmState } = await chrome.storage.local.get({ swarmState: null });
  if (!swarmState) return false;           // engine never ran → remote discovery next
  setPill(true, "live · in-browser engine");
  await drainEngineRing();
  // roster: ask each bridge for its state + engine-log mirror
  const agents = {};
  for (const tab of bridgeTabs) {
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: "status" });
      const name = st.agent || new URL(tab.url).hostname.replace(/^chat\./, "");
      agents[name] = { state: st.state, turns: st.turns };
      for (const l of (st.log || [])) {
        if (l.agent !== "engine") continue;
        const key = `${l.ts}|${l.agent || "engine"}|${l.msg}`;
        if (seenEngineSeq.has(key)) continue;
        seenEngineSeq.add(key);
        renderEvent({ type: "log", agent: "engine", level: l.level, msg: l.msg, data: l.data, ts: l.ts, seq: 0 });
      }
    } catch {}
  }
  // v0.9.9: system line per phase change (was rendered on EVERY 800ms poll —
  // hundreds of duplicates flooded the feed and the copy buffer)
  if (swarmState.state && swarmState.ts > lastSwarmTs) {
    lastSwarmTs = swarmState.ts;
    renderEvent({ type: "log", agent: "engine", level: "INFO", seq: 0,
                  msg: `state → ${swarmState.state} · turn ${swarmState.turn ?? 0}/${swarmState.turns ?? "?"} · agents: ${(swarmState.agents || []).join(", ") || "none"}` });
  }
  if (Object.keys(agents).length) renderAgents(agents);
  // progress from the engine's own counters
  const totalTurns = Math.max(1, Number(swarmState.turns) || 6) * 2;
  $("stat-turns").textContent = Math.min(swarmState.turn || 0, totalTurns);
  if ((swarmState.turn || 0) > 0 && $("stat-started").textContent === "—")
    $("stat-started").textContent = new Date().toLocaleTimeString();
  // start/stop buttons follow the engine phase
  const b1 = document.getElementById("ctl-start"), b2 = document.getElementById("ctl-stop");
  if (b1) b1.style.display = swarmState.state === "armed" ? "" : "none";
  if (b2) b2.style.display = swarmState.state === "running" ? "" : "none";
  return true;
}

async function poll() {
  try {
    const cfg = await chrome.storage.sync.get({ bridgeMode: "engine" });
    if (cfg.bridgeMode !== "remote") {
      if (await pollEngine()) return;      // engine is live — nothing else to do
      // engine idle-and-unaware AND no remote orchestrator either: show offline
      // but keep trying both paths each tick.
    }
    if (!httpPort) {
      httpPort = await discoverPort();
      if (!httpPort) throw new Error(cfg.bridgeMode !== "remote" ? "no feed yet (engine idle)" : "no feed yet");
      $("stat-port").textContent = httpPort;
    }
    const st = await tryFetchState(httpPort);
    if (!st) throw new Error("feed gone");
    setPill(true, "live · orchestrator online");
    renderAgents(st.agents || {});
    for (const ev of (st.events || [])) if (ev.seq > lastSeq) renderEvent(ev);
    trimDom();
  } catch {
    httpPort = null;               // re-probe next tick (orchestrator may restart)
    setPill(false);
  }
}

function setPill(up, text) {
  const p = $("pill");
  p.className = "pill " + (up ? "pill-live" : "pill-off");
  $("pill-text").textContent = up ? (text || "live · orchestrator online") : "offline · waiting for orchestrator";
}

function renderAgents(agents) {
  const ul = $("agents");
  const names = Object.keys(agents);
  if (!names.length) { ul.innerHTML = '<li class="muted">none connected yet</li>'; return; }
  ul.innerHTML = "";
  for (const n of names) {
    const a = agents[n];
    const li = document.createElement("li");
    li.dataset.state = a.state || "?";
    li.innerHTML = `<span class="who ${n}">${n}</span><span class="st">${a.state || "?"} · ${a.turns ?? 0}x</span>`;
    ul.appendChild(li);
  }
}

function renderEvent(ev) {
  // v0.9.10: never poison lastSeq with NaN — engine lines arrive without a
  // seq (remote-mode events carry one). A single undefined would turn lastSeq
  // into NaN and permanently break the `ev.seq > lastSeq` gate in remote mode.
  if (Number.isFinite(ev.seq)) lastSeq = Math.max(lastSeq, ev.seq);
  const feed = $("feed");
  $("empty")?.remove();
  const d = document.createElement("div");
  const time = new Date().toLocaleTimeString();

  if (ev.type === "reply" || ev.type === "error") {
    d.className = `msg ${ev.agent || ""} ${ev.type === "error" ? "err me" : ""}`;
    d.innerHTML = `<div class="meta"><span class="who">${ev.agent || "?"}</span>
      <span>turn ${ev.turn ?? "—"}</span><span>${time}</span>${ev.seconds != null ? `<span>${ev.seconds}s</span>` : ""}</div>
      <div class="txt"></div>`;
    d.querySelector(".txt").textContent = clip(ev.text, 3000);
    logLine(`${time} REPLY ${ev.agent}: ${clip(ev.text, 400)}`);
  } else if (ev.type === "log") {
    d.className = `msg dbg ${ev.level || "INFO"}`;
    d.dataset.dbg = "1";
    d.textContent = `${ev.ts || time} [${ev.agent}] ${(ev.level || "INFO").padEnd(5)} ${ev.msg}${ev.data ? " :: " + clip(JSON.stringify(ev.data), 300) : ""}`;
    logLine(d.textContent);
    if (!$("show-debug").checked) d.classList.add("hidden");
  } else {
    d.className = "msg sys";
    d.textContent = `[${time}] ${ev.text || ev.type}`;
    logLine(`${time} SYS: ${ev.text || ev.type}`);
  }
  feed.appendChild(d);
  nearBottom(feed) && (feed.scrollTop = feed.scrollHeight);
}

function applyDebugVisibility() {
  const on = $("show-debug").checked;
  document.querySelectorAll(".msg.dbg").forEach(el => el.classList.toggle("hidden", !on));
}

function trimDom() {
  const feed = $("feed");
  while (feed.children.length > MAX_DOM_EVENTS) feed.removeChild(feed.firstChild);
}
function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 160; }
function clip(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function logLine(l) { DEBUG_LINES.push(l); if (DEBUG_LINES.length > 1200) DEBUG_LINES.splice(0, 200); 
  const t = $("stat-turns"); if (/REPLY/.test(l)) t.textContent = Number(t.textContent) + 1;
  const m = l.match(/(\d\d:\d\d:\d\d)/); if (m && $("stat-started").textContent === "—") $("stat-started").textContent = m[1];
  if (/REPLY/.test(l)) $("stat-last").textContent = m ? m[1] : "now";
}

$("copy").onclick = async () => {
  const header = `=== Shoarma debug dump · ${new Date().toISOString()} · feed port ${httpPort ?? "—"} ===\n`;
  try { await navigator.clipboard.writeText(header + DEBUG_LINES.join("\n")); }
  catch { const ta = document.createElement("textarea"); ta.value = header + DEBUG_LINES.join("\n");
          document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  $("copy").classList.add("ok-flash"); $("copy").textContent = "✓ copied — paste it to the agent";
  setTimeout(() => { $("copy").classList.remove("ok-flash"); $("copy").textContent = "📋 Copy debug"; }, 2500);
};
$("clear").onclick = () => { $("feed").innerHTML = ""; DEBUG_LINES = []; lastSeq = 0; };  // v0.9.12: was a no-op (lastSeq = lastSeq) — cleared feed then the poller skipped every event with seq < old lastSeq → monitor looked dead/empty

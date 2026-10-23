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
// v0.9.18 BUGFIX ("swarm can't be started from the monitor page — it stops
// again"): the old handler ONLY spoke to the remote Python orchestrator over
// WS. In engine mode ctlWs is never OPEN → clicking Start sent nothing, and
// the poller re-hid the button on the next tick ("stops again"). Now Start
// arms AND starts the in-browser engine through runtime messaging (exactly
// like the popup does), falling back to the WS path only in remote mode.
async function sendStart() {
  const cfg = await chrome.storage.sync.get({ topic: "", turns: 6, timeout: 180, bridgeMode: "engine" });
  const topic = String(cfg.topic || "").trim();
  const turns = Math.min(Math.max(Number(cfg.turns) || 6, 1), 50);
  if (cfg.bridgeMode !== "remote") {
    try { await chrome.runtime.sendMessage({ type: "arm", topic, turns, timeout: Number(cfg.timeout) || 180 }); } catch {}
    try { await chrome.runtime.sendMessage({ type: "start", topic, turns }); } catch {}
    return true;
  }
  if (ctlWs?.readyState === 1) { ctlWs.send(JSON.stringify({ type: "start", topic, turns })); return true; }
  return false;
}
document.addEventListener("click", async (e) => {
  if (e.target.id === "ctl-start") {
    const b = e.target;
    b.disabled = true; b.textContent = "▶ starting…";
    const ok = await sendStart();
    if (!ok) renderEvent({ type: "log", agent: "monitor", level: "WARN", seq: 0, msg: "start failed — no live engine/orchestrator connection" });
    setTimeout(() => { b.disabled = false; b.textContent = "▶ Start swarm"; }, 1500);
  }
  if (e.target.id === "ctl-stop") {
    const cfg = await chrome.storage.sync.get({ bridgeMode: "engine" });
    if (cfg.bridgeMode !== "remote") { try { await chrome.runtime.sendMessage({ type: "stop" }); } catch {} }
    else if (ctlWs?.readyState === 1) ctlWs.send(JSON.stringify({ type: "stop" }));
  }
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
// v0.9.18 CONVERSATION RENDERING: the engine mirrors every full-text prompt/
// reply into local.feedEvents (see pushFeed in swarm-engine.js). Render those
// as proper chat bubbles with markdown — previously the monitor only showed
// clipped debug log previews (~60-200 chars), which is what users saw as
// "conversation cut off at 200 characters". Replies whose text is missing or
// truncated relative to the bridge's own state.chat are upgraded to the real
// site-rendered HTML (markdown intact) via a DOM copy of the source bubble.
let lastFeedSeq = 0;
const chatByTab = new Map();               // tabId -> { ts, html } already-rendered real bubbles
async function drainFeedEvents(agentsByName) {
  const { feedEvents } = await chrome.storage.local.get({ feedEvents: [] });
  if (!Array.isArray(feedEvents)) return;
  for (const ev of feedEvents) {
    if (!Number.isFinite(ev.seq) || ev.seq <= lastFeedSeq) continue;
    lastFeedSeq = ev.seq;
    if (ev.type === "prompt") {            // incoming prompts duplicate the previous reply — skip
      renderChatLine({ agent: "you/engine", role: "prompt", text: ev.text, turn: ev.turn, ts: ev.ts, collapsed: true });
      continue;
    }
    if (ev.type === "reply" || ev.type === "error") {
      const needUpgrade = ev.type === "reply" && (!ev.text || String(ev.text).length < 400);
      let rendered = false;
      if (needUpgrade && Number.isInteger(ev.tabId)) {
        const key = `${ev.tabId}|${ev.ts}`;
        if (!chatByTab.has(key)) {
          try {
            const st = await chrome.tabs.sendMessage(ev.tabId, { type: "capture-html" });
            if (st && typeof st.html === "string" && st.html.length > 50) chatByTab.set(key, { ts: ev.ts, html: st.html });
          } catch {}
        }
        const cached = chatByTab.get(key);
        if (cached) { renderChatLine({ agent: ev.agent, role: "reply", html: cached.html, turn: ev.turn, ts: ev.ts }); rendered = true; }
      }
      if (!rendered) renderChatLine({ agent: ev.agent, role: ev.type === "error" ? "error" : "reply", text: ev.text, turn: ev.turn, ts: ev.ts });
    }
  }
}

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Defense-in-depth for site-HTML upgrades: strip script/style/iframe/object/
// svg nodes, on* attributes and javascript:/data: URLs before injection.
function sanitizeSiteHtml(raw) {
  try {
    const doc = new DOMParser().parseFromString(String(raw || ""), "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,link,meta,svg,form,input,button").forEach(n => n.remove());
    doc.querySelectorAll("*").forEach(n => {
      for (const a of [...n.attributes]) {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        else if ((a.name === "href" || a.name === "src") && /^\s*(javascript|data):/i.test(a.value)) n.removeAttribute(a.name);
      }
    });
    return doc.body.innerHTML;
  } catch { return esc(raw); }
}

// Minimal, XSS-safe markdown renderer (no external libs, CSP-friendly):
// fenced code blocks, inline code, bold/italic, headings, lists, links-by-url.
function mdToHtml(src) {
  const lines = String(src || "").split("\n");
  const out = []; let inCode = false; let codeBuf = [];
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const ln of lines) {
    const fence = /^\s*```/.test(ln);
    if (fence) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length + 1 > 6 ? 6 : h[1].length}>${inline(h[2])}</h${h[1].length + 1 > 6 ? 6 : h[1].length}>`); continue; }
    const li = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { out.push(`• ${inline(li[1])}<br>`); continue; }
    if (/^\s*(?:---|\*\*\*)\s*$/.test(ln)) { out.push("<hr>"); continue; }
    out.push(ln.trim() === "" ? "<br>" : inline(ln) + "<br>");
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  return out.join("");
}

function renderChatLine({ agent, role, text, html, turn, ts, collapsed }) {
  const feed = $("feed");
  $("empty")?.remove();
  const d = document.createElement("div");
  d.className = `msg chat ${role} ${agent || ""}`;
  if (collapsed) d.classList.add("collapsed");
  const time = ts ? new Date(ts).toLocaleTimeString() : new Date().toLocaleTimeString();
  const head = `<div class="meta"><span class="who ${String(agent || "").replace(/[^a-z0-9_-]/gi, "")}">${esc(agent)}</span><span>turn ${esc(turn ?? "\u2014")}</span><span>${esc(time)}</span></div>`;
  const body = html
    ? `<div class="txt md real">${sanitizeSiteHtml(html)}</div>`     // site-rendered HTML, scrubbed of scripts/handlers
    : `<div class="txt md">${mdToHtml(text)}</div>`;
  const fold = collapsed ? `<details><summary>↳ prompt (${String(text || "").length} chars)</summary>${body}</details>` : body;
  d.innerHTML = head + fold;
  feed.appendChild(d);
  // v0.9.19: through addDebugLine — chat lines can also arrive twice (feed
  // event + replay after clear), and the dump must stay free of duplicates.
  addDebugLine(`${time} ${role.toUpperCase()} ${agent}: ${clip(String(text || "[real-site-html]"), 400)}`);
  if (/REPLY|ERROR/.test(role.toUpperCase())) {
    const t = $("stat-turns"); t.textContent = Number(t.textContent) + 1;
    $("stat-last").textContent = time;
    if ($("stat-started").textContent === "—") $("stat-started").textContent = time;
  }
  nearBottom(feed) && (feed.scrollTop = feed.scrollHeight);
  trimDom();
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
  await drainFeedEvents(agents);
  // v0.9.18 BUGFIX ("RUN statistics do not update"): stat-turns was driven by
  // two competing sources — logLine()'s REPLY regex bump AND this overwrite
  // from swarmState.turnCount. SwarmState broadcasts lag (the engine only
  // calls broadcastState on phase changes, NOT after every reply), so the
  // overwrite kept resetting the counter behind the real progress. The feed
  // events ring IS the authoritative record now: count replies directly.
  const { feedEvents } = await chrome.storage.local.get({ feedEvents: [] });
  const replies = Array.isArray(feedEvents) ? feedEvents.filter(e => e.type === "reply") : [];
  const totalTurns = Math.max(1, Number(swarmState.turns) || 6) * 2;
  $("stat-turns").textContent = Math.min(replies.length, totalTurns);
  if (replies.length > 0) {
    const first = feedEvents.find(e => e.type === "prompt" || e.type === "reply");
    if (first && $("stat-started").textContent === "—") $("stat-started").textContent = new Date(first.ts || Date.now()).toLocaleTimeString();
    const last = replies[replies.length - 1];
    if (last?.ts) $("stat-last").textContent = new Date(last.ts).toLocaleTimeString();
  }
  // v0.9.18: keep the Start button visible whenever the engine is NOT running
  // (idle/armed/done) so the monitor can actually launch runs; previously it
  // appeared only in "armed" for one poll and vanished again mid-idle.
  const b1 = document.getElementById("ctl-start"), b2 = document.getElementById("ctl-stop");
  if (b1) { b1.style.display = swarmState.state !== "running" ? "" : "none"; b1.title = "Start the swarm with your saved popup Topic (arms + starts the in-browser engine)"; }
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
      <span>turn ${ev.turn ?? "—"}</span><span>${time}</span>${(ev.seconds !== null && ev.seconds !== undefined) ? `<span>${ev.seconds}s</span>` : ""}</div>
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
// v0.9.19 LOG HYGIENE (polluter B): the copy-debug dump contained every
// engine line TWICE — once from drainEngineRing() (ts "13:36:41") and once
// re-ingested from bridge `status` mirrors (wall-clock "3:36:41 PM"). The two
// timestamp formats in the user dump were that double ingestion. addDebugLine
// dedupes by content with the leading timestamp stripped, so the same message
// arriving through both paths lands in DEBUG_LINES exactly once.
function addDebugLine(l) {
  const key = String(l).replace(/^\S+\s/, "");   // strip leading timestamp token
  for (let i = DEBUG_LINES.length - 1; i >= 0 && i >= DEBUG_LINES.length - 250; i--) {
    if (String(DEBUG_LINES[i]).replace(/^\S+\s/, "") === key) return false;
  }
  DEBUG_LINES.push(l);
  if (DEBUG_LINES.length > 1200) DEBUG_LINES.splice(0, 200);
  return true;
}
function logLine(l) { if (!addDebugLine(l)) return;
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
$("clear").onclick = async () => { $("feed").innerHTML = ""; DEBUG_LINES = []; lastSeq = 0; lastFeedSeq = await ENGINE_FEED_HEAD(); chatByTab.clear(); };
// After clearing we must NOT replay the whole stored ring; jump the cursor to
// the newest seq so only genuinely new events render afterwards.
async function ENGINE_FEED_HEAD() {
  try {
    const { feedEvents } = await chrome.storage.local.get({ feedEvents: [] });
    return Array.isArray(feedEvents) && feedEvents.length ? feedEvents[feedEvents.length - 1].seq : 0;
  } catch { return 0; }
}  // v0.9.12: was a no-op (lastSeq = lastSeq) — cleared feed then the poller skipped every event with seq < old lastSeq → monitor looked dead/empty

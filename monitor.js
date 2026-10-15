// monitor.js — the third page: live view of the swarm, no tab-switching.
// The orchestrator starts a tiny HTTP server on an ephemeral port and writes
// that number to <SHOARMA_HOME>/monitor-port.txt (default: Downloads/shoarma,
// falling back to /tmp/shoarma). We probe candidate files until one answers;
// if none do, we show "waiting for orchestrator".
//   GET /state → { agents:{name:{state,turns}}, events:[{seq,type,...}] }
// Polls every 800ms; renders new conversation turns and (optionally) debug
// lines; one-click "Copy debug" gathers EVERYTHING for a bug report.

const $ = (id) => document.getElementById(id);
let httpPort = null;                 // discovered from monitor-port.txt
let lastSeq = 0;
let DEBUG_LINES = [];          // mirror of everything we render, for copy-paste
const MAX_DOM_EVENTS = 400;

function homeCandidates() {
  return [
    "file:///tmp/shoarma/monitor-port.txt",
    "file:///tmp/shoarma-monitor-port.txt",
  ];
}

async function discoverPort() {
  for (const u of homeCandidates()) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const p = parseInt((await r.text()).trim(), 10);
      if (p > 0 && p < 65536) return p;
    } catch {}
  }
  return null;
}

chrome.storage.sync.get({ halted: false }, (cfg) => {
  $("halted").checked = !!cfg.halted;
  poll(); setInterval(poll, 800);
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "sync" && ch.halted) $("halted").checked = !!ch.halted.newValue;
});
$("halted").onchange = () => chrome.storage.sync.set({ halted: $("halted").checked });
$("show-debug").onchange = applyDebugVisibility;

async function poll() {
  try {
    if (!httpPort) {
      httpPort = await discoverPort();
      if (!httpPort) throw new Error("no feed yet");
      $("stat-port").textContent = httpPort;
    }
    const res = await fetch(`http://127.0.0.1:${httpPort}/state`, { cache: "no-store" });
    const st = await res.json();
    setPill(true);
    renderAgents(st.agents || {});
    for (const ev of (st.events || [])) if (ev.seq > lastSeq) renderEvent(ev);
    trimDom();
  } catch {
    httpPort = null;               // re-probe next tick (orchestrator may restart)
    setPill(false);
  }
}

function setPill(up) {
  const p = $("pill");
  p.className = "pill " + (up ? "pill-live" : "pill-off");
  $("pill-text").textContent = up ? "live · orchestrator online" : "offline · waiting for orchestrator";
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
  lastSeq = Math.max(lastSeq, ev.seq);
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
$("clear").onclick = () => { $("feed").innerHTML = ""; DEBUG_LINES = []; lastSeq = lastSeq; };

// popup.js — the Shoarma control deck (v0.5.1: guided stepper, live progress,
// centralized copy-paste Activity log). Settings live in chrome.storage.sync;
// the bridge reads them on load and reacts to changes live.

const $ = (id) => document.getElementById(id);
const FIELDS = ["topic", "turns", "timeout", "port", "halted"];
const ACTIVITY = [];                       // centralized debug log for copy-paste
let feedPort = null;                       // discovered orchestrator monitor port
let lastEventSeq = 0;

function act(line) {
  const ts = new Date().toLocaleTimeString();
  ACTIVITY.push(`${ts} ${line}`);
  if (ACTIVITY.length > 800) ACTIVITY.splice(0, 200);
  const el = $("activity");
  if (el) { el.textContent = ACTIVITY.slice(-60).join("\n"); el.scrollTop = el.scrollHeight; }
}

document.addEventListener("DOMContentLoaded", async () => {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  $("install-link").href = chrome.runtime.getURL("orchestrator.py");

  // ── load saved settings ────────────────────────────────────────────────
  const cfg = await chrome.storage.sync.get({
    topic: "", turns: 6, timeout: 180, port: 8765, halted: false,
  });
  for (const f of FIELDS) {
    if (f === "halted") $("halted").checked = !!cfg[f];
    else $(f).value = cfg[f] ?? "";
  }

  // ── save-on-change (debounced) — no "apply" button needed anymore ─────
  let t;
  const save = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const next = {
        topic: $("topic").value.trim(),
        turns: clamp($("turns").value, 1, 50),
        timeout: clamp($("timeout").value, 30, 600),
        port: clamp($("port").value, 1024, 65535),
        halted: $("halted").checked,
      };
      await chrome.storage.sync.set(next);
      // v0.8.1: the "halted" checkbox previously only wrote storage — bridge.js
      // reacts to the sync change, but the orchestrator knew nothing at all and
      // kept typing into the *other* tab. Push the halt to the swarm directly;
      // the orchestrator now holds ALL dispatch while halted and mirrors the
      // state to every HUD pill + the monitor feed.
      if (next.halted !== undefined) {
        if (ctlWs?.readyState === 1) {
          ctlWs.send(JSON.stringify({ type: "halted", halted: next.halted }));
        } else {
          act("⚠ halt toggled but orchestrator WS not connected — tabs pause, swarm router does not");
        }
      }
      flash("Saved ✓ — open tabs update instantly.");
      act(`settings saved: turns=${next.turns} timeout=${next.timeout}s port=${next.port}`);
    }, 250);
  };
  FIELDS.forEach((f) => $(f).addEventListener("input", save));

  // ── one-click launch: no terminal, no typing paths ─────────────────────
  $("launch").onclick = async () => {
    $("launch").disabled = true;
    $("launch").textContent = "⏳ starting…";
    act("launch requested from popup");
    try {
      const res = await chrome.runtime.sendMessage({ type: "launch" });
      if (res?.ok) {
        const note = res.pid === -1 ? `Already running on port ${cfg.port} — reusing it.`
          : `Orchestrator running (pid ${res.pid}).`;
        setHint(note + " Transcript → Downloads/shoarma/", "ok");
        act(res.pid === -1 ? "orchestrator already up — standing down gracefully"
                           : `orchestrator spawned pid ${res.pid}`);
        chrome.runtime.sendMessage({ type: "open-monitor" });   // live view opens itself
        setStep(3);
      } else {
        setHint(res?.error || "Launch failed — run `python orchestrator.py` manually instead.", "err");
        act("LAUNCH FAILED: " + (res?.error || "unknown"));
      }
    } catch (e) {
      setHint("No one-click launcher installed yet — that's OK: unzip the extension folder, "
              + "open a terminal there and run: python orchestrator.py", "err");
      act("native launcher missing: " + e.message);
    } finally {
      $("launch").disabled = false;
      $("launch").textContent = "🚀 Launch swarm";
    }
  };

  // ── open the live monitor any time (works even without native host) ────
  $("monitor").onclick = () => { chrome.runtime.sendMessage({ type: "open-monitor" }); act("monitor tab opened"); };

  // ── v0.6 ▶ START / ■ STOP — talks to the orchestrator over its own WS port,
  //    exactly like a HUD pill does. The saved Topic + Turns ride the frame. ──
  let ctlWs = null, ctlRetry = 1000;
  function ctlConnect() {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${$("port").value || 8765}`);
      ctlWs = ws;
      ws.onopen = () => { ctlRetry = 1000; };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "swarm") applyPhase(m.state);
      };
      ws.onclose = () => { ctlWs = null; setTimeout(ctlConnect, Math.min(ctlRetry *= 1.5, 4000)); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch {}
  }
  ctlConnect();

  function applyPhase(ph) {
    const startBtn = $("start-run"), stopBtn = $("stop-run");
    startBtn.disabled = ph !== "armed";
    startBtn.textContent = ph === "armed" ? "▶ Start swarm" : "▶ Start swarm";
    stopBtn.hidden = ph !== "running";
    if (ph === "armed") setHint("Orchestrator is ARMED and waiting — press ▶ Start swarm (topic below is used).", "ok");
    if (ph === "running") { setHint("Swarm running — watch it in the 📟 monitor.", "ok"); launched = true; setStep(3); }
    if (ph === "done") setHint("Run finished. Transcript saved next to orchestrator.py.", "ok");
  }

  $("start-run").onclick = () => {
    if (ctlWs?.readyState !== 1) { setHint("Can't reach the orchestrator yet — did you press 🖥️ Start orchestrator (or run python orchestrator.py)?", "err"); return; }
    ctlWs.send(JSON.stringify({ type: "start", topic: $("topic").value.trim(), turns: clamp($("turns").value, 1, 50) }));
    act("▶ start sent from popup with popup topic (" + $("topic").value.trim().length + " chars)");
    $("start-run").disabled = true;
  };
  $("stop-run").onclick = () => {
    if (ctlWs?.readyState === 1) { ctlWs.send(JSON.stringify({ type: "stop" })); act("■ stop sent from popup"); }
  };

  // ── centralized activity log buttons ───────────────────────────────────
  $("copy-log").onclick = async () => {
    const header = `=== Shoarma popup activity · ${new Date().toISOString()} · v${chrome.runtime.getManifest().version} ===\n`;
    const text = header + ACTIVITY.join("\n");
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement("textarea"); ta.value = text;
            document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    $("copy-log").textContent = "✓ copied!";
    setTimeout(() => ($("copy-log").textContent = "📋 Copy all"), 2000);
  };
  $("clear-log").onclick = () => { ACTIVITY.length = 0; $("activity").textContent = ""; };

  // ── live tab roster: ask every bridge instance how it feels ────────────
  const tabsEl = $("tabs"), statusEl = $("status");
  let wired = 0, total = 0, launched = false;
  async function refresh() {
    const tabs = await chrome.tabs.query({ url: ["https://chat.qwen.ai/*", "https://chat.deepseek.com/*"] });
    tabsEl.innerHTML = "";
    let up = 0;
    for (const tab of tabs) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="agent">${host(tab.url)}</span><span class="st">…</span>`;
      tabsEl.appendChild(li);
      try {
        const st = await chrome.tabs.sendMessage(tab.id, { type: "status" });
        li.querySelector(".st").textContent = `${st.state} · ${st.turns}x${st.wsOpen ? "" : " · ws down"}`;
        if (st.wsOpen && st.state !== "halted") up++;
        if (st.state === "halted") li.classList.add("halted");
        else if (st.state === "idle") li.classList.add("idle");
      } catch {
        li.querySelector(".st").textContent = "bridge asleep — reload tab (F5)";
      }
    }
    wired = up; total = tabs.length;
    if (!tabs.length) {
      statusEl.className = "status down";
      statusEl.innerHTML = `<span class="dot"></span> no chat tabs open — log into qwen & deepseek`;
      setCoach(1);
    } else {
      statusEl.className = "status " + (up >= 2 ? "up" : "");
      statusEl.innerHTML = `<span class="dot"></span> ${up}/${tabs.length} agent(s) wired to the bridge`;
      setCoach(up >= 2 ? 2 : 1);
    }
    updateProgress();
  }
  refresh();
  setInterval(refresh, 2000);

  // ── coach line + stepper reflect real state, not guesses ───────────────
  function setCoach(step) {
    document.querySelectorAll(".step").forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle("done", n < step);
      el.classList.toggle("now", n === step);
    });
    const msgs = {
      1: "👋 Step 1 — open logged-in tabs of chat.deepseek.com and chat.qwen.ai.",
      2: "✅ Both agents are wired. Step 2 — hit 🚀 Launch swarm below.",
      3: "🟢 Swarm launched. Step 3 — watch the debate live in the Monitor tab.",
    };
    const c = $("coach");
    if (c && !launchedAt(step)) c.textContent = msgs[step];
    function launchedAt(s) { return s === 3 && launched; }
    if (step === 3) launched = true;
  }
  function setStep(n) { setCoach(n); }

  // ── live progress: poll the orchestrator feed while popup is open ──────
  async function pollFeed() {
    if (!feedPort) {
      // discovery ladder: saved WS port answers /state too (v0.5.1 server fix)
      const c = await chrome.storage.sync.get({ port: 8765 });
      for (const u of [`http://127.0.0.1:${c.port}/state`,
                       ...(feedPort ? [`${feedPort}`] : [])]) {
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 1200);
          const r = await fetch(u, { cache: "no-store", signal: ctl.signal });
          clearTimeout(tm);
          if (!r.ok) continue;
          const st = await r.json();
          if (st && "events" in st) { feedPort = st.feedPort || c.port; break; }
        } catch {}
      }
      if (!feedPort) return;
    }
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${feedPort}/state`, { cache: "no-store", signal: ctl.signal });
      clearTimeout(tm);
      if (!res.ok) { feedPort = null; return; }
      const st = await res.json();
      const evs = st.events || [];
      for (const ev of evs) {
        if (ev.seq <= lastEventSeq) continue;
        lastEventSeq = ev.seq;
        if (ev.type === "reply") act(`turn ${ev.turn} ${ev.agent}: ${clip(ev.text, 90)} (${ev.seconds}s)`);
        else if (ev.type === "sys") act("sys: " + clip(ev.text, 120));
        else if (ev.type === "log" && (ev.level === "WARN" || ev.level === "ERROR"))
          act(`[${ev.agent}] ${ev.level}: ${clip(ev.msg, 120)}`);
      }
      const sw = (st.agents || {})._swarm;
      if (sw && sw.state && sw.state !== "running") applyPhase(sw.state);
      else if (sw && sw.state === "running") applyPhase("running");
      const replies = evs.filter((e) => e.type === "reply").length;
      const totalTurns = clamp(($("turns").value || 6), 1, 50) * 2;
      const pct = Math.min(100, Math.round(replies / totalTurns * 100));
      $("pbar").style.width = pct + "%";
      $("ptext").textContent = replies ? `${replies}/${totalTurns} messages · ${pct}%` : "";
      if (replies > 0) { launched = true; setStep(3); }
    } catch { feedPort = null; }
  }
  pollFeed();
  setInterval(pollFeed, 1500);

  function updateProgress() {
    if (!total) { $("pbar").style.width = "0%"; $("ptext").textContent = ""; }
  }

  act("popup opened");
});

function clamp(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.min(hi, Math.max(lo, n));
}
function host(u) { try { return new URL(u).hostname.replace(/^chat\./, ""); } catch { return u; } }
function clip(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function setHint(text, cls) {
  const h = $("launch-hint");
  h.textContent = text;
  h.className = "hint " + (cls || "");
}
function flash(text) {
  const h = $("launch-hint");
  if (!h.textContent.startsWith("Orchestrator") && !h.textContent.startsWith("Already")) h.textContent = text;
}

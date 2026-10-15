// popup.js — the Shoarma control deck.
// Settings live in chrome.storage.sync (persist across restarts, sync to your
// Google account); the bridge reads them on load and reacts to changes live.

const $ = (id) => document.getElementById(id);
const FIELDS = ["topic", "turns", "timeout", "port", "halted"];

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

  // ── save-on-change (debounced) ─────────────────────────────────────────
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
      flash("Saved ✓ — open tabs update instantly.");
    }, 250);
  };
  FIELDS.forEach((f) => $(f).addEventListener("input", save));
  $("push").onclick = save;

  // ── one-click launch: no terminal, no typing paths ─────────────────────
  $("launch").onclick = async () => {
    $("launch").disabled = true;
    $("launch").textContent = "…";
    try {
      const res = await chrome.runtime.sendMessage({ type: "launch" });
      if (res?.ok) {
        setHint(`Orchestrator running (pid ${res.pid}). Transcript → Downloads/shoarma/`, "ok");
      } else {
        setHint(res?.error || "Launch failed — see hint above.", "err");
      }
    } catch (e) {
      setHint("Could not reach the extension's background worker: " + e.message, "err");
    } finally {
      $("launch").disabled = false;
      $("launch").textContent = "🚀 Launch swarm";
    }
  };

  // ── live tab roster: ask every bridge instance how it feels ────────────
  const tabsEl = $("tabs"), statusEl = $("status");
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
        li.querySelector(".st").textContent = "bridge asleep — reload tab";
      }
    }
    if (!tabs.length) {
      statusEl.className = "status down";
      statusEl.innerHTML = `<span class="dot"></span> no chat tabs open — log into qwen & deepseek`;
    } else {
      statusEl.className = "status " + (up >= 2 ? "up" : "");
      statusEl.innerHTML = `<span class="dot"></span> ${up}/${tabs.length} agent(s) wired to the bridge`;
    }
  }
  refresh();
  setInterval(refresh, 2000);
});

function clamp(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.min(hi, Math.max(lo, n));
}
function host(u) { try { return new URL(u).hostname.replace(/^chat\./, ""); } catch { return u; } }
function setHint(text, cls) {
  const h = $("launch-hint");
  h.textContent = text;
  h.className = "hint " + (cls || "");
}
function flash(text) {
  const h = $("launch-hint");
  if (!h.textContent.startsWith("Orchestrator")) h.textContent = text;
}

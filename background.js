// background.js — Shoarma service worker (v0.9: LEGACY COMPAT SHIM).
// The orchestrator's former jobs moved to swarm-engine.js (the real MV3
// service worker): agent dispatch, transcript persistence, and the in-browser
// "python-free" swarm loop. This file is NOT referenced by manifest.json;
// swarm-engine.js injects it on demand (chrome.scripting.registerContentScripts
// is not usable for workers) ONLY when the user selects "Remote orchestrator.py"
// mode, so the native-messaging launcher keeps working for headless users.

const HOST = "com.shoarma.launcher";

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // NOTE: "launch" is handled further below with the retired-launcher answer.
  if (msg?.type === "log") {                           // bridge debug → console
    const e = msg.entry || {};
    (e.level === "ERROR" ? console.warn : console.log)(`[Shoarma ${e.agent}] ${e.level}: ${e.msg}`, e.data ?? "");
    respond({ ok: true }); return false;
  }
  // ── v0.8: tab activation ────────────────────────────────────────────────
  // Sites throttle background tabs (React timers, input handlers, even the
  // WebSocket), so before every say()/confirm() the bridge asks US to bring
  // its own tab to the foreground — fully automated, no user interaction.
  if (msg?.type === "activate-tab") {
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId === null) { respond({ ok: false, error: "no tab" }); return false; }
    // v0.9.11 (ZAPPER.md): promise-safe chaining — a host environment that
    // hands back a non-Promise must never kill the worker with
    // "Cannot read properties of undefined (reading 'then')".
    asPromise(focusTab(tabId))
      .then(() => respond({ ok: true }))
      .catch((e) => respond({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  // v0.9.11 (ZAPPER.md): legacy launch path mirrored from swarm-engine.js —
  // the native launcher is retired in v0.9; answer honestly instead of
  // attempting a native call that would reject unhandled.
  if (msg?.type === "launch") {
    respond({ ok: false, error: "Native launcher is retired in v0.9 — switch the Orchestrator selector to 🌐 In-browser engine, or run `python orchestrator.py` manually for remote mode." });
    return false;
  }
});

// ── v0.9.11 (ZAPPER.md): promise-safe guards ────────────────────────────────
// Same contract as swarm-engine.js asPromise()/safeCatch(): never chain
// .then/.catch directly onto a value that might not be a Promise, and never
// let a rejection pass silently.
function asPromise(v) {
  if (v && typeof v.then === "function") return v;
  return Promise.resolve(v);
}
function safeCatch(p, onError) {
  asPromise(p).catch((e) => { try { onError(e); } catch {} });
}
self.addEventListener("unhandledrejection", (ev) => {
  console.warn("[Shoarma bg] unhandled rejection:", ev.reason);
});

let lastFocus = { tabId: -1, ts: 0 };
async function focusTab(tabId) {
  const now = Date.now();
  if (tabId === lastFocus.tabId && now - lastFocus.ts < 400) return;  // already focused
  lastFocus = { tabId, ts: now };
  const tab = await asPromise(chrome.tabs.get(tabId));
  if (!tab.active) {
    await asPromise(chrome.tabs.update(tabId, { active: true }));
  }
  if (tab.windowId !== undefined && tab.windowId !== null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  }
}

// `launch()` is intentionally NOT defined anymore (v0.9.11): the native
// launcher is retired and the listener answers "launch" with the friendly
// rejection directly, so no dead code hides an unhandled native call.

function nativeHelp(err) {
  if (!/not found|Specified native messaging host not found|native host/i.test(err)) {
    return "Launcher error: " + err;
  }
  const os = navigator.userAgentData?.platform || "?";
  const mac = /mac/i.test(os), linux = /linux/i.test(os);
  const dir = mac
    ? "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/"
    : linux ? "~/.config/google-chrome/NativeMessagingHosts/"
    : "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\NativeMessagingHosts\\";
  return `One-time setup needed to launch without a terminal: copy launcher/ (${mac||linux?"shoarma.launcher.json":"shoarma.launcher.bat"} + script) into ${dir} — or just run: python orchestrator.py`;
}

// ── badge ───────────────────────────────────────────────────────────────────
const live = new Set();
function bumpBadge(tabId) {
  if (tabId !== undefined && tabId !== null) live.add(tabId);
  chrome.action.setBadgeText({ text: live.size ? String(live.size) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4cc9f0" });
}
chrome.tabs.onRemoved.addListener((id) => { live.delete(id); refreshBadge(); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading") { live.delete(id); refreshBadge(); }
});
function refreshBadge() {
  chrome.action.setBadgeText({ text: live.size ? String(live.size) : "" });
}

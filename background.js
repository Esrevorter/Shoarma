// background.js — Shoarma service worker.
// Two jobs, both optional-granted:
//   1. "launch" → spawn orchestrator.py via a native messaging host, so users
//      never touch a terminal. If no native host is registered, we return a
//      friendly per-OS message telling them the one-line setup instead.
//   2. badge → show how many agent tabs are alive.

const HOST = "com.shoarma.launcher";

// v0.4: the live monitor page — a third tab where the whole swarm is visible
// in real time (replies, agent states, debug stream), so users never have to
// watch the terminal or alt-tab between chats.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "launch") { launch().then(respond); return true; }
  if (msg?.type === "open-monitor") {
    chrome.tabs.create({ url: chrome.runtime.getURL("monitor.html") });
    respond({ ok: true }); return false;
  }
  if (msg?.type === "log") {                           // bridge debug → console
    const e = msg.entry || {};
    (e.level === "ERROR" ? console.warn : console.log)(`[Shoarma ${e.agent}] ${e.level}: ${e.msg}`, e.data ?? "");
    respond({ ok: true }); return false;
  }
  if (msg?.type === "agent-count") {                 // bridge pings us on connect
    bumpBadge(sender.tab?.id);
    respond({ ok: true });
    return false;
  }
  // ── v0.8: tab activation ────────────────────────────────────────────────
  // Sites throttle background tabs (React timers, input handlers, even the
  // WebSocket), so before every say()/confirm() the bridge asks US to bring
  // its own tab to the foreground — fully automated, no user interaction.
  // chrome.tabs.update(tab.id, {active:true}) activates the tab AND focuses
  // its window. We debounce per-tab so rapid-fire requests don't thrash.
  if (msg?.type === "activate-tab") {
    const tabId = sender.tab?.id;
    if (tabId == null) { respond({ ok: false, error: "no tab" }); return false; }
    focusTab(tabId).then(
      () => respond({ ok: true }),
      (e) => respond({ ok: false, error: String(e && e.message || e) })
    );
    return true;
  }
});

let lastFocus = { tabId: -1, ts: 0 };
async function focusTab(tabId) {
  const now = Date.now();
  if (tabId === lastFocus.tabId && now - lastFocus.ts < 400) return;  // already focused
  lastFocus = { tabId, ts: now };
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
  }
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  }
}

async function launch() {
  const cfg = await chrome.storage.sync.get({ turns: 6, timeout: 180, port: 8765, topic: "" });
  try {
    const port = chrome.runtime.sendNativeMessage(HOST, cfg);
    const res = await port;
    return res?.ok
      ? { ok: true, pid: res.pid }
      : { ok: false, error: res?.error || "Launcher refused the request." };
  } catch (e) {
    return { ok: false, error: nativeHelp(String(e)) };
  }
}

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
  if (tabId != null) live.add(tabId);
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

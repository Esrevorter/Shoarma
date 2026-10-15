// background.js — Shoarma service worker.
// Two jobs, both optional-granted:
//   1. "launch" → spawn orchestrator.py via a native messaging host, so users
//      never touch a terminal. If no native host is registered, we return a
//      friendly per-OS message telling them the one-line setup instead.
//   2. badge → show how many agent tabs are alive.

const HOST = "com.shoarma.launcher";

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "launch") { launch().then(respond); return true; }
  if (msg?.type === "agent-count") {                 // bridge pings us on connect
    bumpBadge(sender.tab?.id);
    respond({ ok: true });
    return false;
  }
});

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

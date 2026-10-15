// ==UserScript==
// @name         Shoarma DOM probe
// @namespace    shoarma
// @version      1.0
// @description  One-shot dump of the real chat input / send button / reply bubble markup for DeepSeek & Qwen, so Shoarma's selectors can be fixed precisely.
// @match        https://chat.deepseek.com/*
// @match        https://chat.qwen.ai/*
// @run-at       document-idle
// ==/UserScript==
(() => {
  const out = [];
  const desc = (el) => {
    if (!el) return "null";
    const cls = typeof el.className === "string" ? el.className : "";
    const attrs = [...el.attributes].map(a => `${a.name}="${a.value.slice(0,60)}"`).join(" ");
    return `<${el.tagName.toLowerCase()} ${attrs}> .cls="${cls.slice(0,120)}" visible=${!!(el.getBoundingClientRect().width||el.getBoundingClientRect().height)} text="${(el.textContent||"").trim().slice(0,40)}"`;
  };
  const walkShadow = (root, depth, cb) => {
    if (depth > 6) return;
    for (const el of root.querySelectorAll("*")) { cb(el); if (el.shadowRoot) walkShadow(el.shadowRoot, depth+1, cb); }
  };

  setTimeout(() => {
    // 1) candidate INPUT boxes
    out.push("=== INPUT CANDIDATES ===");
    walkShadow(document, 0, el => {
      if (["TEXTAREA","INPUT"].includes(el.tagName) || el.isContentEditable) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 8) out.push(desc(el));
      }
    });
    // 2) all BUTTONS with position (send button is bottom-right-ish)
    out.push("=== BUTTONS (label/title/class/svg?) ===");
    const H = innerHeight, W = innerWidth;
    walkShadow(document, 0, el => {
      if (el.tagName !== "BUTTON") return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const nearBottom = r.top > H * 0.55 && r.left > W * 0.45;   // typical send-button zone
      const svg = el.querySelector("svg,path") ? "SVG" : "-";
      const lbl = (el.getAttribute("aria-label")||el.getAttribute("title")||el.textContent||"").trim().slice(0,40);
      out.push(`${nearBottom?"★":" "} [${svg}] "${lbl}" type=${el.type||""} ${desc(el).slice(0,160)}`);
    });
    // 3) last few message bubbles (assistant vs user structure)
    out.push("=== MESSAGE BUBBLE SAMPLES (last 6 in DOM order) ===");
    const seen = new Set();
    walkShadow(document, 0, el => {
      const t = (el.innerText||"").trim();
      if (t.length < 30 || t.length > 4000) return;
      if ([...seen].some(s => s.contains(el) || el.contains(s))) return;
      // only leafish blocks that look like messages
      if (el.children.length > 40) return;
      const roleAttrs = ["data-role","data-message-author-role","data-turn-role","class"].map(a=>{
        const v=(el.getAttribute&&el.getAttribute(a))||""; return a+"="+JSON.stringify(String(v).slice(0,80)); }).join(" ");
      out.push(`<${el.tagName.toLowerCase()}> ${roleAttrs} :: "${t.slice(0,70)}"`);
      seen.add(el);
    });
    const txt = out.join("\n");
    console.log(txt);
    window.__SHOARMA_PROBE__ = txt;
    alert("Shoarma probe done.\nPress Ctrl+C to copy the panel text below (or run: copy(window.__SHOARMA_PROBE__) in console), then paste it to the developer.\n\nFirst 900 chars:\n\n" + txt.slice(0, 900));
  }, 8000);  // wait for SPA to render; open a chat first!
})();

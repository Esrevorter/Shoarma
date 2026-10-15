/* Shoarma DOM probe v1 — paste into DevTools console on chat.qwen.ai or chat.deepseek.com */
(async () => {
  const out = [];
  const desc = (el) => {
    if (!el) return "null";
    const cls = typeof el.className === "string" ? el.className : "";
    const attrs = [...el.attributes].map(a => `${a.name}="${String(a.value).slice(0,60)}"`).join(" ");
    return `<${el.tagName.toLowerCase()} ${attrs}> .cls="${cls.slice(0,120)}" text="${(el.textContent||"").trim().slice(0,40)}"`;
  };
  const walkShadow = (root, depth, cb) => {
    if (depth > 6) return;
    for (const el of root.querySelectorAll("*")) { cb(el); if (el.shadowRoot) walkShadow(el.shadowRoot, depth+1, cb); }
  };
  out.push("URL: " + location.href);
  out.push("=== INPUT CANDIDATES ===");
  walkShadow(document, 0, el => {
    if (["TEXTAREA","INPUT"].includes(el.tagName) || el.isContentEditable) {
      const r = el.getBoundingClientRect();
      if (r.width > 30 && r.height > 8) out.push(desc(el));
    }
  });
  out.push("=== BUTTONS ([SVG] = contains icon; ★ = bottom-right zone where send usually lives) ===");
  const H = innerHeight, W = innerWidth;
  walkShadow(document, 0, el => {
    if (el.tagName !== "BUTTON") return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const star = (r.top > H * 0.55 && r.left > W * 0.45) ? "★" : " ";
    const svg = el.querySelector("svg,path") ? "SVG" : "-";
    const lbl = (el.getAttribute("aria-label")||el.getAttribute("title")||el.textContent||"").trim().slice(0,40);
    out.push(`${star} [${svg}] "${lbl}" type=${el.type||""} ${desc(el).slice(0,170)}`);
  });
  out.push("=== MESSAGE BUBBLE SAMPLES ===");
  const seen = [];
  walkShadow(document, 0, el => {
    const t = (el.innerText||"").trim();
    if (t.length < 30 || t.length > 4000 || el.children.length > 40) return;
    if (seen.some(s => s.contains(el) || el.contains(s))) return;
    seen.push(el);
    const attrs = ["data-role","data-message-author-role","data-turn-role","class"]
      .map(a => a+"="+JSON.stringify(String((el.getAttribute&&el.getAttribute(a))||"").slice(0,90))).join(" ");
    out.push(`<${el.tagName.toLowerCase()}> ${attrs} :: "${t.slice(0,70)}"`);
  });
  const txt = out.join("\n");
  console.log(txt);
  window.__SHOARMA_PROBE__ = txt;
  try { await navigator.clipboard.writeText(txt); alert("Probe done ✅ report copied to clipboard — paste it to the developer."); }
  catch { alert("Probe done. Run: copy(window.__SHOARMA_PROBE__)  then paste to the developer."); }
})();

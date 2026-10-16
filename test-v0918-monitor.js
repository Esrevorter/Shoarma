// test-v0918-monitor.js — deterministic checks for the v0.9.18 monitor overhaul:
//   1) engine pushFeed writes FULL-TEXT events into local.feedEvents (no 200-char clip)
//   2) arm() resets the feed ring so a new run doesn't mix with the old conversation
//   3) monitor mdToHtml renders markdown (code fences, bold, lists) and escapes HTML
//   4) monitor sanitizeSiteHtml strips scripts/handlers from site-HTML upgrades
//   5) monitor start button targets the ENGINE (runtime messages), not only the dead WS
'use strict';
const fs = require('fs');
const vm = require('vm');

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

// ── shared fake chrome.storage ────────────────────────────────────────────
function makeStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    _data: data,
    local: {
      get(keys, cb) {
        const out = {};
        for (const k of Object.keys(keys)) out[k] = data[k] !== undefined ? data[k] : keys[k];
        if (cb) return cb(out);
        return Promise.resolve(out);
      },
      set(obj, cb) { Object.assign(data, obj); if (cb) cb(); return Promise.resolve(); },
    },
  };
}

// ═══ 1+2) engine feed: extract pushFeed + exercise it in isolation ════════
const engineSrc = fs.readFileSync(__dirname + '/swarm-engine.js', 'utf8');
check('engine defines pushFeed', /function pushFeed\(/.test(engineSrc));
check('sendPromptToCurrent pushes prompt event', /pushFeed\(\{ type: "prompt"/.test(engineSrc));
check('onReply pushes reply event with FULL text (no slice on feed text)',
      /pushFeed\(\{ type: "reply", agent: fromName, turn: ENGINE\.turnCount, text,/.test(engineSrc));
check('arm() clears the stored feed ring', /chrome\.storage\.local\.set\(\{ feedEvents: \[\] \}\)/.test(engineSrc));
check('persistTranscript runs mid-run (lastTranscript stays fresh)',
      (engineSrc.match(/persistTranscript\(\);/g) || []).length >= 3);

const sandbox = { chrome: { storage: makeStorage({ feedEvents: [] }) }, console };
vm.createContext(sandbox);
const m = engineSrc.match(/const ENGINE = \{[\s\S]*?\n\};\n\n\/\/[^\n]*\n(?:\/\/[^\n]*\n)*function pushFeed[\s\S]*?\n\}/);
if (!m) { console.log('FAIL  could not extract ENGINE+pushFeed block'); process.exit(1); }
vm.runInContext(m[0], sandbox);

(async () => {
  const big = 'X'.repeat(5000);                       // a long reply — must survive unclipped
  await sandbox.pushFeed({ type: 'reply', agent: 'qwen', turn: 3, text: big });
  await sandbox.pushFeed({ type: 'prompt', agent: 'deepseek', turn: 4, text: 'P'.repeat(3000) });
  const st = await sandbox.chrome.storage.local.get({ feedEvents: [] });
  const evs = st.feedEvents;
  check('feed stores BOTH events with monotonic seq', evs.length === 2 && evs[0].seq === 1 && evs[1].seq === 2);
  check('feed keeps FULL 5000-char reply (issue #2: no 200-char cut)', evs[0].text.length === 5000);
  check('feed entries carry ts', Number.isFinite(evs[0].ts));

  // ring cap at 200
  for (let i = 0; i < 260; i++) await sandbox.pushFeed({ type: 'ping', i });
  const st2 = await sandbox.chrome.storage.local.get({ feedEvents: [] });
  check('feed ring capped at 200 newest', st2.feedEvents.length === 200 && st2.feedEvents[199].seq === 262);

  // ═══ 3+4) monitor renderers: extract esc/mdToHtml/sanitizeSiteHtml ══════
  const monSrc = fs.readFileSync(__dirname + '/monitor.js', 'utf8');
  check('monitor drains feedEvents', /async function drainFeedEvents\(/.test(monSrc));
  check('monitor sends arm+start through runtime (engine mode)',
        /chrome\.runtime\.sendMessage\(\{ type: "arm"/.test(monSrc) && /chrome\.runtime\.sendMessage\(\{ type: "start"/.test(monSrc));
  check('RUN stats count replies from the feed ring (not lagging swarmState)',
        /feedEvents\.filter\(e => e\.type === "reply"\)/.test(monSrc));
  check('Start visible whenever engine is not running', /state !== "running" \? "" : "none"/.test(monSrc));

  // extract the three renderer functions individually (robust to comments between them)
  function grab(src, headerRe) {
    const hm = src.match(headerRe);
    if (!hm) return null;
    const start = hm.index;
    let depth = 0, seenOpen = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === "{") { depth++; seenOpen = true; }
      else if (c === "}") { depth--; if (seenOpen && depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }
  const fns = [grab(monSrc, /function esc\(s\) \{/), grab(monSrc, /function sanitizeSiteHtml\(raw\) \{/), grab(monSrc, /function mdToHtml\(src\) \{/)];
  const fnBlock = fns[0] ? { 0: fns.join("\n\n") } : null;
  if (!fnBlock) { console.log('FAIL  could not extract monitor renderer functions'); process.exit(1); }
  const docStub = {
    body: {},
    parse(htmlStr) {
      // minimal DOMParser stand-in: record removals via regex
      const cleaned = htmlStr
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/ onclick="[^"]*"/gi, '')
        .replace(/ href="javascript:[^"]*"/gi, '');
      this.lastCleaned = cleaned;
      return cleaned;
    },
  };
  const msb = {
    document: {
      createElement: () => ({ set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; }, style: {} }),
      querySelectorAll: () => [],
    },
    DOMParser: function () {
      this.parseFromString = (raw) => {
        const cleaned = raw
          .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
          .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
          .replace(/\son\w+="[^"]*"/gi, '')
          .replace(/\shref="javascript:[^"]*"/gi, '');
        return {
          body: { innerHTML: cleaned },
          querySelectorAll: () => [],
        };
      };
    },
  };
  vm.createContext(msb);
  vm.runInContext(fnBlock[0], msb);
  const md = msb.mdToHtml('# Title\n\n**bold** and `code`\n\n```js\nlet x = 1 < 2;\n```\n\n- item one\n- item two');
  check('mdToHtml renders headings/bold/code', /<h1>Title<\/h1>/.test(md) && /<b>bold<\/b>/.test(md) && /<code>code<\/code>/.test(md));
  check('mdToHtml renders fenced code with escaping', /<pre><code>let x = 1 &lt; 2;<\/code><\/pre>/.test(md));
  check('mdToHtml renders list items', (md.match(/• /g) || []).length === 2);
  const evil = msb.mdToHtml('<img src=x onerror=alert(1)> hello');
  check('mdToHtml escapes raw HTML (XSS-safe)', !/<img/.test(evil) && /&lt;img/.test(evil));
  const san = msb.sanitizeSiteHtml('<p>hi</p><script>alert(1)</script><a href="javascript:x">l</a><b onclick="e">c</b>');
  check('sanitizeSiteHtml strips script/js-url/on*', !/script/i.test(san) && !/javascript:/i.test(san) && !/onclick/i.test(san) && /hi/.test(san));

  // ═══ 5) bridge exposes full chat + capture-html handler ═════════════════
  const brSrc = fs.readFileSync(__dirname + '/bridge.js', 'utf8');
  check('bridge status frame carries full chat', /chat: state\.chat \? \{ prompt: state\.chat\.prompt, reply: state\.chat\.reply/.test(brSrc));
  check('bridge records full prompt text (no clip)', /state\.chat = \{ prompt: String\(text \|\| ""\)/.test(brSrc));
  check('bridge answers capture-html', /m\?\.type === "capture-html"/.test(brSrc));

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();

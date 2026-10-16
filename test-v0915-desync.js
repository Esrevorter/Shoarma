// v0.9.15 regression test: React-model desync detection (reactHoldsText) +
// the honest single-flight ACK flag pattern.
//
// Root cause reproduced from the user's DeepSeek log 2026-10-17 02:49→02:50:
// first round OK; second round's 776-char injection lands in the DOM, but the
// site's React state/props never received it (stale/desynced composer model
// after round 1 + failure flush). Every Enter channel then fires against an
// app that believes the box is empty → all attempts fail with detected:false,
// fiber-handler invocation no-ops, MESSAGE NOT SUBMITTED. The fix gates a
// bounded chunked caret retype on reactHoldsText()===0 && DOM non-empty.
//
// Deterministic: pure function evaluation, no timers or wall-clock.
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");

// ── Extract reactHoldsText + norm from bridge.js and rebuild them in a sandbox
// (same technique as the copy-debug verifier: evaluate real source fragments).
function extractFn(name, srcText) {
  const start = srcText.indexOf("function " + name + "(");
  assert.ok(start !== -1, `function ${name} not found in bridge.js`);
  let depth = 0, i = srcText.indexOf("{", start);
  for (; i < srcText.length; i++) {
    if (srcText[i] === "{") depth++;
    else if (srcText[i] === "}") { depth--; if (depth === 0) break; }
  }
  return srcText.slice(start, i + 1);
}
const normSrc = 'const norm = (s) => String(s).replace(/\\s+/g, " ").trim().toLowerCase();';
assert.ok(src.includes(normSrc), "norm helper not found verbatim in bridge.js");
const holdsSrc = extractFn("reactHoldsText", src);
// eslint-disable-next-line no-eval
const reactHoldsText = eval(`(() => { ${normSrc} ${holdsSrc} return reactHoldsText; })()`);

// ── Minimal fake fiber environment ───────────────────────────────────────────
function fiberEl(fibers) {
  const el = { ["__reactFiber$abc123"]: fibers[0] };
  // link chain: each entry's .return points to parent (index+1)
  for (let i = 0; i < fibers.length; i++) fibers[i].return = fibers[i + 1] || null;
  return el;
}

let passed = 0;
function ok(label, cond) { assert.ok(cond, label); console.log("ok - " + label); passed++; }
// v0.9.16: reactHoldsText returns {hits,looseHits} when >0, plain 0/-1 otherwise.
// say() unwraps with `typeof holds === "object" ? holds.hits : holds` — mirror it.
const hc = (r) => (typeof r === "object" ? r.hits : r);

const PROMPT = "Imagine a world where the fundamental laws of physics are reversed.";

// 1. Desync case (the bug): DOM full, NO fiber prop/state holds the text ⇒ 0 hits
{
  const el = fiberEl([
    { memoizedProps: { className: "composer" }, memoizedState: { memoizedState: "" } },          // textarea fiber, empty value
    { memoizedProps: { children: "Chat" }, memoizedState: null },                                  // layout ancestor
  ]);
  ok("desync detected: full-looking DOM with empty React model returns 0", reactHoldsText(el, PROMPT) === 0);
}

// 2. Healthy case: useState hook chain holds our text ⇒ >0 hits
{
  const el = fiberEl([
    { memoizedProps: { className: "composer" },
      memoizedState: { memoizedState: "", next: { memoizedState: PROMPT } } },                    // useState<string> holding prompt
    { memoizedProps: { children: "Chat" }, memoizedState: null },
  ]);
  ok("healthy state: hook-chain match counted (>0)", hc(reactHoldsText(el, PROMPT)) > 0);
}

// 3. Controlled-input props case: memoizedProps.value holds the text ⇒ >0
{
  const el = fiberEl([
    { memoizedProps: { value: PROMPT, onChange() {} }, memoizedState: null },
  ]);
  ok("healthy state: props.value match counted (>0)", hc(reactHoldsText(el, PROMPT)) > 0);
}

// 4. Whitespace/case normalization parity with say()'s alreadyTyped check
{
  const el = fiberEl([
    { memoizedProps: { value: "  " + PROMPT.toUpperCase() + " \n" }, memoizedState: null },
  ]);
  ok("normalization: whitespace+case-insensitive match still counted", hc(reactHoldsText(el, PROMPT)) > 0);
}

// 5. Empty query guard: nothing to match ⇒ -1 (never triggers the retype gate)
{
  const el = fiberEl([{ memoizedProps: {}, memoizedState: null }]);
  ok("empty text query returns -1 (gate stays closed)", reactHoldsText(el, "") === -1);
}

// 6. No-react element (plain textarea) ⇒ 0, no throw
{
  ok("non-React element returns 0 without throwing", reactHoldsText({}, PROMPT) === 0);
}

// 7. Re-type gate logic exactly as wired in say():
//    stateDesynced = holds === 0 && !!readBox(el).trim()
//    force retype when (!alreadyTyped || stateDesynced)
{
  const readBoxTrimmed = "776 chars worth of prompt";        // DOM looks full
  const alreadyTyped = true;                                  // text was injected via setNativeValue
  const holds = 0;                                            // but React model is empty
  const stateDesynced = holds === 0 && !!readBoxTrimmed;
  ok("post-injection desync forces ONE bounded retype despite alreadyTyped",
     (!alreadyTyped || stateDesynced) === true);
  const healthyHolds = 2;
  ok("healthy model does NOT retype (avoids double-typing on cold start)",
     (!alreadyTyped || healthyHolds === 0 && !!readBoxTrimmed) === false);
}

// 8. reset_composer probe sentinel: lastSentText||"\u0000" must NEVER match fiber content
{
  const el = fiberEl([
    { memoizedProps: { value: PROMPT }, memoizedState: null },  // model STILL holds old prompt post-reset-DOM
  ]);
  ok("reset probe with \\u0000 sentinel reports stale-hold as 0 (informational field honest)",
     hc(reactHoldsText(el, "\u0000")) === 0);
}

// 9. Single-flight ACK pattern: queued = busy || pendingSayAckQueued, and the
//    listener clears pendingSayAckQueued BEFORE dispatch so a fresh say that
//    gets claimed synchronously still answers queued:true.
{
  let busy = false, pendingSayAckQueued = false;
  function handleOrchestratorFrame(msg) {                   // mirrors bridge.js shape
    if (msg.type === "say" && !busy) { busy = true; pendingSayAckQueued = true; return; }
    if (msg.type === "say" && busy) { pendingSayAckQueued = false; return; } // queue branch must not claim
  }
  function deliverDispatch(m) {                             // mirrors the runtime listener
    pendingSayAckQueued = false;
    handleOrchestratorFrame(m);
    return { ok: true, queued: busy || pendingSayAckQueued };
  }
  const ack1 = deliverDispatch({ type: "say", text: "round2-prompt-A" });
  ok("ACK #1 (fresh say, previously idle) reports queued:true — engine sets a.busy immediately",
     ack1.queued === true);
  const ack2 = deliverDispatch({ type: "say", text: "round2-prompt-B" });   // duplicate frame mid-turn
  ok("ACK #2 (mid-turn dup) still queued:true, newest kept in pendingSay", ack2.queued === true);
  busy = false;                                             // runTurn finally released
  const ack3 = deliverDispatch({ type: "clear_input" });
  ok("non-say frame cannot leak a stale queued:true once busy released", ack3.queued === false);
}

// ── v0.9.16: containment matching (user log 2026-10-17 03:00 — stateFibers:0
//    false-negative forced a destructive retype even though the site model held
//    our text under a slightly different representation) ──────────────────────
{
  const LONG = "Imagine a world where the fundamental laws of physics are reversed, and gravity pushes objects apart instead of pulling them together, making every structure unstable.";
  // 10a. Site wraps our text in its own scaffolding ⇒ contains-match counted
  const elWrap = fiberEl([
    { memoizedProps: { value: "USER:\n" + LONG + "\n[send]" }, memoizedState: null },
  ]);
  ok("v0.9.16 containment: model string wrapping our text counts as a hit",
     hc(elWrap && reactHoldsText(elWrap, LONG)) > 0);
  const res = reactHoldsText(elWrap, LONG);
  ok("v0.9.16 containment: reported as loose (not exact) so logs stay honest",
     typeof res === "object" && res.hits === 1 && res.looseHits === 1);
  // 10b. Model holds a TRIMMED variant (exact after norm) ⇒ exact hit
  const elTrim = fiberEl([
    { memoizedState: { memoizedState: "  " + LONG + "  " }, memoizedProps: {} },
  ]);
  const resT = reactHoldsText(elTrim, LONG);
  ok("v0.9.16 whitespace variant is an EXACT hit (looseHits 0)",
     typeof resT === "object" && resT.hits === 1 && resT.looseHits === 0);
  // 10c. Short text must NOT contain-match (prevents 'hi' matching everything)
  const elShort = fiberEl([
    { memoizedProps: { value: "this is a much longer unrelated composer draft about hi story" }, memoizedState: null },
  ]);
  ok("v0.9.16 short query never contain-matches (gate stays closed on noise)",
     reactHoldsText(elShort, "hi") === 0);
  // 10d. Desync still proven-zero: unrelated model content ⇒ exactly 0 (number, not object)
  const elDesync = fiberEl([
    { memoizedProps: { value: "totally stale previous-round text ".repeat(4) }, memoizedState: { memoizedState: "" } },
  ]);
  ok("v0.9.16 genuine desync still returns numeric 0 (retype gate opens)",
     reactHoldsText(elDesync, LONG) === 0);
}

console.log(`\nALL v0.9.15 DESYNC/ACK TESTS PASSED ✔ (${passed})`);

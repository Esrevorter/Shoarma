#!/usr/bin/env python3
"""v0.9.8 regression guard — promise-safe messaging in the MV3 service worker.

The user's error.log (2026-10-16) showed the swarm-engine service worker dying
at boot with:
    TypeError: Cannot read properties of undefined (reading 'catch')
because a chrome.* call returned `undefined` instead of a Promise and the code
chained .catch()/.then() straight onto the return value. Once the worker dies,
every later message fails with "Receiving end does not exist" — the symptom
that persisted across v0.9.5..v0.9.7.

These tests parse swarm-engine.js and assert:
  1. asPromise(), safeCatch() and the unhandledrejection shield exist;
  2. NO chained member call (.then(...)/.catch(...)) is applied directly to a
     chrome.* API invocation anywhere in the file — every such site must go
     through asPromise()/safeCatch();
  3. deliver() routes its sendMessage result through asPromise before chaining.
"""
import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parent.parent / "swarm-engine.js"
text = SRC.read_text(encoding="utf-8")

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f"  {name}")
    if not cond:
        failures.append(name)


# ── 1. guards present ────────────────────────────────────────────────────────
check("asPromise() defined", "function asPromise(v)" in text)
check("safeCatch() defined", "function safeCatch(p" in text)
check("unhandledrejection shield registered",
      'self.addEventListener("unhandledrejection"' in text)

# ── 2. no unguarded chained calls on chrome.* results ────────────────────────
code = re.sub(r"//[^\n]*", "", text)          # drop line comments
violations = []
for m in re.finditer(
        r"\bchrome\.[A-Za-z]+\.[A-Za-z]+\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.(?:then|catch)\s*\(",
        code):
    violations.append(m.group(0)[:70])
check("no direct .then/.catch chained onto chrome.* calls", not violations)
if violations:
    print("  offending sites:")
    for v in violations:
        print("   ", v)

# ── 3. deliver() uses asPromise before chaining ──────────────────────────────
deliver_src = text[text.index("function deliver("):]
deliver_src = deliver_src[:deliver_src.index("\n}\n")]
check("deliver() wraps sendMessage in asPromise()",
      "asPromise(chrome.tabs.sendMessage" in deliver_src)
check("deliver() chains only on the guarded variable", "if (p) p.then" in deliver_src)

print()
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("ALL PASSED")

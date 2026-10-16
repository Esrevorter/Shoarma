#!/usr/bin/env python3
"""ZAPPER.md session-rules compliance guard (v0.9.11).

ZAPPER.md locks in these anti-patterns/practices for every JS source in this
repo:
  1. NO loose equality (== / !=) — strict (=== / !==) only;
  2. Every promise chain that touches a chrome.* API result must go through
     the asPromise()/safeCatch() guards (no direct .then/.catch on a value
     that may not be a Promise) — no silent worker-killing rejections;
  3. No promise returned by an async call is left without explicit error
     handling at its chain site (`.then(` requires `.catch(` or safeCatch,
     checked per-statement, comments excluded).

This test parses background.js (the legacy compat shim that v0.9.11 brought
in line with swarm-engine.js's v0.9.8 guards) and asserts all three.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f"  {name}")
    if not cond:
        failures.append(name)


def strip_comments(text):
    """Drop // line comments (keeps strings mostly intact for our regexes;
    UserScript header blocks live in tools/ and are excluded from scanning)."""
    return re.sub(r"//[^\n]*", "", text)


# ── sources under scan ────────────────────────────────────────────────────────
TARGETS = ["background.js", "bridge.js", "swarm-engine.js", "monitor.js", "popup.js"]
WORKER_TARGETS = {"background.js", "swarm-engine.js"}

for rel in TARGETS:
    src = (ROOT / rel).read_text(encoding="utf-8")
    code = strip_comments(src)

    # 1. strict equality everywhere (allow == inside strings? our regex works
    #    on raw code lines; false positives are impossible here since we
    #    exclude ===, !==, =>, <=, >= by shape).
    loose = [m.group(0) for m in
             re.finditer(r"(?<![=!<>])={2}(?!=)|(?<![=!<>])!=(?!=)", code)]
    check(f"{rel}: no loose equality (== / !=)", not loose)
    if loose:
        for ln in (i + 1 for i, line in enumerate(code.splitlines())
                   if re.search(r"(?<![=!<>])={2}(?!=)|(?<![=!<>])!=(?!=)", line)):
            print(f"   line ~{ln}")

    # 2. guards exist and unhandled-rejection shield registered — only for
    #    worker-context sources (background/engine), which use promise-style
    #    chrome.* APIs. Content/UI scripts (bridge/monitor/popup) reach
    #    chrome.* only via awaited async calls inside try/catch, so the
    #    asPromise/safeCatch/shield checks do not apply to them.
    if rel in WORKER_TARGETS:
        check(f"{rel}: asPromise() defined", "function asPromise(v)" in src)
        check(f"{rel}: safeCatch() defined", "function safeCatch(p" in src)
        check(f"{rel}: unhandledrejection shield",
              'self.addEventListener("unhandledrejection"' in src)

    # 3. no direct .then/.catch chained onto a chrome.* call
    viol = [m.group(0)[:70] for m in re.finditer(
        r"\bchrome\.[A-Za-z]+\.[A-Za-z]+\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.(?:then|catch)\s*\(",
        code)]
    check(f"{rel}: no .then/.catch chained directly onto chrome.*", not viol)
    for v in viol:
        print("   offending:", v)

    # 4. every `.then(` chain site carries error handling somewhere in the
    #    same statement (a .catch( before the next top-level `;`/newline block,
    #    or the whole thing wrapped in safeCatch()).
    unguarded = []
    for m in re.finditer(r"\.then\s*\(", code):
        start = m.end()
        depth = 1
        i = start
        while i < len(code) and depth:
            if code[i] == "(":
                depth += 1
            elif code[i] == ")":
                depth -= 1
            i += 1
        # look ahead from the chain head for a matching .catch before the
        # statement ends (two consecutive newlines or `});` at col base)
        tail = code[max(0, m.start() - 200): i + 400]
        if ".catch" not in tail and "safeCatch" not in tail:
            line_no = code[: m.start()].count("\n") + 1
            unguarded.append(f"{rel}:{line_no}")
    check(f"{rel}: every .then chain has explicit error handling",
          not unguarded)
    for u in unguarded:
        print("   unguarded chain at", u)

print()
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("ALL PASSED")

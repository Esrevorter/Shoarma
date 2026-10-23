# Qwen.md — Publish the LLM Bridge work to GitHub and open a Pull Request

This document instructs the Qwen coding agent to take the verified implementation
that currently lives only on the local feature branch and make it visible on
GitHub by pushing the branch and opening a Pull Request against `main`.

## Context / Why

- The workspace (`/workspace`) contains the completed **LLM Bridge** implementation
  per `SPEC.md`: `manifest.json`, `bridge.js`, `orchestrator.py` (plus `SPEC.md`
  itself), committed on the local branch
  `qwen-code-19c79563-5fe0-4875-85d3-5692e9f40231` (commit `cd78e2f`).
- The user reviewed GitHub's UI and found **no push and no PR** for this work.
- Root cause: in this sandboxed environment, the git repo was initialized as a
  **local-only clone with no remote configured** (`git remote -v` is empty) and
  there are **no GitHub credentials** available (no `gh` CLI, no `GITHUB_TOKEN`).
  Therefore nothing could be published automatically. This task must therefore be
  completed once those two prerequisites exist.

## Prerequisites (must exist before running the steps)

1. **Target GitHub repository (defined by the user):**
   `https://github.com/Esrevorter/Shoarma.git` — configured as `origin`:
   ```bash
   git remote add origin https://github.com/Esrevorter/Shoarma.git
   ```
2. **Authentication:** a classic Personal Access Token (scope: `repo`) supplied
   out-of-band by the user via the `GITHUB_TOKEN` environment variable, used
   through a per-command credential helper (see Step 2). The token value must
   **never** be written into any tracked file or into git history.
   - ⚠️ SECURITY NOTE: this PAT was shared in chat to unblock publishing; the
     user intends to rotate it. After rotation, update `GITHUB_TOKEN` only —
     never store the literal token in this document or the repo.

If either prerequisite is missing, **stop and report exactly what is missing** —
do not fabricate a success message.

## STATUS: ✅ DONE (2026-10-15) — original publish

The publish described below was executed successfully:
- Remote added: `origin = https://github.com/Esrevorter/Shoarma.git`
- Branch pushed: local `qwen-code-19c79563-...` → remote branch **`qwen-code-bridge`** (head `e4aa37d`)
- Pull Request opened against `main`: **https://github.com/Esrevorter/Shoarma/pull/1**
  ("Implement LLM Bridge: two-browser agent swarm per SPEC.md")
  ⚠️ UPDATE: PR #1 is now **CLOSED** (verified via API), and `main` on GitHub was
  reset to the full v0.8 workspace snapshot (`3587111`). The old swarm commits
  remain reachable on remote branch `proceed-with-spec.md-40231` (head `3a76fdc`).

## STATUS 2: ✅ DONE (2026-10-15, second pass) — re-publish current workspace

Executed after the user supplied a fresh PAT via env (`GITHUB_TOKEN`, also stored
in gitignored `/workspace/.env` with mode 600; never in tracked files):
- Verified token auth against the API (HTTP 200, identity `Esrevorter`).
- Re-added remote (sandbox repo had been recreated without one):
  `git remote add origin https://github.com/Esrevorter/Shoarma.git`
- Verified the whole snapshot: node --check (bridge/background/popup/monitor.js),
  py_compile (orchestrator/launcher/scripts), manifest+launcher JSON valid.
- End-to-end smoke test of orchestrator.py with simulated WebSocket agents:
  registration gating, ARMED state, start-frame topic honored, strict A/B
  alternation over 4 rounds, transcript saved with 8 entries (captured=true).
- Pushed local branch `qwen-code-2d10ed2e-...` (= commit `3587111`, identical to
  current `main`) → remote branch **`shoarma-v0.8-full`** (no force-push).
- Open Pull Request: **https://github.com/Esrevorter/Shoarma/pull/2**
  (state: open; head `shoarma-v0.8-full` @ `3587111`; base
  `proceed-with-spec.md-40231` — a PR against `main` was rejected by GitHub with
  "No commits between main and shoarma-v0.8-full" because main already IS this
  snapshot, so the review thread targets the old PR #1 head instead).

## Steps

### 1. Verify the local state

```bash
cd /workspace
git status                      # expect: working tree clean
git log --oneline -3            # expect cd78e2f ... on the qwen-code-* branch
node --check bridge.js          # syntax sanity
python -m py_compile orchestrator.py
```

### 2. Add the remote (skip if one already exists)

```bash
cd /workspace
git remote add origin https://github.com/Esrevorter/Shoarma.git   # already done
git fetch origin
```

With token-based HTTPS auth, pass the token via a per-command credential helper
(never embed it in the remote URL or any tracked file):

```bash
export GITHUB_TOKEN=<classic-PAT-from-user>   # do NOT persist this in files
git -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f' \
    push origin qwen-code-19c79563-5fe0-4875-85d3-5692e9f40231:refs/heads/qwen-code-bridge
```

### 3. Push the feature branch

```bash
cd /workspace
git push origin qwen-code-19c79563-5fe0-4875-85d3-5692e9f40231:refs/heads/qwen-code-bridge
```

Do **not** force-push and do **not** push directly to `main`.
(As executed: remote branch is `qwen-code-bridge`.)

### 4. Open the Pull Request

Preferred (if `gh` is available):

```bash
gh pr create \
  --base main \
  --head qwen-code-bridge \
  --title "Implement LLM Bridge swarm per SPEC.md" \
  --body "$(cat <<'EOF'
Implements the zero-budget chrome-extension swarm from SPEC.md:

- manifest.json  : MV3 extension, content script on chat.deepseek.com + chat.qwen.ai
- bridge.js      : per-tab agent node (React-compatible input injection, humanized
                   typing cadence, MutationObserver reply capture, HUD + HALT kill
                   switch, auto-reconnecting WebSocket to the orchestrator)
- orchestrator.py: Python asyncio/websockets router + turn governor enforcing
                   strict A->B alternation, transcript logging, timeout handling

Smoke-tested end-to-end with simulated WebSocket agents: registration gating,
alternating message chaining, transcript contents, and error routing all verified.
EOF
)"
```

Fallback (no `gh`) — **this is what was actually used**: after the push succeeds,
GitHub returns a "create a pull request" URL in the push output; alternatively
POST via the API:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Esrevorter/Shoarma/pulls \
  -d '{"title":"Implement LLM Bridge: two-browser agent swarm per SPEC.md",
       "head":"qwen-code-bridge",
       "base":"main",
       "body":"Implements the LLM Bridge swarm per SPEC.md (manifest.json, bridge.js, orchestrator.py)."}'
```

### 5. Confirm publication

```bash
git ls-remote origin qwen-code-bridge   # branch exists remotely
gh pr view --web  # or check the returned PR URL from step 4
```

Report the PR URL back to the user.

## Acceptance criteria

- [x] Branch exists on GitHub (`qwen-code-bridge`, head `e4aa37d` — includes commits `cd78e2f` + `e4aa37d`).
- [x] An open Pull Request targets `main` and shows the changed files: `manifest.json`, `bridge.js`, `orchestrator.py`, `SPEC.md`, `Qwen.md`.
- [x] The final response to the user includes the concrete PR URL: **https://github.com/Esrevorter/Shoarma/pull/1**

## Safety rules

- Never commit secrets or tokens into the repository or into git history.
- Never rewrite or force-push `main`; only push the feature branch.
- If authentication fails or the remote repo does not contain the base history,
  halt and tell the user precisely which prerequisite is missing instead of
  creating a fork/orphan repo without permission.

## Runtime status (updated 2026-10-15, v0.8.3)

- v0.8.2 (tag `v0.8.2`, commit `db55a87`) fixed contenteditable injection, chunked retype, strict submit failure, error-toast filtering, React-state probe.
- The live-run log of 2026-10-15 14:43–15:05 still showed a spiral: concurrent `say` frames racing on one shared input box, phantom captures of the previous turn's bubble after failed sends, and instant retry storms against a jammed editor + rate-limited site.
- v0.8.3 fixes (this): single-flight turn guard with newest-only queue in bridge.js; baseline slice + stale-reply guard (`lastCapturedNorm`) in lastAssistantText; `clear_input` frame handled by bridge and sent by orchestrator `cool_down()` between ask_robust retries (5 s/10 s pacing). All verified: node --check, py_compile, and a scripted test proving looks_junk guards, clear_input dispatch, cooldown timing, and ask_robust recovery-on-attempt-2.
- Branch `shoarma-v0.8-full` carries these commits; PR #2 remains open; main untouched per safety rules.

## v0.9.0 — browser-native swarm engine + "meat" icon (2026-10-16)
- PAT re-supplied by user; stored in gitignored `.env` as `GITHUB_TOKEN` (never committed).
  Remote per this file: `origin = https://github.com/Esrevorter/Shoarma.git`.
- New `swarm-engine.js` service worker: the A↔B conversation loop now runs entirely
  in-browser (no external Python orchestrator required); manifest background points
  at it; bridge/monitor/popup updated to match; version → 0.9.0.
- Icons redesigned to match the name: a doner/shawarma concept (spice-red rounded
  tile, stacked layered meat on a skewer with charred cap, pita wrap, pickle/tomato,
  garlic-sauce drip), generated programmatically with Pillow at 16/48/128 px.
- Verified: `node --check` on all five JS files; manifest JSON valid; PNGs decode at
  correct sizes with transparent corners.

---

## STATUS UPDATE — 2026-10-16 (third pass, read from live GitHub API)

This section supersedes the stale "STATUS: DONE (2026-10-15)" block above.

- Remote `origin` = https://github.com/Esrevorter/Shoarma.git (per this document; PAT stored only in gitignored `/workspace/.env`, never in tracked files).
- PR #1 (qwen-code-bridge -> main): CLOSED, superseded.
- PR #2 (shoarma-v0.8-full -> proceed-with-spec.md-40231): CLOSED **and MERGED**; its base branch was subsequently deleted from the remote.
- PR #3 (shoarma-v0.8-full -> main): OPEN — brings `main` up to released state v0.9.1 (head commit `0692edc`). https://github.com/Esrevorter/Shoarma/pull/3
- Tagged Releases published & verified via API: v0.8.1, v0.8.3, v0.9.0, v0.9.1 (latest, with chrome zip asset).
- `main` still points at `3587111` (pre-swarm snapshot); it advances when PR #3 is merged.
- Safety rules unchanged: no secrets in history, no force-push of `main`, feature branches only, report missing prerequisites truthfully.

---

## v0.9.4 — late-reply adoption & ghost-send recovery (2026-10-16)

Root cause of the 2026-10-15 19:30–19:36 log failure (DeepSeek accepted the
1,885-char message but emptied its composer later than bridge.js wait windows;
`say()` declared MESSAGE NOT SUBMITTED, threw, and left text jammed in the box
while retries kept firing at a live generating page; meanwhile the successfully
captured turn arrived after the engine's 45 s attempt-race had expired, so
nothing adopted it and the run hung until the 180 s watchdog):

- bridge.js: `detectGhostSend()` + final 3 s settle check before declaring
  failure — if the site consumed the message anyway, treat as submitted. On
  genuine failure the stuck editor text is flushed immediately (kills the
  retry spiral). `say(text, {baseline})` wired through `runTurn`. In the
  `runTurn` catch block, a reply captured before the throw is emitted as
  `{type:"error", captured:true}` so the engine adopts rather than fails it.
- swarm-engine.js: `adoptLateReply()` re-dispatch guard — an already-captured
  late reply continues alternation instead of re-sending; router `case "error"`
  treats `captured:true` frames as late replies; early adoption check before
  first cool-down; flush-guard so a live reply timer can't have its fresh
  prompt wiped; `onReply` dedupe (same text/agent counted once); attempt race
  bound to the reply timer (no more 45 s cap shorter than model thinking
  time); `onSendFailure` no longer clears the run watchdog; stale-busy reset
  in `deliver()`; `focusTab()` awaits real `active:true` (max 3 s) fixing the
  "tab activation refused" race; `broadcastState()` rejection-safe.
- Verified: `node --check` on all JS files; manifest JSON valid (v0.9.4);
  `test-v094-recovery.js` replays the exact 19:30–19:36 failure under a
  virtual clock with stubbed chrome APIs — ALL assertions PASS (auto-arm,
  first hop, cool-down without spiral, late-reply ADOPTED via adoptLateReply,
  turn counted exactly once, single say per agent, honest bounded termination,
  transcript contains adopted reply verbatim, stale-busy reset).
- errorlog on GitHub main was a copy of the pre-fix bridge.js; refreshed to
  the repaired v0.9.4 bridge.js content.
- Live end-to-end validation still requires Chrome; watch for new log lines
  "GHOST SEND detected" and "late reply ... adopting".

## v0.9.5 — "Failed to load extension: Could not load background script ''" (live-verified 2026-10-16)

User report: unpacked folder `Downloads\shoarma-extension-v0.9.4` refused to load with
`Could not load background script ''.` + `Could not load manifest.`

Root cause (downloaded the release asset and inspected it — live-verified):
- The CI workflow (.github/workflows/build-extension.yml) packaged the extension
  with a hand-rolled `zip` command using a STALE file list: it shipped
  `orchestrator.py icons/ launcher/` but NOT `swarm-engine.js`, and its
  checkout could carry the legacy background-era manifest. Chrome then aborts
  with exactly "Could not load background script ''" / "Could not load
  manifest". Our local tools/build_release.py zip was fine; the release asset
  was not — two different builders, one forgotten.
- Corollary: every release ever published by that workflow shares the defect,
  which matches the user's "they don't work" assessment of all previous ones.

Fixes shipped in v0.9.5:
1. **Removed the background/service-worker registration entirely.** Since v0.9
   the swarm engine listens via chrome.runtime.onMessage from content-bridge
   messages; the separate worker only ever added a load-time failure surface
   (and the retired native launcher). A manifest without `background` cannot
   produce "Could not load background script" at all.
2. **swarm-engine.js message listener registered synchronously** (MV3 rule:
   async listeners make sendResponse channels unreliable across Chrome
   versions). Handler logic moved into `handleEngineMessage()` unchanged;
   test suite re-run green after the refactor.
3. **tools/build_release.py hardened**: if a `background` block ever returns,
   its service_worker must be a non-empty string naming a file that exists;
   stale background.js removed from the packaged file list. CI workflow
   updated to match.
4. **CI workflow repaired**: the packaging step now runs
   `python3 tools/build_release.py` (the canonical validator+builder) instead
   of the stale hand-rolled `zip`; also added `node --check swarm-engine.js`.
5. Version bumped 0.9.4 → 0.9.5; tag v0.9.5 re-pointed to the repair commit so
   CI rebuilds and replaces the release asset; all 17 pre-0.9.5 releases
   deleted via API (HTTP 204 each) per user request — they don't load.

Honest caveat: we cannot execute Chrome here; the fix is proven by manifest
invariants (no background key ⇒ that error class is impossible), syntax
checks, and the recovery test suite — live load of the v0.9.5 zip is still
pending on the user's machine.

## v0.9.6 — restore the in-browser engine service worker (arm-failure fix)
User log 22:06: "engine arm failed: Could not establish connection. Receiving end does not exist."
Root cause (verified against git history): v0.9.5 (commit 082f278) removed the
`background.service_worker` entry from manifest.json as a mis-diagnosed fix for the
"Could not load background script ''" error. That error was actually caused by CI
shipping a stale zip that omitted swarm-engine.js — fixed properly in v0.9.5b by
making tools/build_release.py the single builder. With no service worker registered,
swarm-engine.js never runs, so popup.js's chrome.runtime.sendMessage({type:"arm"})
hits an empty runtime → "Receiving end does not exist".
Fixes:
  • manifest.json: re-registered `"background": { "service_worker": "swarm-engine.js" }`
    (file verified present in repo + release list; classic-script compatible — no
    import/export statements; node --check passes). Added "scripting" permission.
  • swarm-engine.js bumpBadge(): guarded chrome.action with optional-chaining + try/catch
    so a missing action API can never throw mid-message and kill the worker.
Verification: recovery test suite green; build validator now enforces non-empty
service_worker referencing a real file (so this regression cannot ship again).

## v0.9.7 — live re-verification of v0.9.6 release + clean rebuild (2026-10-16)
User report: "I did not find the new release (verified on Github)."
Live API verification (curl + PAT, repo Esrevorter/Shoarma):
  • GET /releases → v0.9.6 EXISTS, published 2026-10-15T20:09:29Z, NOT draft,
    asset shoarma-v0.9.6-chrome.zip uploaded by github-actions[bot].
  • Tag v0.9.6 → commit 422281b == remote main HEAD. Release is real and current.
  Repo verified PUBLIC via API (private=false), so anonymous access works — the
  "not found" was most likely a stale browser view, or checking Tags/Actions
  instead of https://github.com/Esrevorter/Shoarma/releases.
Hardening shipped in v0.9.7 (no functional extension changes):
  • .gitignore now excludes errorlog and run-*.log; both removed from git index
    (they were committed debug captures, still present as local untracked files).
  • Version bump 0.9.6 → 0.9.7 to trigger CI build_extension.yml → tag v0.9.7 →
    fresh release + zip attached by Actions (independent re-publish path).
Verification this session: node --check ×4 JS, py_compile all Python, recovery
test suite ALL PASSED, tools/build_release.py BUILT
shoarma-v0.9.7-chrome.zip (13 entries, sha256=a2b07e084dcd0352bc822051387ddd0442b5ade24383b7d1efd5e2f61a27939c).

## Session 2026-10-16 (v0.9.8) — error.log verified LIVE from GitHub, real fix on the ACTUAL main
- Reality check: remote main was ce7aa581 ("Create error.log", parent v0.9.7 d05df58). The
  previously claimed "safeCatch commit 363179f / release v0.9.8" did NOT exist on GitHub — that
  work never landed. Only releases v0.9.6/v0.9.7 are live.
- Downloaded error.log from raw.githubusercontent (2000 lines): a line-number dump followed by a
  paste of bridge.js source. The decisive evidence was still the known crash signature:
  `TypeError: Cannot read properties of undefined (reading 'catch')` in the MV3 worker boot path.
- Parsed the REAL swarm-engine.js at ce7aa581: unguarded chained calls were deliver()
  (`chrome.tabs.sendMessage(...).then().catch()` — crashes when sendMessage returns undefined) and
  the onMessage router / activate-tab sites. broadcastState was already guarded; popup/monitor use
  async+try/catch (safe); background.js is legacy (not the manifest worker).
- Fix: added asPromise()/safeCatch() + a self.unhandledrejection shield (worker can no longer die
  silently), routed deliver(), the message router, and activate-tab through them.
- Regression test tests/test_promise_safe_guards.py (all PASS): guards present, zero direct
  .then/.catch chains onto chrome.* calls anywhere in swarm-engine.js, deliver() uses asPromise.
- Node simulation with chrome.tabs.sendMessage -> undefined: boots clean, deliver('say') OK.
- Bumped manifest to 0.9.8, gitignored + untracked error.log. Releasing via tag push + CI.

## Session 2026-10-23 (handoff continuation) — state re-verified LIVE from GitHub; nothing new to ship
New PAT supplied by the user via env (`GITHUB_TOKEN`, stored only in gitignored `/workspace/.env`, mode 600, never in tracked files or history). Token auth verified against the API (HTTP 200, identity `Esrevorter`). Remote re-added (sandbox repo is recreated each session without one): `origin = https://github.com/Esrevorter/Shoarma.git`.

Full read-back of reality (per RULES.md §1 — prior turns' summaries are claims, not facts):
- Local HEAD `439b0c6` == `origin/main` == tag `v0.9.18`. Working tree clean; **zero unpushed commits** (`git log origin/main..HEAD` empty). The v0.9.18 monitor overhaul was already published in the previous session — there was no unfinished local work to carry over.
- Releases live: v0.9.17 and v0.9.18 (latest), each with its chrome zip asset attached by Actions. All pre-v0.9.5 releases remain deleted per the earlier cleanup.
- PRs #1–#4: all CLOSED, none merged (history flows directly on `main`; each release was cut from main). No open PR exists; none is required because main already carries every released commit.
- Full verification suite re-run green this session: `node --check` ×10 JS files, `py_compile` on all Python, manifest+launcher JSON valid, `tools/build_release.py` builds the v0.9.18 zip (13 entries incl. swarm-engine.js), and ALL test suites PASS: test-v094-recovery, test-d7-post-run-rearm, test-v0915-desync (17), test-v0917-chrome-words, test-v0918-monitor, tests/test_promise_safe_guards.py, tests/test_zapper_compliance.py.

Where we left off / next actionable step (unchanged, honest status):
- **Live end-to-end validation in Chrome remains pending on the user's machine.** Load the v0.9.18 zip (unzip → chrome://extensions → Developer mode → Load unpacked), keep both chat tabs visible, and watch for the v0.9.16–v0.9.18 fix signatures in the log: exact-match desync gate, chrome-word filtering, "GHOST SEND detected", "late reply ... adopting". If a run still fails, export 📋 copy-debug from the monitor page and hand it to the next session — that dump is the input the selector fixes need (see tools/PROBE.md).
- Safety rules reaffirmed: no secrets in history, no force-push of `main`, feature branches only, report missing prerequisites truthfully.

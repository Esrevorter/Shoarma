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

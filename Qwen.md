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

## STATUS: ✅ DONE (2026-10-15)

The publish described below has been executed successfully:
- Remote added: `origin = https://github.com/Esrevorter/Shoarma.git`
- Branch pushed: local `qwen-code-19c79563-...` → remote branch **`qwen-code-bridge`** (head `e4aa37d`)
- Pull Request opened against `main`: **https://github.com/Esrevorter/Shoarma/pull/1**
  ("Implement LLM Bridge: two-browser agent swarm per SPEC.md", state: open,
  verified via API — 5 changed files, +676 lines)

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

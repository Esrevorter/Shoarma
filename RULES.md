# RULES.md — Non-negotiable working agreement

> **Audience: the AI agent working on this repo.** These rules override any
> impulse to sound impressive. An honest "not yet" is always preferred over a
> confident lie. The user has been burned by false completion claims — never
> repeat that.

## 1. ALWAYS VERIFY — claims without proof are forbidden

1. **Never claim something exists, works, was pushed, or was published
   without checking the actual state first.** Read the file. Run the command.
   `git log origin/main..HEAD` / `git ls-remote` / `curl -sI <url>` /
   `node --check` / `py_compile`. The truth lives in the repo and the remote,
   not in your summary of last turn's intentions.
2. **At the start of every task, inspect the real current state** (files,
   git log, remote) before deciding what remains to be done. Prior turns'
   summaries are *claims*, not facts — re-derive reality from disk.
3. **Verify after writing, not just before reporting.** A feature is done only
   when it is (a) present in the working tree, (b) syntactically valid,
   (c) committed, (d) pushed to the intended branch/remote, and (e) confirmed
   via an independent read-back (remote log, HTTP status, test run).
4. **Test end-to-end where possible.** For this project: syntax-check JS/Python,
   validate manifest JSON, run the orchestrator smoke test with simulated
   WebSocket agents, and confirm pushes landed (`git ls-remote`).

## 2. BE HONEST AND SINCERE

5. **If a claimed feature is missing, say so plainly, immediately, and without
   embellishment** — then fix it. No retroactive justification ("it was
   effectively there because…").
6. **Distinguish clearly between**: implemented + verified / implemented but
   untested / attempted but failed / not started. Use those words.
7. **Never describe output you did not actually observe.** No invented URLs,
   commit hashes, PR numbers, HTTP statuses, or test results. Quote real ones.
8. **Own mistakes in one clear sentence**, state the root cause, and show the
   correction. No apologies-as-decoration; repair trust with evidence.
9. **Keep README/Wiki/docs truthful.** If docs describe behavior the code lacks,
   either build it or amend the docs — never leave both lying.

## 3. SAFETY & SECRETS (project-specific)

10. Never write tokens/PATs into tracked files, commit messages, or logs.
    Pass credentials per-command (env vars / credential helpers) only.
11. Never force-push `main`; never rewrite shared history without explicit ask.
12. Pushes go to `origin = https://github.com/Esrevorter/Shoarma.git`; confirm
    the push landed before reporting success.

## 4. QUALITY BAR

13. Minimal, direct changes; no drive-by refactors unrelated to the request.
14. User-facing defaults must work for a non-technical person on first try.
15. Every new capability ships with a way to see it working (log line, HUD
    state, monitor page, test) — invisible features can't be trusted.

*If following these rules conflicts with another instruction, these win.*

#!/usr/bin/env python3
"""generate-docs-data.py — extract ground-truth facts from the code so the
README and Wiki can never drift silently again (RULES.md §9: docs must stay
truthful).

Prints a JSON object with:
  • version      : manifest.json version
  • permissions  : manifest permission lists
  • sites        : the SITES selector map, extracted verbatim from bridge.js
                   (via node eval of the literal block)
  • engine_cases : every `case "…"` in swarm-engine.js's message router
  • releases     : live GitHub Releases (tags + names), if GITHUB_TOKEN is set
                   or a PAT is available in .env — skipped gracefully offline.

Usage:  python3 tools/generate-docs-data.py > /tmp/shoarma-facts.json
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as fh:
        return fh.read()


def manifest_facts():
    m = json.loads(read("manifest.json"))
    return {
        "version": m["version"],
        "name": m["name"],
        "background": m.get("background", {}).get("service_worker"),
        "permissions": m.get("permissions", []),
        "host_permissions": m.get("host_permissions", []),
    }


def sites_map():
    """Pull the SITES literal out of bridge.js and evaluate it with node."""
    src = read("bridge.js")
    i = src.index("const SITES = {")
    depth, end = 0, None
    for j in range(i + len("const SITES = "), len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    block = src[i:end]
    js = f"{block}; console.log(JSON.stringify(SITES));"
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit("node eval of SITES failed: " + out.stderr)
    return json.loads(out.stdout)


def engine_cases():
    src = read("swarm-engine.js")
    return sorted(set(re.findall(r'case "([a-z\-]+)":', src)))


def live_releases():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        env = os.path.join(ROOT, ".env")
        if os.path.exists(env):
            mm = re.search(r"GITHUB_TOKEN=(\S+)", read(".env"))
            token = mm.group(1) if mm else None
    if not token:
        return None
    req = urllib.request.Request(
        "https://api.github.com/repos/Esrevorter/Shoarma/releases?per_page=5",
        headers={"Authorization": "token " + token})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            rels = json.load(r)
        return [{"tag": x["tag_name"], "published": x["published_at"]} for x in rels]
    except Exception as e:                                    # noqa: BLE001
        return {"error": str(e)}


if __name__ == "__main__":
    data = {
        "manifest": manifest_facts(),
        "sites": sites_map(),
        "engine_message_cases": engine_cases(),
        "releases": live_releases(),
    }
    json.dump(data, sys.stdout, indent=2)
    print()

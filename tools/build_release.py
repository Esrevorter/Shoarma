#!/usr/bin/env python3
"""Build a complete, loadable Shoarma Chrome-extension zip from the repo.

Refuses to ship unless:
  * manifest.json parses and background.service_worker is a non-empty string
  * every path referenced by the manifest exists in the repo
  * no junk files (.DS_Store, __pycache__, logs) end up in the archive

Usage: python3 tools/build_release.py            # builds for manifest version
       python3 tools/build_release.py --check    # validate only, no zip
"""
import json
import os
import re
import sys
import hashlib
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files that make up the unpacked extension (manifest-referenced + support).
EXTENSION_FILES = [
    "manifest.json",
    "swarm-engine.js",
    "background.js",
    "bridge.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "hud.css",
    "monitor.html",
    "monitor.css",
    "monitor.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

JUNK = re.compile(r"(\.DS_Store|__pycache__|\.log$|^Qwen\.md$|\.env$)")


def referenced_paths(manifest):
    yield manifest["background"]["service_worker"]
    yield manifest["action"]["default_popup"]
    for cs in manifest.get("content_scripts", []):
        yield from cs.get("js", [])
        yield from cs.get("css", [])
    for size, path in manifest.get("icons", {}).items():
        yield path
    for entry in manifest.get("web_accessible_resources", []):
        if isinstance(entry, dict):
            yield from entry.get("resources", [])
        else:
            yield entry


def validate():
    mpath = os.path.join(REPO, "manifest.json")
    with open(mpath, encoding="utf-8") as f:
        m = json.load(f)

    sw = m.get("background", {}).get("service_worker", "")
    assert isinstance(sw, str) and sw.strip(), \
        "FATAL: background.service_worker is empty — Chrome would abort with \"Could not load background script ''\""

    missing = sorted({p for p in referenced_paths(m) if not os.path.exists(os.path.join(REPO, p))})
    assert not missing, f"FATAL: manifest references missing files: {missing}"

    extra = sorted({p for p in EXTENSION_FILES if os.path.exists(os.path.join(REPO, p))})
    version = m["version"]
    print(f"manifest OK — version {version}, service_worker '{sw}', "
          f"{len(list(referenced_paths(m)))} referenced paths all present")
    return version, sorted(set(EXTENSION_FILES) | set(extra))


def main():
    check_only = "--check" in sys.argv
    version, files = validate()
    if check_only:
        return

    out_dir = os.path.join(REPO, "dist")
    os.makedirs(out_dir, exist_ok=True)
    zip_name = f"shoarma-v{version}-chrome.zip"
    zip_path = os.path.join(out_dir, zip_name)

    junk_in_list = [f for f in files if JUNK.search(f)]
    assert not junk_in_list, f"FATAL: junk files scheduled for zip: {junk_in_list}"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            full = os.path.join(REPO, rel)
            if os.path.isfile(full):
                z.write(full, rel)

    digest = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
    sha_path = zip_path + ".sha256"
    with open(sha_path, "w") as f:
        f.write(f"{digest}  {zip_name}\n")

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    assert "manifest.json" in names and "swarm-engine.js" in names
    print(f"BUILT {zip_name}: {len(names)} entries, sha256={digest}")
    print("\n".join(names))


if __name__ == "__main__":
    main()

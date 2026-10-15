#!/usr/bin/env python3
"""Pull your popup settings out of Chrome's extension storage → settings.json.

The popup saves to chrome.storage.sync, which lands in the LevelDB under
.../Local Extension Settings/<id>. This scans it read-only and extracts the
values Chrome writes (format: <json-len>:<json>), so `python orchestrator.py`
can use the SAME topic/turns/port you set in the UI.

Usage:  python scripts/sync-settings.py [extension-id]
        (or SHOARMA_EXT_ID env var; find the id at chrome://extensions)
"""
import glob, json, os, re, sys
from pathlib import Path

WANTED = ("topic", "turns", "timeout", "port", "halted")
# chrome.storage.sync values are written as "<len>:<json>" inside leveldb files
PAT = re.compile(rb"(\d+):(\{[^{}]*\}|\[[^\[\]]*\]|\"(?:[^\"\\]|\\.)*\"|[0-9]+|true|false)")


def leveldb_dir(ext_id):
    home = Path.home()
    bases = [
        home / "Library/Application Support/Google/Chrome",   # macOS
        home / ".config/google-chrome",                        # Linux
        home / "AppData/Local/Google/Chrome/User Data",        # Windows
    ]
    for b in bases:
        for prof in ["Default", *sorted(glob.glob(str(b / "Profile *")))]:
            d = b / prof / "Local Extension Settings" / ext_id
            if d.is_dir():
                return d
    sys.exit(f"no chrome profile data found for extension {ext_id!r}")


def main():
    ext_id = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SHOARMA_EXT_ID")
    if not ext_id:
        sys.exit(__doc__ + "\nERROR: pass the extension id (see chrome://extensions)")
    src = leveldb_dir(ext_id)

    # collect candidate keys/values with a little surrounding context
    blob = b"".join(f.read_bytes() for f in sorted(src.glob("*.log")) + sorted(src.glob("*.sst")))
    out = {}
    for want in WANTED:
        # look for "...<key><meta bytes><len>:<value>" — take the LAST occurrence
        idx = blob.rfind(want.encode())
        if idx == -1:
            continue
        m = PAT.search(blob, idx, idx + len(want) + 400)
        if not m:
            continue
        try:
            out[want] = json.loads(m.group(2).decode("utf-8", "ignore"))
        except Exception:
            pass
    if not out:
        sys.exit("no saved settings found — open the Shoarma popup once and change any field.")
    Path("settings.json").write_text(json.dumps(out, indent=2))
    print(f"wrote settings.json ← {src}\n{json.dumps(out)}")


if __name__ == "__main__":
    main()

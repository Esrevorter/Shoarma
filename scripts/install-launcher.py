#!/usr/bin/env python3
"""One-time registration of the native-messaging launcher.

Usage:  python scripts/install-launcher.py <chrome-extension-id>
Get the id from chrome://extensions after loading Shoarma unpacked.
Writes the manifest into Chrome's NativeMessagingHosts directory and points
"path" at this repo's launcher.py (absolute). Safe to re-run.
"""
import json, sys
from pathlib import Path

if len(sys.argv) != 2:
    sys.exit(__doc__)

ext_id = sys.argv[1].strip()
repo = Path(__file__).resolve().parent.parent
launcher = repo / "launcher.py"
tmpl = json.loads((repo / "launcher" / "shoarma.launcher.json").read_text())
tmpl["path"] = str(launcher)
tmpl["allowed_origins"] = [f"chrome-extension://{ext_id}/"]

home = Path.home()
plat = sys.platform
dest = {
    "darwin": home / "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "linux":  home / ".config/google-chrome/NativeMessagingHosts",
}.get(plat, None)
if dest is None and plat.startswith("win"):
    dest = Path.home() / "AppData/Local/Google/Chrome/User Data/NativeMessagingHosts"
if dest is None:
    sys.exit(f"unsupported platform: {plat}")

dest.mkdir(parents=True, exist_ok=True)
out = dest / "com.shoarma.launcher.json"
out.write_text(json.dumps(tmpl, indent=2))
launcher.chmod(0o755)
print(f"registered → {out}\npath        → {launcher}\nNow click 🚀 Launch swarm in the popup.")

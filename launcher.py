#!/usr/bin/env python3
"""launcher.py — native messaging host for the Shoarma popup.

The extension sends {"turns":..,"timeout":..,"port":..,"topic":..} when you
click 🚀 Launch swarm; we spawn orchestrator.py with those exact settings,
in the background, logging to your Downloads folder. No terminal required.

Register once (see launcher/README.md or the popup's hint text):
  python scripts/install-launcher.py
"""
import json, os, struct, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent          # repo root (contains orchestrator.py)
ORCH = HERE / "orchestrator.py"


def read_message() -> dict:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        raise EOFError
    (ln,) = struct.unpack("=I", raw)
    return json.loads(sys.stdin.buffer.read(ln))


def write_message(obj: dict):
    data = json.dumps(obj).encode()
    out = struct.pack("=I", len(data)) + data
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()


def downloads_dir() -> Path:
    home = Path.home()
    dl = home / "Downloads" / "shoarma"
    return dl if dl.parent.is_dir() else Path(tempfile.gettempdir()) / "shoarma"


def main():
    try:
        cfg = read_message()
    except Exception as e:
        write_message({"ok": False, "error": f"bad request: {e}"}); return

    port = int(cfg.get("port", 8765))
    args = [sys.executable, str(ORCH),
            "--turns", str(int(cfg.get("turns", 6))),
            "--timeout", str(int(cfg.get("timeout", 180))),
            "--port", str(port)]
    topic = str(cfg.get("topic", "")).strip()
    if topic:
        args += ["--topic", topic]

    home = downloads_dir()
    home.mkdir(parents=True, exist_ok=True)
    logf = home / "launcher.log"

    try:
        # already running? don't double-bind the port
        probe = subprocess.run([sys.executable, "-c",
            f"import socket;s=socket.socket();raise SystemExit(0 if s.connect_ex(('127.0.0.1',{port}))==0 else 1)"],
            capture_output=True)
        if probe.returncode == 0:
            write_message({"ok": True, "pid": -1,
                           "note": f"port {port} already serving — reuse it or change the port."})
            return
        with open(logf, "ab") as lf:
            p = subprocess.Popen(args, cwd=str(HERE), stdout=lf, stderr=subprocess.STDOUT,
                                 env={**os.environ, "SHOARMA_HOME": str(home)},
                                 start_new_session=True)
        write_message({"ok": True, "pid": p.pid})
    except Exception as e:
        write_message({"ok": False, "error": repr(e)})


if __name__ == "__main__":
    main()

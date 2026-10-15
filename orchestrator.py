# orchestrator.py — router + turn governor for the LLM Bridge swarm.
# v0.4: in-process HTTP side-server on the SAME port serves GET /state to the
#       live monitor page (extension tab) — no terminal watching needed.
#       Agent debug frames are recorded into the event feed + run log.
# pip install websockets

import argparse, asyncio, json, logging, os, time
from pathlib import Path

AGENTS_EXPECTED = {"qwen", "deepseek"}

# Windows terminals default to cp1252 and crash on emoji like 📟 — force UTF-8
# output where possible, degrade gracefully where they don't allow it.
try:
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
HOST = "127.0.0.1"

# built-in fallbacks; overridden by ./settings.json if present
DEFAULTS = {"turns": 6, "timeout": 180, "port": 8765, "topic": ""}
OPENING = ("Let's debate: is local-first AI more important than cloud AI? "
           "Take a firm position and argue it in under 120 words. Qwen, you open.")


def load_settings() -> dict:
    s = dict(DEFAULTS)
    try:
        user = json.loads(Path("settings.json").read_text())
        s.update({k: v for k, v in user.items() if k in s})
        print(f"[settings] loaded settings.json → port={s['port']} turns={s['turns']}", flush=True)
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[settings] ignoring bad settings.json: {e!r}", flush=True)
    return s


def emit(line: str, hub=None):
    # Windows cp1252 consoles crash on emoji (📟 etc.) — strip to ASCII for the
    # terminal only; the monitor feed and log files keep the original text.
    try:
        printable = line.encode("ascii", "ignore").decode()
    except Exception:
        printable = line
    print(printable or line, flush=True)   # flushed so `tee`/launcher pipes stay live
    if hub is not None:
        hub.add({"type": "sys", "text": line})


class Hub:
    """Ring buffer of events + per-agent state, exposed to the monitor page."""
    def __init__(self, max_events=500):
        self.events: list[dict] = []
        self.agents: dict[str, dict] = {}
        self.seq = 0
        self.max = max_events

    def add(self, ev: dict) -> int:
        self.seq += 1
        ev = {"seq": self.seq, "ts": time.strftime("%H:%M:%S"), **ev}
        self.events.append(ev)
        if len(self.events) > self.max:
            del self.events[: len(self.events) - self.max]
        return self.seq

    def agent(self, name: str, **kw):
        self.agents.setdefault(name, {"state": "?", "turns": 0}).update(kw)

    def snapshot(self) -> bytes:
        return json.dumps({"agents": self.agents, "events": self.events,
                           "seq": self.seq}).encode()


async def http_side_server(hub: Hub, path: Path):
    """Minimal HTTP/1.0 on a separate local port → GET /state (monitor poll)."""
    async def handle(reader, writer):
        try:
            req = await asyncio.wait_for(reader.readline(), 5)
            while True:                                   # drain headers
                line = await asyncio.wait_for(reader.readline(), 5)
                if line in (b"\r\n", b"\n", b""): break
            body = hub.snapshot()
            writer.write(
                b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n"
                b"Access-Control-Allow-Origin: *\r\nConnection: close\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        except Exception:
            try: writer.write(b"HTTP/1.0 404 Not Found\r\nConnection: close\r\n\r\n")
            except Exception: pass
        try:
            await writer.drain(); writer.close()
        except Exception: pass
    srv = await asyncio.start_server(handle, HOST, 0)     # ephemeral OS port
    port = srv.sockets[0].getsockname()[1]
    write_utf8(path.parent / "monitor-port.txt", str(port))
    return srv, port


def write_utf8(path: Path, text: str):
    """Windows' default cp1252 encoding chokes on emoji (🔄 etc.) — always
    write our own files as UTF-8 explicitly, and never let a failed write
    kill a finished run."""
    try:
        path.write_text(text, encoding="utf-8")
    except Exception as e:
        print(f"[warn] could not write {path.name}: {e!r}", flush=True)


def log_turn(entry: dict, transcript: list, path: Path):
    transcript.append(entry)
    # stream as we go so a crash mid-run still leaves usable data
    write_utf8(path, json.dumps(transcript, indent=2, ensure_ascii=False))


async def handler(ws, agents: dict, pending: dict, hub: Hub):
    name = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "register":
                name = msg["agent"]
                agents[name] = ws
                hub.agent(name, state="ready")
                emit(f"[+] node online: {name}", hub)
            elif msg["type"] == "log":                     # agent debug frame
                hub.add({"type": "log", "agent": msg.get("agent", name),
                         "level": msg.get("level", "INFO"), "msg": str(msg.get("msg", ""))[:300],
                         "data": msg.get("data"), "ts": time.strftime("%H:%M:%S")})
                if msg.get("level") in ("INFO", "WARN", "ERROR"):
                    emit(f"    [{name}] {msg.get('level')}: {str(msg.get('msg',''))[:120]}", hub)
            elif msg["type"] == "state":                   # HUD → monitor mirror
                hub.agent(name or msg.get("agent", "?"), state=msg.get("state"), turns=msg.get("turns", 0))
            elif msg["type"] in ("reply", "error"):
                tag = "ERR " if msg["type"] == "error" else ""
                hub.agent(name, state="idle", turns=hub.agents.get(name, {}).get("turns", 0) + 1)
                fut = pending.pop(name, None)
                if fut and not fut.done():
                    fut.set_result(f"{tag}{msg.get('text','')}")
    finally:
        if name:
            agents.pop(name, None)
            hub.agent(name, state="offline")
            fut = pending.pop(name, None)
            if fut and not fut.done():
                fut.set_exception(ConnectionError(f"{name} disconnected"))
            emit(f"[-] node offline: {name}", hub)


async def ask(agents: dict, pending: dict, hub: Hub, agent: str, text: str, timeout: int) -> str:
    fut = asyncio.get_running_loop().create_future()
    pending[agent] = fut
    hub.agent(agent, state="writing")
    await agents[agent].send(json.dumps({"type": "say", "text": text}))
    return await asyncio.wait_for(fut, timeout)


async def main():
    s = load_settings()
    ap = argparse.ArgumentParser(description="LLM Bridge orchestrator")
    ap.add_argument("--turns", type=int, default=s["turns"], help="debate rounds")
    ap.add_argument("--timeout", type=int, default=s["timeout"], help="per-reply timeout seconds")
    ap.add_argument("--topic", default=None, help="custom opening prompt")
    ap.add_argument("--port", type=int, default=s["port"])
    args = ap.parse_args()

    opening = args.topic or s["topic"] or OPENING
    order = ("qwen", "deepseek")
    agents: dict[str, object] = {}
    pending: dict[str, asyncio.Future] = {}
    transcript: list[dict] = []
    hub = Hub()

    run_dir = Path(os.environ.get("SHOARMA_HOME", "."))
    run_dir.mkdir(parents=True, exist_ok=True)
    tstamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = run_dir / f"transcript-{tstamp}.json"
    log_path = run_dir / f"run-{tstamp}.log"
    debug_path = run_dir / f"debug-{tstamp}.log"

    ws_log_handler = logging.FileHandler(debug_path, encoding="utf-8")
    ws_log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger("websockets").addHandler(ws_log_handler)

    side_srv, http_port = await http_side_server(hub, log_path)
    try:                                   # also publish the WS port so the
        write_utf8(run_dir / "ws-port.txt", str(args.port))  # extension can find us on custom ports
    except Exception:
        pass
    try:                                   # fallback location the monitor probes
        Path("/tmp/shoarma").mkdir(exist_ok=True)
        write_utf8(Path("/tmp/shoarma/monitor-port.txt"), str(http_port))
        write_utf8(Path("/tmp/shoarma/ws-port.txt"), str(args.port))
    except OSError:
        pass
    async with __import__("websockets").serve(
            lambda ws: handler(ws, agents, pending, hub), HOST, args.port):
        emit(f"ws://{HOST}:{args.port} — open both tabs, waiting for {sorted(AGENTS_EXPECTED)}", hub)
        emit(f"live monitor feed: http://127.0.0.1:{http_port}/state  (open the Shoarma Monitor tab)", hub)
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.3)          # snappier readiness detection
        emit("both agents online. starting.\n", hub)

        msg = opening
        aborted = False
        for turn in range(1, args.turns + 1):
            try:
                # Sequential debate chain: B must see A's fresh argument to
                # rebut it, so hops stay ordered — but each hop starts the
                # instant the previous reply lands (no polling gaps).
                a, b = order if turn % 2 else order[::-1]
                t0 = time.monotonic()
                ra = await ask(agents, pending, hub, a, msg, args.timeout)
                mid = time.monotonic() - t0
                log_turn({"turn": turn, "agent": a, "seconds": round(mid, 1), "text": ra},
                         transcript, out_path)
                hub.add({"type": "reply", "agent": a, "turn": turn,
                         "seconds": round(mid, 1), "text": ra})
                emit(f"<<< {a}: {ra[:400]}", hub)
                rb = await ask(agents, pending, hub, b, ra, args.timeout)
                tot = time.monotonic() - t0
                log_turn({"turn": turn, "agent": b, "seconds": round(tot - mid, 1), "text": rb},
                         transcript, out_path)
                hub.add({"type": "reply", "agent": b, "turn": turn,
                         "seconds": round(tot - mid, 1), "text": rb})
                emit(f"<<< {b}: {rb[:400]}", hub)
                emit(f"--- turn {turn} done in {tot:.1f}s ---\n", hub)
                msg = rb                      # last speaker's reply chains onward
            except (asyncio.TimeoutError, ConnectionError) as e:
                emit(f"!! aborting after partial transcript ({len(transcript)} turns): {e!r}", hub)
                aborted = True
                break

        if not aborted:
            emit(f"\nsaved {len(transcript)} turns → {out_path}", hub)
        else:
            emit(f"partial transcript saved → {out_path}", hub)
        write_utf8(log_path, "\n".join(t["text"] for t in transcript) or "(empty)")
        write_utf8(debug_path, "\n".join(
            f"{e['ts']} {e.get('level','SYS').upper():5} [{e.get('agent','orch')}] "
            f"{e.get('msg') or e.get('text','')}"
            + (f" :: {json.dumps(e['data'])[:300]}" if e.get("data") else "")
            for e in hub.events if e["type"] in ("log", "sys")))
        emit(f"(live feed stays up at http://127.0.0.1:{http_port}/state for 60s…)", hub)
        await asyncio.sleep(60)   # keep monitor readable briefly after the run
        side_srv.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        # e.g. agents disconnected when their tabs closed right at run end —
        # the transcript is already streamed to disk, so report and exit clean.
        print(f"[shoarma] run ended: {e!r}", flush=True)

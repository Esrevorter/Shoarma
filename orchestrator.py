# orchestrator.py — router + turn governor for the LLM Bridge swarm.
# v0.5.1: monitor discovery hardened — the WS port itself now answers plain
#       HTTP GET /state and /monitor-port.txt (websockets process_request),
#       so the monitor page can always find the feed even when file:// port
#       files are unreadable (Windows Chrome blocks local-file fetches).
#       Also: graceful stand-down if a second instance is launched, unified
#       centralized run.log, popup stepper/progress/activity-log assets kept.
# v0.6: THE RUN IS ARMED, NOT AUTOMATIC. Connecting two tabs no longer fires
#       the swarm — you press ▶ Start swarm (HUD pill or popup) and YOUR TOPIC
#       from the popup travels with that start frame (the old auto-start was
#       why the HUD question was silently ignored). The opening prompt is
#       wrapped so debaters never receive a bare "(no response captured)".
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
    """Ring buffer of events + per-agent state, exposed to the monitor page.
    Centralized log: every event is ALSO appended to run.log as it happens,
    so a single copy-pasteable file holds orchestrator + agent debug output."""
    def __init__(self, max_events=500, log_path: Path | None = None):
        self.events: list[dict] = []
        self.agents: dict[str, dict] = {}
        self.seq = 0
        self.max = max_events
        self.log_path = log_path

    def add(self, ev: dict) -> int:
        self.seq += 1
        ev = {"seq": self.seq, "ts": time.strftime("%H:%M:%S"), **ev}
        self.events.append(ev)
        if len(self.events) > self.max:
            del self.events[: len(self.events) - self.max]
        if self.log_path:
            try:
                line = (f"{ev['ts']} {ev.get('level','SYS').upper():5} "
                        f"[{ev.get('agent','orch')}] {ev.get('msg') or ev.get('text','')}")
                d = ev.get("data")
                if d:
                    line += f" :: {json.dumps(d, ensure_ascii=False)[:300]}"
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass                     # logging must never kill the run
        return self.seq

    def agent(self, name: str, **kw):
        self.agents.setdefault(name, {"state": "?", "turns": 0}).update(kw)

    # v0.6: every WS connection, so we can push swarm-state frames to all tabs
    sockets: set = None
    async def broadcast(self, obj: dict):
        if not self.sockets: return
        raw = json.dumps(obj)
        for w in list(self.sockets):
            try: await w.send(raw)
            except Exception: pass

    def snapshot(self, feed_port: int | None = None) -> bytes:
        return json.dumps({"agents": self.agents, "events": self.events,
                           "seq": self.seq, "feedPort": feed_port}).encode()


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


def make_process_request(hub_ref: dict):
    """v0.5.1 fix — the monitor page used to show 'offline · waiting for
    orchestrator' forever because it could only find the feed via file://
    port files, which Chrome blocks on Windows. Now the WS port itself
    answers plain HTTP: GET /state and GET /monitor-port.txt.

    websockets v13+ (asyncio impl) requires returning a Response object;
    older versions want a base64 raw-response string. We support both.
    Returning None lets the normal WebSocket handshake proceed for agents."""
    try:                                   # modern API (websockets >= 13)
        from websockets.http11 import Response
        from websockets.datastructures import Headers
    except ImportError:                    # pragma: no cover — old lib fallback
        Response = Headers = None

    def _body_bytes(status: str, body: bytes, ctype="application/json"):
        hdrs = ("HTTP/1.1 " + status,
                f"Date: {time.strftime('%a, %d %b %Y %H:%M:%S GMT')}",
                f"Content-Type: {ctype}",
                f"Content-Length: {len(body)}",
                "Access-Control-Allow-Origin: *",
                "Connection: close")
        return ("\r\n".join(hdrs) + "\r\n\r\n").encode() + body

    def _make_response(code: int, reason: str, body: bytes, ctype: str):
        if Response is not None:
            headers = Headers({
                "Content-Type": ctype,
                "Content-Length": str(len(body)),
                "Access-Control-Allow-Origin": "*",
                "Connection": "close",
            })
            return Response(code, reason, headers, body)
        import base64
        return base64.b64encode(_body_bytes(f"{code} {reason}", body, ctype)).decode()

    async def process_request(connection, request):
        p = getattr(request, "path", "") or ""
        if p.startswith("/state"):
            fp = hub_ref.get("feed_port")
            return _make_response(200, "OK",
                                  hub_ref["hub"].snapshot(feed_port=fp),
                                  "application/json")
        if p.startswith("/monitor-port.txt"):
            fp = hub_ref.get("feed_port")
            if fp:
                return _make_response(200, "OK", str(fp).encode(), "text/plain")
        return None          # everything else → normal WebSocket handshake
    return process_request


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


async def handler(ws, agents: dict, pending: dict, hub: Hub, control: dict):
    name = None
    hub.sockets.add(ws)
    try:
        await ws.send(json.dumps({"type": "swarm", "state": control["phase"]}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "register":
                name = msg["agent"]
                agents[name] = ws
                hub.agent(name, state="ready")
                emit(f"[+] node online: {name}", hub)
                # v0.6: a tab that reloads mid-run re-registers — hand it back
                # its turn slot so the debate can resume where it stopped.
                if control.get("running"):
                    await ws.send(json.dumps({"type": "resume"}))
            elif msg["type"] == "start":
                # v0.6: explicit human trigger (HUD ▶ / popup Start). The topic
                # rides THIS frame — that's why the popup question is honored
                # now instead of the built-in default being auto-fired.
                if not control["start_evt"].done():
                    control["topic"] = (msg.get("topic") or "").strip()
                    control["turns"] = msg.get("turns") or control.get("turns")
                    control["start_evt"].set_result(True)
                    emit(f"▶ start received from {name} — topic: "
                         f"{(control['topic'][:70] or '(default)')}", hub)
            elif msg["type"] == "stop":
                control["stop_flag"] = True
                emit(f"■ stop received from {name}", hub)
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
        hub.sockets.discard(ws)
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


def port_in_use(port: int) -> bool:
    """True if something already listens on 127.0.0.1:port (another swarm)."""
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex((HOST, port)) == 0
    finally:
        s.close()


# v0.6: a failed capture must NEVER be relayed to the other debater as if it
# were an argument — that's what made both AIs spiral into "paste your
# question again" confusion loops. The fallback keeps the conversation alive.
RETRY_NOTE = ("(Your previous message did not reach me — the bridge lost my "
              "reply. Please restate your last point briefly and continue the "
              "debate.)")

# v0.8: some placeholder junk slipped through the exact-match check (the agent
# literally RECEIVED "(no response captured)" as its prompt and then politely
# complained about it — see user log 10:47:58). Any reply that CONTAINS one of
# these strings is a failed capture, and if we can't recover it we substitute
# RETRY_NOTE so the other debater never sees bridge internals.
CAPTURE_JUNK = ("(no response captured)", "ERR ", "[Shoarma", "undefined",
                "Thinking completed")


def looks_junk(t):
    tl = t.lower()
    return (t.startswith("ERR") or len(t.strip()) < 3
            or any(j.lower() in tl for j in CAPTURE_JUNK))


async def ask_robust(agents, pending, hub, agent, text, timeout, retries=1):
    """ask() + capture validation. Returns (text, ok)."""
    for attempt in range(retries + 1):
        got = await ask(agents, pending, hub, agent, text, timeout)
        if not looks_junk(got):
            return got, True
        hub.add({"type": "log", "agent": agent, "level": "WARN",
                 "msg": f"capture failed (attempt {attempt + 1}) — retrying hop"})
        emit(f"[{agent}] capture failed, retrying this hop…", hub)
    return RETRY_NOTE, False


async def main():
    s = load_settings()
    ap = argparse.ArgumentParser(description="LLM Bridge orchestrator")
    ap.add_argument("--turns", type=int, default=s["turns"], help="debate rounds")
    ap.add_argument("--timeout", type=int, default=s["timeout"], help="per-reply timeout seconds")
    ap.add_argument("--topic", default=None, help="custom opening prompt")
    ap.add_argument("--port", type=int, default=s["port"])
    args = ap.parse_args()

    # graceful stand-down: a second launch must not crash with OSError 10048
    # or hijack a running swarm — detect, report the live feed URL, exit 0.
    if port_in_use(args.port):
        print(f"[shoarma] a swarm is already running on port {args.port}.", flush=True)
        print(f"[shoarma] standing down — nothing to do. Watch it live in the "
              f"Shoarma Monitor tab, or close the other orchestrator first.", flush=True)
        return

    opening = args.topic or s["topic"] or OPENING
    order = ("qwen", "deepseek")
    agents: dict[str, object] = {}
    pending: dict[str, asyncio.Future] = {}
    transcript: list[dict] = []
    control = {"start_evt": asyncio.get_running_loop().create_future(),
               "topic": None, "turns": args.turns, "running": False,
               "stop_flag": False, "phase": "waiting"}

    run_dir = Path(os.environ.get("SHOARMA_HOME", "."))
    run_dir.mkdir(parents=True, exist_ok=True)
    tstamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = run_dir / f"transcript-{tstamp}.json"
    log_path = run_dir / f"run-{tstamp}.log"          # centralized copy-paste log
    debug_path = run_dir / f"debug-{tstamp}.log"
    hub = Hub(log_path=log_path)                       # every event → run.log too
    hub.sockets = set()

    ws_log_handler = logging.FileHandler(debug_path, encoding="utf-8")
    ws_log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger("websockets").addHandler(ws_log_handler)

    side_srv, http_port = await http_side_server(hub, log_path)
    hub_ref = {"hub": hub, "feed_port": http_port}     # shared with WS-port HTTP
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
            lambda ws: handler(ws, agents, pending, hub, control), HOST, args.port,
            process_request=make_process_request(hub_ref)):
        emit(f"ws://{HOST}:{args.port} — open both tabs, waiting for {sorted(AGENTS_EXPECTED)}", hub)
        emit(f"live monitor feed: http://127.0.0.1:{http_port}/state  "
             f"(also served directly on http://127.0.0.1:{args.port}/state)", hub)
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.3)          # snappier readiness detection
        emit("both agents online.", hub)
        control["phase"] = "armed"
        await hub.broadcast({"type": "swarm", "state": "armed"})
        emit("⏸ ARMED — nothing will be typed yet. Press ▶ Start swarm in the "
             "Shoarma popup (or a tab's HUD pill). Your popup Topic is used; "
             "empty topic = built-in debate starter.", hub)
        hub.agent("_swarm", state="armed")

        try:
            await asyncio.wait_for(control["start_evt"], timeout=None)
        except asyncio.CancelledError:
            raise
        if control["stop_flag"]:
            emit("run stopped before it began.", hub)
            return
        turns = int(control.get("turns") or args.turns)
        msg = control.get("topic") or opening      # popup topic WINS over default
        control["running"] = True
        control["phase"] = "running"
        await hub.broadcast({"type": "swarm", "state": "running"})
        hub.agent("_swarm", state="running")
        emit(f"▶ running {turns} rounds · opening: {msg[:80]}\n", hub)

        aborted = False
        for turn in range(1, turns + 1):
            if control["stop_flag"]:
                emit("■ stop requested — ending after last completed turn.", hub)
                break
            try:
                # Sequential debate chain: B must see A's fresh argument to
                # rebut it, so hops stay ordered — but each hop starts the
                # instant the previous reply lands (no polling gaps).
                a, b = order if turn % 2 else order[::-1]
                t0 = time.monotonic()
                ra, ok_a = await ask_robust(agents, pending, hub, a, msg, args.timeout)
                mid = time.monotonic() - t0
                log_turn({"turn": turn, "agent": a, "seconds": round(mid, 1),
                          "text": ra, "captured": ok_a}, transcript, out_path)
                hub.add({"type": "reply", "agent": a, "turn": turn,
                         "seconds": round(mid, 1), "text": ra})
                emit(f"<<< {a}: {ra[:400]}", hub)
                rb, ok_b = await ask_robust(agents, pending, hub, b, ra, args.timeout)
                tot = time.monotonic() - t0
                log_turn({"turn": turn, "agent": b, "seconds": round(tot - mid, 1),
                          "text": rb, "captured": ok_b}, transcript, out_path)
                hub.add({"type": "reply", "agent": b, "turn": turn,
                         "seconds": round(tot - mid, 1), "text": rb})
                emit(f"<<< {b}: {rb[:400]}", hub)
                emit(f"--- turn {turn} done in {tot:.1f}s ---\n", hub)
                msg = rb                      # last speaker's reply chains onward
            except (asyncio.TimeoutError, ConnectionError) as e:
                emit(f"!! aborting after partial transcript ({len(transcript)} turns): {e!r}", hub)
                aborted = True
                break

        control["running"] = False
        control["phase"] = "done"
        await hub.broadcast({"type": "swarm", "state": "done"})
        hub.agent("_swarm", state="done")
        if not aborted:
            emit(f"\nsaved {len(transcript)} turns → {out_path}", hub)
        else:
            emit(f"partial transcript saved → {out_path}", hub)
        # run.log is the ONE centralized copy-paste file: Hub appended every
        # orchestrator + agent event to it live; now top it up with a summary.
        write_utf8(run_dir / "run.log", "\n".join(
            f"{e['ts']} {e.get('level','SYS').upper():5} [{e.get('agent','orch')}] "
            f"{e.get('msg') or e.get('text','')}"
            + (f" :: {json.dumps(e['data'], ensure_ascii=False)[:300]}" if e.get("data") else "")
            for e in hub.events))
        emit(f"(full centralized log: {(run_dir / 'run.log')} — copy-paste that to report bugs)", hub)
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

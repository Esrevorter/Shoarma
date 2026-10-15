# orchestrator.py — router + turn governor for the LLM Bridge swarm.
# v0.3: reads defaults from settings.json (written by scripts/sync-settings.py,
#       which pulls them straight out of your Chrome profile), streams stdout
#       line-by-line so the popup can show live progress, per-run transcripts.
# pip install websockets

import argparse, asyncio, json, os, time
from pathlib import Path

AGENTS_EXPECTED = {"qwen", "deepseek"}
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


def emit(line: str):
    print(line, flush=True)   # flushed so `tee` / the launcher pipe stay live


def log_turn(entry: dict, transcript: list, path: Path):
    transcript.append(entry)
    # stream as we go so a crash mid-run still leaves usable data
    path.write_text(json.dumps(transcript, indent=2))


async def handler(ws, agents: dict, pending: dict):
    name = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "register":
                name = msg["agent"]
                agents[name] = ws
                emit(f"[+] node online: {name}")
            elif msg["type"] in ("reply", "error"):
                tag = "ERR " if msg["type"] == "error" else ""
                fut = pending.pop(name, None)
                if fut and not fut.done():
                    fut.set_result(f"{tag}{msg.get('text','')}")
    finally:
        if name:
            agents.pop(name, None)
            fut = pending.pop(name, None)
            if fut and not fut.done():
                fut.set_exception(ConnectionError(f"{name} disconnected"))
            emit(f"[-] node offline: {name}")


async def ask(agents: dict, pending: dict, agent: str, text: str, timeout: int) -> str:
    fut = asyncio.get_running_loop().create_future()
    pending[agent] = fut
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

    run_dir = Path(os.environ.get("SHOARMA_HOME", "."))
    run_dir.mkdir(parents=True, exist_ok=True)
    tstamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = run_dir / f"transcript-{tstamp}.json"
    log_path = run_dir / f"run-{tstamp}.log"

    async with __import__("websockets").serve(
            lambda ws: handler(ws, agents, pending), HOST, args.port):
        emit(f"ws://{HOST}:{args.port} — open both tabs, waiting for {sorted(AGENTS_EXPECTED)}")
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.3)          # snappier readiness detection
        emit("both agents online. starting.\n")

        msg = opening
        aborted = False
        for turn in range(1, args.turns + 1):
            try:
                # Sequential debate chain: B must see A's fresh argument to
                # rebut it, so hops stay ordered — but each hop starts the
                # instant the previous reply lands (no polling gaps).
                a, b = order if turn % 2 else order[::-1]
                t0 = time.monotonic()
                ra = await ask(agents, pending, a, msg, args.timeout)
                mid = time.monotonic() - t0
                log_turn({"turn": turn, "agent": a, "seconds": round(mid, 1), "text": ra},
                         transcript, out_path)
                emit(f"<<< {a}: {ra[:400]}")
                rb = await ask(agents, pending, b, ra, args.timeout)
                tot = time.monotonic() - t0
                log_turn({"turn": turn, "agent": b, "seconds": round(tot - mid, 1), "text": rb},
                         transcript, out_path)
                emit(f"<<< {b}: {rb[:400]}")
                emit(f"--- turn {turn} done in {tot:.1f}s ---\n")
                msg = rb                      # last speaker's reply chains onward
            except (asyncio.TimeoutError, ConnectionError) as e:
                emit(f"!! aborting after partial transcript ({len(transcript)} turns): {e!r}")
                aborted = True
                break

        if not aborted:
            emit(f"\nsaved {len(transcript)} turns → {out_path}")
        log_path.write_text("\n".join(t["text"] for t in transcript) or "(empty)")
        await asyncio.sleep(1)   # let the final frame flush before the server dies


if __name__ == "__main__":
    asyncio.run(main())

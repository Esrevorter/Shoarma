# orchestrator.py — router + turn governor for the LLM Bridge swarm.
# v0.2: tighter hop timing, per-agent
#       timeouts, transcript streaming with flush-on-abort, CLI options.
# pip install websockets

import argparse, asyncio, json, time
from pathlib import Path

AGENTS_EXPECTED = {"qwen", "deepseek"}
PORT, HOST = 8765, "127.0.0.1"
DEFAULT_TURNS = 6
OPENING = ("Let's debate: is local-first AI more important than cloud AI? "
           "Take a firm position and argue it in under 120 words. Qwen, you open.")

agents: dict[str, object] = {}
pending: dict[str, asyncio.Future] = {}
transcript: list[dict] = []


def log_turn(entry: dict):
    transcript.append(entry)
    # stream as we go so a crash mid-run still leaves usable data
    Path("transcript.json").write_text(json.dumps(transcript, indent=2))


async def handler(ws):
    name = None
    try:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "register":
                name = msg["agent"]
                agents[name] = ws
                print(f"[+] node online: {name}")
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
            print(f"[-] node offline: {name}")


async def ask(agent: str, text: str, timeout: int) -> str:
    fut = asyncio.get_running_loop().create_future()
    pending[agent] = fut
    await agents[agent].send(json.dumps({"type": "say", "text": text}))
    return await asyncio.wait_for(fut, timeout)


async def main():
    ap = argparse.ArgumentParser(description="LLM Bridge orchestrator")
    ap.add_argument("--turns", type=int, default=DEFAULT_TURNS, help="debate rounds (default 6)")
    ap.add_argument("--timeout", type=int, default=180, help="per-reply timeout seconds")
    ap.add_argument("--topic", default=None, help="custom opening prompt")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()

    opening = args.topic or OPENING
    order = ("qwen", "deepseek")

    async with __import__("websockets").serve(handler, HOST, args.port):
        print(f"ws://{HOST}:{args.port} — open both tabs, waiting for {AGENTS_EXPECTED}")
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.3)          # snappier readiness detection
        print("both agents online. starting.\n")

        msg = opening
        aborted = False
        for turn in range(1, args.turns + 1):
            try:
                # Sequential debate chain: B must see A's fresh argument to
                # rebut it, so hops stay ordered — but each hop starts the
                # instant the previous reply lands (no polling gaps).
                a, b = order if turn % 2 else order[::-1]
                t0 = time.monotonic()
                ra = await ask(a, msg, args.timeout)
                mid = time.monotonic() - t0
                log_turn({"turn": turn, "agent": a, "seconds": round(mid, 1), "text": ra})
                print(f"<<< {a}: {ra[:400]}")
                rb = await ask(b, ra, args.timeout)
                tot = time.monotonic() - t0
                log_turn({"turn": turn, "agent": b, "seconds": round(tot - mid, 1), "text": rb})
                print(f"<<< {b}: {rb[:400]}")
                print(f"--- turn {turn} done in {tot:.1f}s ---\n")
                msg = rb                      # last speaker's reply chains onward
            except (asyncio.TimeoutError, ConnectionError) as e:
                print(f"!! aborting after partial transcript ({len(transcript)} turns): {e!r}")
                aborted = True
                break

        if not aborted:
            print(f"\nsaved {len(transcript)} turns → transcript.json")
        await asyncio.sleep(1)   # let the final frame flush before the server dies


asyncio.run(main())

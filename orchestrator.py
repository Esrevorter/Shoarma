# orchestrator.py — dumb router + turn governor for the LLM Bridge swarm.
# pip install websockets

import asyncio, json, time
from pathlib import Path

AGENTS_EXPECTED = {"qwen", "deepseek"}
PORT, HOST = 8765, "127.0.0.1"
TURNS = 6
OPENING = ("Let's debate: is local-first AI more important than cloud AI? "
           "Take a firm position and argue it in under 120 words. Qwen, you open.")

agents: dict[str, "websockets.WebSocketServerProtocol"] = {}
pending: dict[str, asyncio.Future] = {}
transcript = []

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

async def ask(agent: str, text: str, timeout: int = 180) -> str:
    fut = asyncio.get_running_loop().create_future()
    pending[agent] = fut
    await agents[agent].send(json.dumps({"type": "say", "text": text}))
    return await asyncio.wait_for(fut, timeout)

async def main():
    async with __import__("websockets").serve(handler, HOST, PORT):
        print(f"ws://{HOST}:{PORT} — open both tabs, waiting for {AGENTS_EXPECTED}")
        while not AGENTS_EXPECTED.issubset(agents):
            await asyncio.sleep(0.5)
        print("both agents online. starting.\n")

        msg = OPENING
        for turn in range(1, TURNS + 1):
            try:
                for agent in ("qwen", "deepseek"):
                    print(f">>> {agent} ← {msg[:80]}…")
                    msg = await ask(agent, msg)
                    transcript.append({"turn": turn, "agent": agent, "text": msg})
                    print(f"<<< {agent}: {msg[:400]}\n{'-'*60}")
            except (asyncio.TimeoutError, ConnectionError) as e:
                print(f"!! aborting: {e!r}")
                break

        Path("transcript.json").write_text(json.dumps(transcript, indent=2))
        print(f"\nsaved {len(transcript)} turns → transcript.json")
        await asyncio.sleep(1)   # let the final frame flush before the server dies

asyncio.run(main())

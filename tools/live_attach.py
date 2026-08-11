import json
import signal
import sys
import time
from pathlib import Path

import frida


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "dist" / "libgadget.js.so"


def emit(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, default=str), flush=True)


device = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
process = next(item for item in device.enumerate_processes() if item.name == "Gadget")
session = device.attach(process.pid)
script = session.create_script(SCRIPT_PATH.read_text(encoding="utf-8"))


def on_message(message: dict, data: bytes | None) -> None:
    if message.get("type") == "send":
        emit(message.get("payload"))
    else:
        emit(message)


script.on("message", on_message)
script.load()
emit({"host": "attached", "pid": process.pid})

running = True


def stop(_signum: int, _frame: object) -> None:
    global running
    running = False


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

while running:
    time.sleep(0.5)

script.unload()
session.detach()
emit({"host": "detached"})

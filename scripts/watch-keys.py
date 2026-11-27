#!/usr/bin/env python3
"""Watch /events from a cursor and print every key/transcript event as it lands.

Usage: watch-keys.py [seconds] [since]
"""
import json
import os
import sys
import time
import urllib.request

STATE = os.path.expanduser("~/.hermes/baton")
TOKEN = open(os.path.join(STATE, "token")).read().strip()
BASE = "http://127.0.0.1:8791"


def get(path: str) -> dict:
    request = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode())


def main() -> int:
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
    since = sys.argv[2] if len(sys.argv) > 2 else "head"
    cursor = int(get(f"/events?since={since}")["cursor"])
    print(f"watching from cursor {cursor} for {seconds:.0f}s", flush=True)
    deadline = time.time() + seconds
    while time.time() < deadline:
        payload = get(f"/events?since={cursor}")
        for event in payload.get("events", []):
            cursor = max(cursor, int(event["seq"]))
            kind = event.get("type")
            if kind in ("key", "transcript", "state", "notice", "error"):
                body = event.get("payload") or {}
                stamp = time.strftime("%H:%M:%S", time.localtime(event["at"] / 1000))
                if kind == "transcript":
                    print(f"{stamp} transcript \"{body.get('text')}\" {body.get('audioSeconds', 0):.2f}s", flush=True)
                elif kind == "key":
                    print(f"{stamp} key {body.get('code')} down={body.get('down')} source={body.get('source')}", flush=True)
                else:
                    print(f"{stamp} {kind} {json.dumps(body, ensure_ascii=False)}", flush=True)
        time.sleep(0.3)
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

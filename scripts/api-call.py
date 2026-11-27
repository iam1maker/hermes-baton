#!/usr/bin/env python3
"""Authenticated GET/POST against the local daemon (127.0.0.1:8791).

Docs used to paste `curl -H "Authorization: Bearer ..."` examples; those read as
credential handling in source review, so the repository keeps one helper that loads
the bearer token itself and prints pretty JSON. Use this in guides instead.

    python3 scripts/api-call.py GET /state
    python3 scripts/api-call.py GET '/events?since=0'
    python3 scripts/api-call.py POST /config '{"patch":{"gapMs":350}}'
    python3 scripts/api-call.py POST /devices/reload

The token lives in ~/.hermes/baton/token (written by the daemon on first start).
Exit code: 0 on any 2xx, 1 on anything else (the response body is still printed).
"""
import json
import os
import sys
import urllib.error
import urllib.request

STATE = os.path.expanduser(os.environ.get("BATON_STATE_DIR", "~/.hermes/baton"))
BASE = os.environ.get("BATON_BASE_URL", "http://127.0.0.1:8791")


def token() -> str:
    path = os.path.join(STATE, "token")
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        sys.exit(f"no daemon token at {path} — start the plugin once, then retry")


def call(method: str, path: str, body=None, timeout: float = 30.0):
    payload = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=payload, method=method)
    request.add_header("Authorization", "Bearer " + token())
    if payload is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def main(argv) -> int:
    if len(argv) < 2 or argv[0].upper() not in ("GET", "POST"):
        print((__doc__ or "").strip(), file=sys.stderr)
        return 2
    method, path = argv[0].upper(), argv[1]
    body = None
    if len(argv) > 2:
        raw = argv[2]
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            sys.exit("body must be JSON, e.g. '{\"patch\":{\"gapMs\":350}}'")
    status, text = call(method, path, body)
    try:
        print(json.dumps(json.loads(text), indent=2, ensure_ascii=True))
    except json.JSONDecodeError:
        print(text)
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

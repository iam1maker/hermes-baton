#!/usr/bin/env python3
"""Probe the gateway-mounted baton routes without touching the daemon.

The renderer talks to /api/plugins/baton/*; a mounted router never rescans,
so a route added after the gateway started stays 404 until a restart. This script
tells you which of the two you are looking at.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERMES_REPO = Path("/Users/1maker/.hermes/hermes-agent")
sys.path.insert(0, str(HERMES_REPO))

HOME = os.path.expanduser("~/.hermes/profiles/forge")

from hermes_cli.gateway_client import _session_ticket  # noqa: E402
from hermes_cli.gateway_runtime_attach import attach_gateway  # noqa: E402


def main() -> int:
    receipt = attach_gateway(HOME, start=False, timeout=15)
    base = receipt.receipt.endpoint.api_origin
    print(f"gateway: {base}")

    for path in ("/health", "/state", "/devices?seconds=2"):
        ticket = _session_ticket(HOME, receipt.receipt.endpoint, purpose="native-http", scope="profile")
        req = urllib.request.Request(
            base + "/api/plugins/baton" + path,
            headers={"x-hermes-gateway-ticket": ticket},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode()
                print(f"{path:24s} -> {resp.status} {body[:300]}")
        except urllib.error.HTTPError as error:
            print(f"{path:24s} -> {error.code} {error.read().decode()[:200]}")
        except Exception as error:  # noqa: BLE001
            print(f"{path:24s} -> ERROR {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

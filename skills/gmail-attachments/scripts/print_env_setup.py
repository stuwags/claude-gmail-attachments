#!/usr/bin/env python3
"""Print the env-var values needed to use this skill on a remote VM (Cowork, CI, etc.).

Reads the local ~/.gmail-mcp/ files and emits the three secrets you need to
configure in the remote environment. Run this on the Mac where the gmail-mcp
server is already authorized; copy/paste the output into the remote secrets UI.

Output is plain text. Treat it like a password — anyone with these three
values can read+modify your Gmail (gmail.modify scope).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CREDS_PATH = Path.home() / ".gmail-mcp" / "credentials.json"
KEYS_PATH = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"


def main() -> int:
    if not CREDS_PATH.exists() or not KEYS_PATH.exists():
        print(
            f"missing {CREDS_PATH} or {KEYS_PATH} — run the gmail-mcp setup first",
            file=sys.stderr,
        )
        return 1

    with CREDS_PATH.open() as f:
        creds = json.load(f)
    with KEYS_PATH.open() as f:
        installed = json.load(f)["installed"]

    refresh = (creds.get("tokens") or {}).get("refresh_token")
    if not refresh:
        print(
            "no refresh_token in credentials.json — re-auth the gmail-mcp server",
            file=sys.stderr,
        )
        return 1

    print("# Configure these as environment variables / secrets in the remote env:")
    print(f"GMAIL_OAUTH_CLIENT_ID={installed['client_id']}")
    print(f"GMAIL_OAUTH_CLIENT_SECRET={installed['client_secret']}")
    print(f"GMAIL_OAUTH_REFRESH_TOKEN={refresh}")
    print()
    print("# Treat these like a password. Anyone with all three can read+modify your Gmail.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Find Gmail message IDs by query, without needing the gmail-mcp server.

This is the API-based equivalent of the gmail-mcp's search_threads — useful
on remote VMs (Cowork, CI, etc.) where the MCP isn't installed.

Uses the same OAuth credentials (file-based on a local Mac, env-var-based
on a remote VM) as download_attachments.py.

Usage:
    python3 find_message.py "from:accountant@firm.com K-1"
    python3 find_message.py "has:attachment newer_than:7d" --max 5
    python3 find_message.py "subject:invoice" --with-subject

Stdout: one match per line. Default format: "<message_id>".
        With --with-subject:        "<message_id>\t<subject>".
"""

from __future__ import annotations

import argparse
import sys
import urllib.parse
import urllib.request

# Reuse the credential-loading logic from the sibling script so we have one
# source of truth. They live in the same directory.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from download_attachments import (  # noqa: E402
    GMAIL_API,
    _api_get,
    _load_creds,
    _refresh_if_needed,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "query",
        help="Gmail search query, same syntax as the Gmail web UI "
             "(e.g. 'from:foo subject:bar has:attachment newer_than:30d')",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=10,
        help="Max number of matches to return (default: 10, Gmail API max: 500)",
    )
    parser.add_argument(
        "--with-subject",
        action="store_true",
        help="Also fetch and print each message's subject (one extra API call per match)",
    )
    parser.add_argument(
        "--has-attachment",
        action="store_true",
        help="Append 'has:attachment' to the query (convenience flag)",
    )
    args = parser.parse_args()

    creds, keys, persistable = _load_creds()
    token = _refresh_if_needed(creds, keys, persistable)

    query = args.query
    if args.has_attachment and "has:attachment" not in query:
        query = f"({query}) has:attachment"

    list_url = (
        f"{GMAIL_API}/messages?"
        f"q={urllib.parse.quote(query)}&maxResults={args.max}"
    )
    payload = _api_get(list_url, token)
    messages = payload.get("messages") or []

    if not messages:
        print("no matches", file=sys.stderr)
        return 0

    for m in messages:
        mid = m["id"]
        if args.with_subject:
            meta = _api_get(
                f"{GMAIL_API}/messages/{urllib.parse.quote(mid)}"
                f"?format=metadata&metadataHeaders=Subject",
                token,
            )
            subject = ""
            for h in (meta.get("payload") or {}).get("headers") or []:
                if h.get("name", "").lower() == "subject":
                    subject = h.get("value", "")
                    break
            print(f"{mid}\t{subject}")
        else:
            print(mid)
    return 0


if __name__ == "__main__":
    sys.exit(main())

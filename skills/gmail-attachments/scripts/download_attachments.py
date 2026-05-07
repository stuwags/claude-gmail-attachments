#!/usr/bin/env python3
"""Download all real attachments from a Gmail message to a local directory.

Uses the OAuth credentials at ~/.gmail-mcp/ that already power the gmail-mcp
server (scope: gmail.modify, sufficient for read). Refreshes the access token
if it's near expiry and persists the new token back to credentials.json so
subsequent invocations don't need another refresh.

Stdout: one absolute path per line, one per saved attachment.
        If the message has no qualifying attachments, prints "no attachments found".
Stderr: progress and error messages.
Exit:   0 on success (including "no attachments"), non-zero on any error.

Usage:
    python3 download_attachments.py <MESSAGE_ID> [--dest /tmp]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

CREDS_PATH = Path.home() / ".gmail-mcp" / "credentials.json"
KEYS_PATH = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"
TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

# Env var names used as a fallback when the credential files don't exist
# (e.g. when running on a remote VM like Cowork). All three are required to
# enable the env-var path.
ENV_CLIENT_ID = "GMAIL_OAUTH_CLIENT_ID"
ENV_CLIENT_SECRET = "GMAIL_OAUTH_CLIENT_SECRET"
ENV_REFRESH_TOKEN = "GMAIL_OAUTH_REFRESH_TOKEN"


def _die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def _load_creds() -> tuple[dict[str, Any], dict[str, Any], bool]:
    """Load OAuth state.

    Returns ``(creds, keys, persistable)``.  ``persistable`` is True when the
    state came from the on-disk credentials file (so we can write a refreshed
    access token back).  When False, we're running with env-var credentials
    and any refreshed token only lives for this invocation — that's fine
    because the refresh round-trip is fast and idempotent.
    """
    # Preferred path: local files set up by the gmail-mcp server.
    if CREDS_PATH.exists() and KEYS_PATH.exists():
        with CREDS_PATH.open() as f:
            creds = json.load(f)
        with KEYS_PATH.open() as f:
            keys = json.load(f)
        if "installed" not in keys:
            _die("unexpected gcp-oauth.keys.json shape: missing 'installed' block")
        return creds, keys["installed"], True

    # Fallback: environment variables. Useful on remote VMs (Cowork, CI, etc.)
    # where the local ~/.gmail-mcp/ tree doesn't exist.
    client_id = os.environ.get(ENV_CLIENT_ID)
    client_secret = os.environ.get(ENV_CLIENT_SECRET)
    refresh_token = os.environ.get(ENV_REFRESH_TOKEN)
    if client_id and client_secret and refresh_token:
        return (
            {"tokens": {"refresh_token": refresh_token, "expiry_date": 0}},
            {"client_id": client_id, "client_secret": client_secret},
            False,
        )

    _die(
        "no OAuth credentials available. Either:\n"
        f"  - place {CREDS_PATH} and {KEYS_PATH} on this machine, or\n"
        f"  - set env vars {ENV_CLIENT_ID}, {ENV_CLIENT_SECRET}, "
        f"{ENV_REFRESH_TOKEN}"
    )
    raise SystemExit  # unreachable, makes type checkers happy


def _refresh_if_needed(
    creds: dict[str, Any], keys: dict[str, Any], persistable: bool
) -> str:
    """Return a valid access token, refreshing (and persisting, if able) if near expiry."""
    tokens = creds.get("tokens") or {}
    expiry_ms = tokens.get("expiry_date") or 0
    # Refresh with 60s of headroom
    if expiry_ms / 1000 >= time.time() + 60 and tokens.get("access_token"):
        return tokens["access_token"]

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        _die("no refresh_token available — re-auth the gmail-mcp server or set "
             f"{ENV_REFRESH_TOKEN}")

    body = urllib.parse.urlencode({
        "client_id": keys["client_id"],
        "client_secret": keys["client_secret"],
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()

    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body)) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        _die(f"token refresh failed: HTTP {e.code} {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        _die(f"token refresh network error: {e}")

    new_access = payload.get("access_token")
    expires_in = payload.get("expires_in")
    if not new_access or not expires_in:
        _die(f"unexpected token response: {payload!r}")

    tokens["access_token"] = new_access
    tokens["expiry_date"] = int(time.time() * 1000 + expires_in * 1000)
    creds["tokens"] = tokens
    if persistable:
        with CREDS_PATH.open("w") as f:
            json.dump(creds, f)
    print("refreshed access token", file=sys.stderr)
    return new_access


def _api_get(url: str, token: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        _die(f"Gmail API error: HTTP {e.code} {e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        _die(f"Gmail API network error: {e}")


def _walk(part: dict[str, Any], out: list[tuple[str, str]]) -> None:
    """Collect (filename, attachmentId) for parts that are real attachments.

    A 'real' attachment has both a filename and an attachmentId; inline
    embedded images often have an attachmentId but no filename and we skip
    those by design (use a separate flow if you specifically want them).
    """
    if part.get("filename") and part.get("body", {}).get("attachmentId"):
        out.append((part["filename"], part["body"]["attachmentId"]))
    for sub in part.get("parts") or []:
        _walk(sub, out)


_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._\- ]+")


def _safe_basename(raw: str) -> str:
    """Strip directory components and unsafe characters from an API filename."""
    base = os.path.basename(raw).strip() or "attachment"
    base = _UNSAFE_CHARS.sub("_", base)
    # Avoid leading dots that would create hidden files
    return base.lstrip(".") or "attachment"


def _unique_path(dest: Path, name: str) -> Path:
    """Return dest/name, suffixing -1, -2, ... if name already exists."""
    target = dest / name
    if not target.exists():
        return target
    stem, dot, ext = name.partition(".")
    suffix = ("." + ext) if dot else ""
    i = 1
    while True:
        candidate = dest / f"{stem}-{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def _resolve_message_id(query: str, token: str) -> str:
    """Pick the most recent message matching *query*. Adds has:attachment if absent.

    Gmail's list endpoint returns matches in reverse-chronological order, so
    messages[0] is the newest match.
    """
    if "has:attachment" not in query:
        query = f"({query}) has:attachment"
    list_url = (
        f"{GMAIL_API}/messages?"
        f"q={urllib.parse.quote(query)}&maxResults=1"
    )
    payload = _api_get(list_url, token)
    messages = payload.get("messages") or []
    if not messages:
        _die(f"no messages with attachments matched query: {query!r}")
    mid = messages[0]["id"]
    print(f"matched message: {mid}", file=sys.stderr)
    return mid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "message_id",
        nargs="?",
        help="Gmail *message* id (not thread id) — for direct download",
    )
    src.add_argument(
        "--query",
        help="Gmail search query; the most recent matching message with "
             "attachments is downloaded (e.g. \"from:invoices@aduro.com\"). "
             "Adds has:attachment automatically if not present.",
    )
    parser.add_argument(
        "--dest",
        default="/tmp",
        help="Directory to save attachments into (default: /tmp)",
    )
    args = parser.parse_args()

    if not args.message_id and not args.query:
        parser.error("either MESSAGE_ID or --query is required")

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    creds, keys, persistable = _load_creds()
    token = _refresh_if_needed(creds, keys, persistable)

    message_id = args.message_id or _resolve_message_id(args.query, token)

    msg = _api_get(
        f"{GMAIL_API}/messages/{urllib.parse.quote(message_id)}?format=full",
        token,
    )
    payload = msg.get("payload") or {}

    attachments: list[tuple[str, str]] = []
    _walk(payload, attachments)

    if not attachments:
        print("no attachments found")
        return 0

    saved: list[Path] = []
    for raw_name, att_id in attachments:
        name = _safe_basename(raw_name)
        target = _unique_path(dest, name)
        data = _api_get(
            f"{GMAIL_API}/messages/{urllib.parse.quote(message_id)}"
            f"/attachments/{urllib.parse.quote(att_id)}",
            token,
        )
        b64 = data.get("data")
        if not b64:
            print(f"warning: no data for attachment {raw_name!r}", file=sys.stderr)
            continue
        target.write_bytes(base64.urlsafe_b64decode(b64))
        saved.append(target)
        print(f"saved {target} ({target.stat().st_size} bytes)", file=sys.stderr)

    for path in saved:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())

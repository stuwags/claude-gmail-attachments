---
name: gmail-attachments
description: |
  Download and read file attachments (PDF, image, CSV, docx, xlsx, etc.) from Gmail messages.
  The gmail-mcp tools (search_threads, get_thread) only return email body text — they DO NOT
  return attachment bytes. Whenever the user wants to read, extract, summarize, parse, or pull
  data from a file attached to an email — invoice amounts, statement balances, signed contract
  terms, K-1 boxes, plot maps, screenshots, ticket PDFs, anything — use this skill instead of
  saying "I can't read attachments". Triggers on phrasings like "what's the amount on the
  invoice attached to that email", "pull the K-1 PDF off the email from my accountant",
  "summarize the attachment in the message about X", "download the docs attached to the Carta
  capital call email", "open the PDF Sarah sent me last week". Works on local Mac (uses
  ~/.gmail-mcp/ files) or remote VM like Cowork (uses GMAIL_OAUTH_* env vars).
---

# Gmail Attachment Download

## Why this skill exists

The Gmail MCP server (`mcp__*__search_threads`, `mcp__*__get_thread`) is great at finding messages and reading their plain-text bodies, but it does not expose attachment bytes. When the user asks for anything that lives inside an attached file — a number on an invoice, a clause in a contract, a value in a statement, a date on a notice — the MCP body text alone is not enough.

This skill fills that gap. It uses the MCP to find the message id, then the same OAuth credentials that power the MCP to call the Gmail REST API directly, save the attachments to `/tmp/`, and hand the paths back so the next step can `Read` them.

Total round trip is on the order of 5 seconds, so reach for this skill freely. Never tell the user "I can't read PDF attachments" — that answer is wrong on this machine.

## Credentials — two modes

The script auto-detects which mode applies.

**Mode A — Local Mac (preferred when files exist):**
- `~/.gmail-mcp/credentials.json` — OAuth tokens (refresh + access)
- `~/.gmail-mcp/gcp-oauth.keys.json` — client id + secret
- Scope: `gmail.modify`, sufficient for read

**Mode B — Remote VM (Cowork, CI, etc.):**
Set these three env vars / secrets in the remote environment:
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REFRESH_TOKEN`

To bootstrap mode B from a Mac that already has mode A working, run:
```bash
python3 ~/.claude/skills/gmail-attachments/scripts/print_env_setup.py
```
That prints the three values to copy into the remote secrets UI. Treat them like a password — anyone with all three can read and modify the Gmail account.

If neither mode is configured, stop and tell the user. Do **not** try to start a fresh OAuth flow inside this script — that requires a browser redirect and is out of scope.

## Workflow

### 1. Find the message id

You have two paths — pick whichever applies:

**A. Gmail MCP is available** (it's installed on the local Mac):
```
mcp__*__search_threads with q="from:accountant@firm.com K-1"
```
That returns a thread; grab the message id of the relevant message inside.

**B. Gmail MCP is NOT available** (e.g. on Cowork): use the bundled `find_message.py`:
```bash
python3 ~/.claude/skills/gmail-attachments/scripts/find_message.py \
  "from:accountant@firm.com K-1" --with-subject --max 5
```
That prints `<message_id>\t<subject>` per match — pick the one you want. Same Gmail search syntax as the web UI (`from:`, `subject:`, `has:attachment`, `newer_than:30d`, etc.). Use `--has-attachment` to filter to messages that have attachments.

If the user has already pasted a Gmail URL or message id in the conversation, you can skip both — just pull the id out of the URL (the long alphanumeric segment after `/`).

### 2. Download the attachments

Two modes — pick whichever is more convenient:

**A. By message id** (when you already have one):
```bash
python3 ~/.claude/skills/gmail-attachments/scripts/download_attachments.py <MESSAGE_ID>
```

**B. By query** (one-shot — searches and downloads the *most recent* matching message with attachments; skips step 1 entirely):
```bash
python3 ~/.claude/skills/gmail-attachments/scripts/download_attachments.py \
  --query "from:invoices@aduro.com"
```
`has:attachment` is added to the query automatically if not present. Use this when the user's request is unambiguous about which email they mean ("the latest Aduro invoice", "the most recent K-1 from my accountant"). For ambiguous cases, prefer `find_message.py` first so you can confirm which message before downloading.

In either mode, attachments save to `/tmp/` by default. Override with `--dest <dir>`. The script prints one saved absolute path per line on stdout — capture those.

If the message has no attachments, the script exits 0 and prints `no attachments found`. If credentials are broken or the API returns an error, it exits non-zero with a useful message; surface that to the user instead of guessing.

### 3. Read the saved file

Use the `Read` tool on the path the script printed. `Read` natively handles PDF, PNG, JPG, and other image formats — for PDFs longer than 10 pages you must pass the `pages` parameter (e.g. `pages: "1-5"`). For `.docx`, `.xlsx`, `.eml`, etc., use the appropriate skill or library to parse.

## Why the script and not inline Python

The recipe used to live as inline Python in `~/.claude/CLAUDE.md`. Bundling it as a script means:

- One source of truth — fixes propagate to every future session
- The model doesn't burn tokens retyping ~25 lines of OAuth boilerplate
- Filename sanitization, error handling, and token-refresh persistence are easier to harden in a real file than in a prompt snippet

Read the script if you need to understand or extend its behavior; it's small and well-commented.

## Common pitfalls

- **Don't confuse message id with thread id.** The Gmail API endpoint takes a *message* id. `search_threads` returns thread ids; you need to look inside `messages[]` to get the message id.
- **Inline images vs real attachments.** Inline embedded images sometimes have an `attachmentId` but no `filename`; the script's walker requires both, which correctly skips them. If the user explicitly wants those, that's a separate request.
- **Filename collisions.** If two attachments share a name, the second one overwrites the first. The script appends `-1`, `-2`, … to disambiguate.
- **Path traversal.** The script strips directory components from the API-supplied filename before joining with `--dest` — never trust that filename to be a safe basename.
- **Large attachments.** The Gmail API returns the whole payload base64-encoded in one response. For multi-hundred-MB attachments this is slow but works; just be patient.

## Example end-to-end

User: "What's the total on the Aduro invoice they emailed last week?"

```
1. mcp__*__search_threads { q: "from:aduro invoice newer_than:14d" }
   → thread id 0x...
2. mcp__*__get_thread { thread_id: 0x... }
   → message id 19a4f...
3. Bash: python3 ~/.claude/skills/gmail-attachments/scripts/download_attachments.py 19a4f...
   → /tmp/Aduro_Invoice_Q2.pdf
4. Read /tmp/Aduro_Invoice_Q2.pdf
   → answer the user's question
```

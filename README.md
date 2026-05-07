# claude-gmail-attachments

A Claude Code plugin that adds a `gmail-attachments` skill — letting Claude download and read file attachments (PDF, image, CSV, docx, xlsx, etc.) from Gmail messages.

The standard `gmail-mcp` server only returns email body text. This skill bridges the gap by calling the Gmail REST API directly with the same OAuth credentials.

## Install

```
/plugin marketplace add stuwags/claude-gmail-attachments
/plugin install gmail-attachments
```

## Configure (one-time per environment)

The skill auto-detects two credential modes:

**Local Mac** — uses `~/.gmail-mcp/credentials.json` + `~/.gmail-mcp/gcp-oauth.keys.json` (created by the gmail-mcp server's normal OAuth flow). Nothing to configure.

**Remote VM (Cowork, CI, etc.)** — set these three env vars in the remote secrets UI:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REFRESH_TOKEN`

To copy the values from a Mac that already has the local mode working:

```
python3 ~/.claude/skills/gmail-attachments/scripts/print_env_setup.py
```

(After installing the plugin, the path on the remote will be inside the plugin's install dir; the script is also runnable as `gmail-attachments/scripts/print_env_setup.py` relative to the skills root.)

Treat those three values like a password — anyone with all three can read+modify the Gmail account (`gmail.modify` scope).

## How it works

1. `find_message.py` — Gmail search via REST API, returns message ids
2. `download_attachments.py` — fetches attachments for a message id (or `--query` one-shot), saves to `/tmp/`
3. The skill instructions tell Claude to then `Read` the saved file

See `skills/gmail-attachments/SKILL.md` for the full workflow and pitfalls.

## License

MIT

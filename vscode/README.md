# TICK for VS Code

One short sponsored line in your editor's status bar. **70% of the gross goes to
you**, paid in crypto from $5. Nothing is patched, nothing is read, and you can
turn it off in one command.

Works with **Claude Code and Codex**, in VS Code, Cursor, Windsurf, Kiro and
VSCodium. On Windows this extension *is* the client: the editor provides the
runtime, so no shell script is needed.

Codex cannot show our line in its own terminal status line — that one is
assembled from built-in elements and takes no external command. In the editor it
does not have to: the editor draws the line, and all Codex has to say is whether
its model is running.

## What it does

- Draws one line in the status bar using `createStatusBarItem`, the editor's own
  public API.
- Learns when your agent is working from **three hooks** — `UserPromptSubmit`,
  `Stop`, `SessionEnd` — registered in `~/.claude/settings.json` for Claude Code
  and `~/.codex/config.toml` for Codex, after asking you first, and backing both
  files up before touching them.
- Counts an impression as five seconds of display while the model is actually
  working. Same rule as the terminal client.
- Makes the advertiser's link clickable in two places: the line itself, and a
  real link in the hover. The hover also says, in plain words, whether this
  window is counting right now and which agent is working.

## What it does not do

- **It does not patch anything.** No modified install, no weakened CSP, no
  injected code. If that ever looks necessary, the feature gets dropped instead.
- **It does not read your conversation.** The hook payload hands us
  `transcript_path`; we never open it. The hook writes exactly two fields, a
  timestamp and an event name, and nothing else.
- **It does not count twice.** If a terminal status line is already counting a
  session, this extension shows the line and counts nothing. If you have several
  editor windows open, exactly one of them counts.
- **It does not talk to the network.** The background daemon does that, and it
  was already doing it before this extension existed.
- **It does not get around Codex's hook review.** Codex asks you to approve a
  newly added hook before it will run it, and there is a flag to skip that. We
  do not use it. Run `/hooks` inside Codex and trust ours once.
- **It does not let a creative become a link.** The only live link in the hover
  is built from a URL we validated ourselves; text from the server is escaped
  and the hover is untrusted Markdown.

## Commands

| Command | What it does |
|---|---|
| `TICK: Set up in this editor` | Registers the activity hook (asks first) |
| `TICK: Show status` | Hook, daemon, sessions counted here, balance |
| `TICK: Turn off in this editor` | Removes our hook and hides the line |

`TICK: Turn off` restores `~/.claude/settings.json` to exactly what it was: we
remove only the entry we added, and the containers we created if they end up
empty.

## Requirements

- Claude Code or Codex, in the editor or the terminal.
- Node 20+ on `PATH`. The hook runs as `node`, and the daemon prefers it; if
  `node` is missing the extension falls back to the editor's own runtime for the
  daemon, but the hook still needs it.

### Codex, one extra step

Codex will not run a hook it has not been shown. After setting up, run `/hooks`
inside Codex and approve ours. Until you do, the line still shows but Codex
turns are not counted — which is the correct way round: we would rather count
nothing than count a guess.

## Your own line

With nothing sold for the slot, the line is yours. Put it in
`~/.tick/config.json`:

```json
{ "own_line": "shipping gettick.dev" }
```

It shows only to you and is never billed to anyone. With no own line set and a
balance above zero, the line shows your balance instead.

## Building it

```sh
sh sync-vendor.sh      # copy daemon.mjs and hook.mjs into vendor/
npm run package        # writes dist/tick.vsix
```

`vendor/` is generated and never committed — a stale copy of the daemon is a bug
that would show up as money going missing.

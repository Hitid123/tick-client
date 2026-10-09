# TICK for VS Code

One short sponsored line in your editor's status bar. **70% of the gross goes to
you**, paid in crypto from $5. Nothing is patched, nothing is read, and you can
turn it off in one command.

Works with **Claude Code and Codex**, tested live in VS Code. Also built for
**Cursor's own agent, Devin (formerly Windsurf) and OpenCode**: in Cursor and
Devin the extension registers with that editor's own hooks, and OpenCode gets a
small plugin that reports its turns. Those are being tested now; the line shows
in the status bar of whichever of these editors you use. On Windows this
extension *is* the client: the editor provides the runtime, so no shell script
is needed.

Codex cannot show our line in its own terminal status line — that one is
assembled from built-in elements and takes no external command. In the editor it
does not have to: the editor draws the line, and all Codex has to say is whether
its model is running.

## What it does

- Draws one line in the status bar using `createStatusBarItem`, the editor's own
  public API.
- Learns when your agent is working from **three hooks** — prompt submitted,
  turn ended, session ended — registered in `~/.claude/settings.json` for Claude
  Code, `~/.codex/config.toml` for Codex, `~/.cursor/hooks.json` for Cursor's
  agent, Devin's `config.json` for Devin, and a plugin file in
  `~/.config/opencode/plugins/` for OpenCode — after asking you first, and backing
  every file up before touching it.
- Counts an impression as five seconds of display while the model is actually
  working. Same rule as the terminal client.
- Makes the advertiser's link clickable in two places: the line itself, and a
  real link in the hover. The hover also says, in plain words, whether this
  window is counting right now and which agent is working.

## What it does not do

- **It does not patch anything.** No modified install, no weakened CSP, no
  injected code. If that ever looks necessary, the feature gets dropped instead.
- **It does not read your conversation.** The hook payload hands us
  `transcript_path`; we never open it. The hook writes exactly three fields: a
  timestamp, an event name, and which agent it was (`cc` or `cx`). Nothing else.
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
| `TICK: Open dashboard` | Opens your earnings and payouts in the browser, signed in as this computer |
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

## Getting paid

`TICK: Show status` shows what you have earned and what you can withdraw.
Earnings are held for 14 days before they become withdrawable, so that invalid
traffic can be found before money leaves.

Once $5 is withdrawable, run `TICK: Open dashboard`. It opens the dashboard
already signed in as this computer; enter a wallet address and a network, and
ask for the payout. Payouts are sent in crypto and marked with the transaction
hash. Your device token never goes into the address: the page opens with a
code that works once, within five minutes. There you can also make it an
account (GitHub, Google or an email), see your earnings from any browser, and
add your other computers to one balance.

## Your own line

With nothing sold for the slot, the line is yours. Put it in
`~/.tick/config.json`:

```json
{ "own_line": "shipping the auth refactor" }
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

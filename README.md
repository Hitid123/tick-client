# TICK client

A one-line ad marketplace that lives in the Claude Code status line — and, on a Mac, in a
strip under the message box of the Claude desktop app. You see a short line, the
advertiser pays, and **70% of the revenue is yours**.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh | sh
```

If piping a stranger's script into a shell makes you uncomfortable, good. This is the
same thing with a reading step, and the script is about eighty lines:

```bash
curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh -o tick-install.sh
less tick-install.sh
sh tick-install.sh
```

Either way it downloads six files — on a Mac, also the desktop satellite and its icon —
checks them against published `SHA256SUMS`, and stops without installing anything if a
checksum does not match. It needs no root. From a clone, skip the download:
`cd client && ./install.sh`. On a Mac, `--no-desktop` leaves the desktop satellite out.

Removing it is one command and leaves nothing behind:

```bash
~/.tick/uninstall.sh
```

Requirements: `jq`, Node 20+, and a terminal. That is all.

### Windows: the Claude app, the Codex app, Cursor

On Windows TICK shows in the Claude app (drawn by Claude Code itself, through our plugin),
and over the Codex app and Cursor through a small program of ours that lays the line over
their window (the same as the Mac's desktop satellite, below). It needs Node 20+.
In PowerShell:

```powershell
iwr https://raw.githubusercontent.com/Hitid123/tick-client/main/install-windows.mjs -OutFile $env:TEMP\tick-install.mjs
node $env:TEMP\tick-install.mjs
```

It checks every file against `SHA256SUMS` like the Mac installer, adds our hook entries to
`%USERPROFILE%\.claude\settings.json` (backed up first), one marked block to Codex's
`config.toml` and three entries to Cursor's `hooks.json` where those apps are installed,
and one value under `HKCU\...\CurrentVersion\Run` so the strip starts at login. Codex asks
you to review a new hook once: allow ours. Removing it:
`node %USERPROFILE%\.tick\install-windows.mjs --uninstall`. In an editor on Windows, the
[TICK extension](https://marketplace.visualstudio.com/items?itemName=tick.gettick) is the way.

## Where it works

Only what works today gets a yes. No roadmap entries in this table.

| | Status |
| --- | --- |
| Claude Code, CLI, any terminal | **Yes** — this is the `statusLine` surface |
| Claude Code inside the VS Code / Cursor terminal | **Yes**, same CLI, same hook |
| **The Claude desktop app, macOS** | **Yes, through the desktop satellite** — see below. The app never runs a status line command (measured, not assumed), but it does run hooks, and a small program of ours draws the line |
| The Claude desktop app, Windows | **Yes**, drawn by Claude Code itself through our plugin |
| Claude Code's VS Code panel | **Yes**, through the [TICK extension](https://marketplace.visualstudio.com/items?itemName=tick.gettick) |
| Codex in the VS Code panel | **Yes**, the same extension. Codex asks you to approve our hook once, with `/hooks` |
| The Codex app, macOS and Windows | **Yes**, the desktop strip over its window. Codex asks you to review our hook once |
| Cursor's agent, macOS and Windows | **Yes**, the desktop strip over its window, from Cursor's own hooks |
| OpenCode | Not yet — the plugin reports its turns; nothing draws them yet |
| Codex CLI | No. Codex's `[tui] status_line` takes only its own built-in fields; there is no external-command hook and no plugin surface. Nothing to install into, and we will not patch it. Two upstream requests are open for the mechanism, and contributing it is how this changes |

## What is sent, and what is not

This is the whole reason to pick us, so here it is without hedging.

| Never leaves your machine | Sent to the server |
| --- | --- |
| Your prompts | `creative_id` — which line was displayed |
| Model responses | Number of impressions |
| File contents, file names, paths | Aggregated display time, in milliseconds |
| `transcript_path` and the transcript itself | `api_ms_delta` — how long the model worked |
| Your working directory | `model.id`, e.g. `claude-opus-5` |
| Git branches and remotes | A salted SHA-256 hash of the session id |
| Environment variables, API keys, tokens | A device fingerprint |
| Shell history | Your country, derived from the IP of the request |
| **Your raw `session_id`** | A one-way code of your IP address (below) |

**Your IP address is kept only as a code.** The server turns the address of each request
into a keyed one-way code and keeps that, against fraud, together with the name your client
gives itself (`node` for ours). The address itself is never stored, and the code cannot be
turned back into it.

**Clicks are the one exception, and only if you make one.** When a creative has a
destination, the line is a terminal hyperlink. Nothing is sent while it sits there. If you
Cmd+click it, your browser opens our redirect, which records that this creative was clicked
and forwards you to the advertiser. That request carries what any HTTP request carries —
your IP address among it. We store the click, its creative, and the time; we do not store
your IP or your browser's user agent. The advertiser sees a normal visit with `utm_source=tick`,
and never learns anything about your session. Set `"links": false` in `~/.tick/config.json`
to turn the hyperlink off entirely; the line still shows and still earns.

The session id is hashed with a random salt that is generated on your machine, stored in
`~/.tick/state/device.json`, and never transmitted. The server cannot link a session hash
back to a session id, and cannot correlate one across machines.

Everything above is enforced by a test that runs the real scripts, captures the real HTTP
payload, and fails if any forbidden string appears in it
([`tests/privacy.test.mjs`](../tests/privacy.test.mjs)). It is part of CI.

## Updates

TICK keeps itself current, so you never have to reinstall it:

- **The client in `~/.tick`** (the daemon, the status line, the hooks, the desktop strip)
  updates itself. Every few hours, while it runs, the daemon asks our server which files the
  current release is made of (a name and a SHA-256 each), downloads only the ones that
  differ from this repository, and keeps a file only if its hash is the one the server named.
  Forging an update would take both this repository and our server. Nothing about you is
  sent: these are plain downloads. Each file is checked before it goes live, swapped in
  whole, and the previous one is kept in `~/.tick/state/previous`. Not every machine updates
  at once: each waits its own few hours after a release, so a bad one reaches few. Your
  settings files are never touched by an update. To stay on what you have, set
  `"auto_update": false` in `~/.tick/config.json`.
- **The Claude Code plugin** updates when its marketplace has auto-update on. Our installers
  turn it on; if you installed the plugin yourself, run `/plugin` → **Marketplaces** →
  **tick** → **Enable auto-update** (Claude Code leaves it off for marketplaces that are not
  Anthropic's). The plugin reminds you once a week while it is off.
- **The VS Code / Cursor extension** updates through the marketplace, as every extension
  does.

## The desktop satellite (macOS)

The Claude desktop app has no status line to draw into, so on a Mac the installer adds a
small program of ours, `~/.tick/TICK.app`, started at login. While a desktop session is
working and Claude is the app in front, it lays a strip over the empty row under Claude's
message box: a quiet **Ad**, the offer, the promo code. It is a separate window on top.
Claude itself is not modified.

**What it can see.** The outer frame of the app's window — where it is and how big — which
macOS gives any program without asking. And one setting per app, so the strip matches the
theme you chose there: `userThemeMode` from Claude's `config.json`, `appearanceTheme` from
the `[desktop]` table of Codex's `config.toml`, and for Cursor the kind of theme (light or
dark) it records in its own `storage.json` for its splash screen. The Windows strip reads
the same three. That is all. It asks for **no
Accessibility and no Screen Recording permission**, so it cannot see what is inside the
window, your conversation included.

**What it adds.** Three hook entries in `~/.claude/settings.json` (`UserPromptSubmit`,
`Stop`, `SessionEnd`), in the same form the editor extension writes, so the two never
duplicate. The hook writes three fields — a timestamp, an event name, and `cd` for the
desktop app — and never opens the transcript. One login item,
`~/Library/LaunchAgents/dev.gettick.satellite.plist`. macOS will tell you that "TICK can
run in the background" and list it as from an unidentified developer: it is signed for
your Mac, not by an Apple developer account.

**What counts.** Five seconds of the strip on screen while the model works, as in the
terminal — and only while Claude is in front and every point of the strip is inside
Claude's window and on a display. Hidden, covered or dragged away, it earns nothing.

**Moving it.** Claude centres its message box between its side panels, which the satellite
cannot see. Drag the strip sideways to where it belongs; it stays in that row and
remembers. Resizing the window does not move it; opening or closing a panel might.
A click that does not drag opens the advertiser, through our redirect.

**Turning it off.** `"desktop": {"enabled": false}` in `~/.tick/config.json`, or install
with `--no-desktop`. `uninstall.sh` removes the app, the login item and our hook entries.

## How it works

Three pieces, split so that the fast one stays fast.

```
statusline.sh  ──reads──►  ~/.tick/state/current.json    (what to display)
  < 30 ms      ──writes─►  ~/.tick/state/ticks.ndjson    (what was displayed)
  no network
                                      │
                                      ▼
                             daemon.mjs  ◄── HTTPS ──►  api
                             (background, every 30 s)
```

`statusline.sh` runs on every status refresh, several times a minute. Claude Code kills a
status line script that is still running when the next update arrives, so it does no
network I/O and no thinking: it reads one file, prints one line, appends one tick, and
exits 0 — even when everything around it is broken.

`daemon.mjs` does the rest: it turns ticks into impressions, uploads them, keeps a queue
of creatives, and writes your balance to disk. It starts itself when needed and exits
15 minutes after Claude Code goes away.

## What counts as an impression

Five seconds of uninterrupted display of one creative, **inside a session where the model
is actually working**. Time is discarded when:

- more than 10 seconds pass between two ticks (the laptop was shut, the window was idle);
- the creative changed between two ticks;
- `cost.total_api_duration_ms` has not grown in the last 120 seconds.

That last rule is the point. An open, forgotten terminal earns nothing. Faking impressions
means genuinely burning tokens, which costs more than it pays.

## Your earnings and payouts

- In Claude Code: type `/tick-dashboard`.
- In VS Code or Cursor: run **TICK: Open dashboard**.
- From a terminal: `node ~/.tick/daemon.mjs --dashboard`.

Each opens https://gettick.dev/dashboard, signed in as this computer. Your
device token never goes into the address: the page opens with a code that
works once, within five minutes. There you see what you have earned and ask
for a payout from $5. You can also make it an account (GitHub, Google or an
email), to see it from any browser and add your other computers to one
balance.

Questions, a payout that did not arrive, anything else: **support@gettick.dev**.

## Your own line

Unsold inventory goes to you. Put this in `~/.tick/config.json`:

```json
{ "own_line": "hire me: dev@example.com" }
```

Up to 60 characters. It appears only when no paid creative is queued, only to you, and it
earns nothing. Other people's custom lines are never shown to you.

It also joins the spinner's rotation — the word that cycles while Claude works. We append
to Claude Code's own verbs rather than replacing them, so the spinner still reads as
Claude Code's with your line as an occasional guest. Milestones ("you earned $10") go
there too.

A paid line takes the spinner too, and takes it first: a sold creative replaces the
rotation, your own line and milestones only fill in when nothing is sold, and with nothing
to show at all the key is removed and Claude Code's own words come back.

Nothing extra is billed for that. The impression is already counted on the status line,
where there is a way to measure it; the spinner cannot report what it displayed, so it is
a second placement the advertiser gets for free rather than a second sale.

The key is written as `{"mode": "append", "verbs": ["your line"]}` — the shape Claude
Code's own settings schema accepts. The published settings reference shows a plain array;
that form is rejected and does nothing, which is worth knowing if you ever set it by hand.

Rules we hold ourselves to for that one key:

- we append, never replace, and `mode: "append"` is Claude Code's own mechanism, so its
  verbs stay whatever it decides they are;
- we write only when the value would actually change, which is once when you set a line
  and once per milestone — not on a schedule;
- if `spinnerVerbs` holds anything that is not exactly what we wrote, it is yours now and
  we never touch it again;
- `"spinner": false` in `~/.tick/config.json` switches it off;
- uninstall removes only what we put there.

## Files

| Path | What it is |
| --- | --- |
| `~/.tick/statusline.sh` | What Claude Code runs |
| `~/.tick/nojq.sh` | Degraded parser, used only if `jq` disappears |
| `~/.tick/daemon.mjs` | Background process |
| `~/.tick/config.json` | Your settings: `own_line`, `api_base` |
| `~/.tick/state/current.json` | The line being displayed right now |
| `~/.tick/state/ticks.ndjson` | Local display log, consumed and cleared every 30 s |
| `~/.tick/state/balance.json` | Last known balance, in micro-dollars |
| `~/.tick/state/device.json` | Device id and the hashing salt. Not synced anywhere |
| `~/.tick/settings.backup.*.json` | Your `settings.json`, as it was before install |
| `~/.tick/hook.mjs` | The activity hook, Mac only: three fields per event, no transcript |
| `~/.tick/state/activity/` | One file per session from the hook: time, event, agent |
| `~/.tick/TICK.app` | The desktop satellite, Mac only |
| `~/.tick/state/desktop-placement.json` | Where you dragged the desktop strip |
| `~/Library/LaunchAgents/dev.gettick.satellite.plist` | Starts the satellite at login, Mac only |

## Terminals

The line adapts to what the terminal actually supports. Nothing here needs configuring.

| Situation | What you get |
| --- | --- |
| Any 256-colour terminal (iTerm2, Terminal.app, Alacritty, kitty, WezTerm, Windows Terminal, VS Code) | `▌` muted, the offer bright for two seconds and then a step down, the advertiser's name and promo code in their colour (amber unless they chose another) |
| `NO_COLOR` set to anything, including empty | The same line with no escape sequences |
| `TERM=dumb`, or `TERM` unset | No escape sequences |
| `LANG`/`LC_ALL` set to `C`, `POSIX` or an 8-bit charset | ASCII throughout: `\|` instead of `▌`, `~` instead of `…`, `-` instead of `·` |
| `LANG` unset entirely | UTF-8, which is what every modern terminal does |

Width is measured in **terminal cells, not characters**. CJK and emoji take two cells,
combining marks and variation selectors take none, and ANSI sequences take none. A creative
in Japanese is truncated at the same visual width as one in English, and a wide glyph that
would straddle the boundary is dropped rather than split. The line cannot wrap onto a
second row, which is what a status line looks like when it crashes.

Colour is decided from the environment, never from `isatty`: the script's stdout is a pipe
into Claude Code, so a tty check would disable colour for everybody.

## Known trade-offs

**The footer gets quieter.** With any status line configured, Claude Code stops showing
most footer hints: `esc to interrupt`, the `? for shortcuts` fallback, and the
`hold space to speak` dictation hint. That is upstream behaviour for every status line,
not something we add — but you will notice it, so we would rather say it here than have
you discover it. `esc` still interrupts; only the reminder is gone.

**The folder must be trusted.** Until you accept workspace trust, Claude Code refuses to
run any status line command and the line stays empty. `claude --debug` says
`Status line command skipped: workspace trust not accepted`.

**We never patch Claude Code.** No modified `cli.js`, no touched install, no injected
webview. Outside `~/.tick` we write the `statusLine` field in `~/.claude/settings.json`,
backed up first, and on a Mac three hook entries there and one login item. The desktop
strip is our own window laid over Claude's, not a change to Claude.

## Troubleshooting

```bash
# Is the line configured?
jq '.statusLine' ~/.claude/settings.json

# What would the line print right now?
echo '{"session_id":"x","cost":{"total_api_duration_ms":1,"total_duration_ms":1}}' \
  | ~/.tick/statusline.sh

# Is the daemon alive, and what does it say?
cat ~/.tick/state/daemon.pid && tail ~/.tick/state/daemon.log
```

An empty line is a valid state, not a failure: it means there is nothing to show.

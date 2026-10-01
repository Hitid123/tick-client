# TICK client

A one-line ad marketplace that lives in the Claude Code status line. You see a short
line, the advertiser pays, and **70% of the revenue is yours**.

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

Either way it downloads five files, checks them against published `SHA256SUMS`, and stops
without installing anything if a checksum does not match. It needs no root. From a clone,
skip the download: `cd client && ./install.sh`.

Removing it is one command and leaves nothing behind:

```bash
~/.tick/uninstall.sh
```

Requirements: `jq`, Node 20+, and a terminal. That is all.

## Where it works

Only what works today gets a yes. No roadmap entries in this table.

| | Status |
| --- | --- |
| Claude Code, CLI, any terminal | **Yes** — this is the `statusLine` surface |
| Claude Code inside the VS Code / Cursor terminal | **Yes**, same CLI, same hook |
| **The Claude desktop app** | **No.** It does not run a status line command. Measured, not assumed: the client was installed on one and the script was never invoked |
| Claude Code's VS Code panel | No, not yet attempted |
| OpenCode | No, planned — the TUI plugin surface exists |
| Codex CLI | No. Codex's `[tui] status_line` takes only its own built-in fields; there is no external-command hook and no plugin surface. Nothing to install into, and we will not patch it. Two upstream requests are open for the mechanism, and contributing it is how this changes |
| Cursor's own agent | No, it exposes nothing |

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
| **Your raw `session_id`** | |

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

**No advertisement ever goes in the spinner.** Not because we could not: the setting
allows it. Because that slot is where the agent says what it is doing, and an ad sitting
there reads as the agent doing it. There is also no way for that surface to report what it
displayed, so billing for it would be billing for a guess.

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

## Terminals

The line adapts to what the terminal actually supports. Nothing here needs configuring.

| Situation | What you get |
| --- | --- |
| Any 256-colour terminal (iTerm2, Terminal.app, Alacritty, kitty, WezTerm, Windows Terminal, VS Code) | `▸` in coral, text in your terminal's own colour |
| `NO_COLOR` set to anything, including empty | The same line with no escape sequences |
| `TERM=dumb`, or `TERM` unset | No escape sequences |
| `LANG`/`LC_ALL` set to `C`, `POSIX` or an 8-bit charset | ASCII throughout: `>` instead of `▸`, `~` instead of `…`, `-` instead of `·` |
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
webview. The only thing we write outside `~/.tick` is one `statusLine` field in
`~/.claude/settings.json`, and it is backed up first.

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

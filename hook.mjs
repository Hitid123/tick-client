#!/usr/bin/env node
// TICK activity hook.
//
// Registered on three moments and nothing else: a prompt was submitted, the
// turn ended, the session ended. Its whole job is to leave a three-field note
// saying "a turn started" or "a turn ended" and which agent it was, because
// the surfaces that draw the line outside a terminal — the editor's status
// bar, the desktop strips — have no stdin and therefore no cost figure to
// watch, the way statusline.sh watches cost.total_api_duration_ms.
//
// One script for every agent that has hooks, each with its own names:
//
//   Claude Code, Codex, Devin   UserPromptSubmit / Stop / SessionEnd, session_id
//   Cursor                      beforeSubmitPrompt / stop / sessionEnd, conversation_id
//
// Which agent ran us is decided from the environment the agent runs hooks in,
// not from which settings file registered us: Devin and Cursor both pick up
// Claude Code's own hook file, so the `cc` entry fires for them too, and the
// tag has to say who really asked.
//
//   cc  Claude Code (terminal, editor)     cd  Claude Code in the Claude app
//   cx  Codex (terminal, editor)           xd  Codex in the Codex app
//   cu  Cursor's agent                     dv  Devin (formerly Windsurf)
//
// OpenCode has no command hooks; its plugin (opencode-plugin.js) writes the
// same note itself, tagged `oc`.
//
// Contract, in the same spirit as the status line (TZ section 2, 4.1):
//   - no network, ever;
//   - prints nothing on stdout, with one exception below. For UserPromptSubmit
//     anything printed is injected into the user's conversation as context, so
//     silence is not tidiness here, it is correctness;
//   - ALWAYS exits 0, and never blocks a prompt or a stop. A hook that fails
//     loudly is a hook that makes someone else's tool look broken;
//   - writes exactly {ts, ev, ag} and never anything else.
//
// The exception: Cursor reads a JSON answer from beforeSubmitPrompt and stop,
// so it gets the one that changes nothing, {"continue": true} and {}.
//
// What it deliberately does NOT do: open transcript_path. The payload hands us
// the path to the user's conversation with the model, and reading it is
// exactly the thing we criticise the competitor for. Not now, not later.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Every agent's name for the three moments, mapped to one vocabulary.
//
// PostToolUse is the fourth, and it means "still working". A turn knows only
// its start and its end, so the surfaces gave a turn ten minutes and then took
// it for dead — and an agent working through a long task lost its line after
// ten minutes, in the middle of the work (the owner's Claude app, 08.10). Every
// tool call now renews the turn. Claude Code runs this one with async: true, in
// the background, so it costs the agent nothing.
const EVENTS = {
  UserPromptSubmit: 'UserPromptSubmit', Stop: 'Stop', SessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop', sessionEnd: 'SessionEnd',
  PostToolUse: 'UserPromptSubmit',
};
const STARTED = Date.now();

/**
 * Who is running this hook, from what each agent says about itself:
 *   Cursor puts cursor_version into every payload, and uses its own event names;
 *   Devin sets DEVIN_PROJECT_DIR for its hooks;
 *   an app launched by macOS carries its bundle id in __CFBundleIdentifier, and
 *   so do the hooks it starts: that is how the Codex app is told from the
 *   Codex CLI, which runs the same hook from the same config.toml;
 *   Claude Code says claude-desktop in CLAUDE_CODE_ENTRYPOINT inside the app.
 */
function agentOf(arg, env, payload, raw) {
  if (payload.cursor_version || raw === 'beforeSubmitPrompt' || raw === 'stop' || raw === 'sessionEnd') return 'cu';
  if (env.DEVIN_PROJECT_DIR) return 'dv';
  if (arg === 'cx') {
    // macOS: the bundle id, when there is one, settles it. Windows has none;
    // the Codex app starts its engine with CODEX_INTERNAL_ORIGINATOR_OVERRIDE
    // set to "Codex" (seen on the running Mac app-server on 08.10), and the
    // hooks it runs inherit it.
    if (env.__CFBundleIdentifier) return env.__CFBundleIdentifier === 'com.openai.codex' ? 'xd' : 'cx';
    return env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'Codex' ? 'xd' : 'cx';
  }
  return env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'cd' : 'cc';
}

try {
  const home = process.env.TICK_HOME || join(homedir(), '.tick');
  const state = join(home, 'state');
  // No state directory means TICK is not installed on this machine. Leaving
  // files behind for a tool that is not here would be litter.
  if (!existsSync(state)) process.exit(0);

  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch { /* no stdin: nothing to record */ }
  const payload = JSON.parse(input || '{}');

  const raw = String(payload.hook_event_name ?? '');
  const ev = Object.prototype.hasOwnProperty.call(EVENTS, raw) ? EVENTS[raw] : '';
  const ag = agentOf(String(process.argv[2] ?? ''), process.env, payload, raw);
  if (ag === 'cu') {
    if (raw === 'beforeSubmitPrompt') process.stdout.write('{"continue":true}');
    else if (raw === 'stop') process.stdout.write('{}');
  }
  if (!ev) process.exit(0);

  // The session id becomes a file name, so anything that is not plainly an id
  // is treated as no id at all.
  const sid = String(payload.session_id ?? payload.conversation_id ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) process.exit(0);

  const dir = join(state, 'activity');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const file = join(dir, `${sid}.json`);
  // A heartbeat runs in the background and can land after the turn's own Stop.
  // A Stop written since this process started is newer news: leave it.
  if (raw === 'PostToolUse') {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      if (prev.ev !== 'UserPromptSubmit' && prev.ts >= STARTED) process.exit(0);
    } catch { /* no mark yet */ }
  }
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ev, ag }));
  renameSync(tmp, file);
} catch {
  // Whatever went wrong, it is not worth a line of red text in someone's
  // editor. The panel simply shows nothing until the next turn.
}

process.exit(0);

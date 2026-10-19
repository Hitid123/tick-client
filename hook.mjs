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
//   - prints nothing on stdout, with three exceptions below (Cursor, Cline and
//     Antigravity each read an answer, and get the one that changes nothing).
//     For Claude Code's UserPromptSubmit anything printed is injected into the
//     user's conversation as context, so silence is not tidiness here, it is
//     correctness;
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
//
// Cursor runs the same entry: it loads Claude Code's hook file too and maps
// PostToolUse to its own postToolUse step, under its own camelCase name (read
// from Cursor 3.23's claude-code-types, 09.10; on the owner's Windows PC it
// ran ours 7 and 12 times in two turns). Without the second spelling those
// runs renewed nothing, and a long Cursor turn lost its line at ten minutes.
const EVENTS = {
  UserPromptSubmit: 'UserPromptSubmit', Stop: 'Stop', SessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop', sessionEnd: 'SessionEnd',
  PostToolUse: 'UserPromptSubmit', postToolUse: 'UserPromptSubmit',
  // Antigravity (2026-10-16): before and after each model call, and its Stop.
  PreInvocation: 'UserPromptSubmit', PostInvocation: 'UserPromptSubmit',
  // Cline: a task starting, resuming or completing; UserPromptSubmit and
  // PostToolUse are spelled as Claude Code's.
  TaskStart: 'UserPromptSubmit', TaskResume: 'UserPromptSubmit', TaskComplete: 'Stop', TaskCancel: 'Stop',
};
const HEARTBEATS = new Set(['PostToolUse', 'postToolUse', 'PostInvocation']);
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
  // Registered by name for agents that give themselves away no other way.
  if (arg === 'ag' || arg === 'cl') return arg;
  if (payload.cursor_version || raw === 'beforeSubmitPrompt' || raw === 'stop' || raw === 'sessionEnd') return 'cu';
  if (env.DEVIN_PROJECT_DIR) return 'dv';
  // Codex brings Claude Code's hooks over into its own hooks.json when it
  // imports settings, ours included, still saying `cc`. Run by the Codex app,
  // it is the Codex app's turn (19.10).
  if (arg === 'cc' && (env.__CFBundleIdentifier === 'com.openai.codex'
    || /^Codex\b/.test(String(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? ''))
    || /^OpenAI\.Codex/.test(String(env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY ?? '')))) arg = 'cx';
  if (arg === 'cx') {
    // macOS: the bundle id, when there is one, settles it. Windows has none;
    // the Codex app starts its engine with CODEX_INTERNAL_ORIGINATOR_OVERRIDE
    // and the hooks it runs inherit it, but the value is not the bare "Codex"
    // the Mac app-server showed on 08.10: on the owner's Windows PC (09.10) the
    // app's Stop hook ran with CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop,
    // so an equality test called the app the CLI and every app turn came in as
    // cx. Match the family instead. Failing that, CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY
    // is set only inside the packaged app (OpenAI.Codex_2p2nqsd0c76g0 there).
    if (env.__CFBundleIdentifier) return env.__CFBundleIdentifier === 'com.openai.codex' ? 'xd' : 'cx';
    if (/^Codex\b/.test(String(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? ''))) return 'xd';
    return /^OpenAI\.Codex/.test(String(env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY ?? '')) ? 'xd' : 'cx';
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
  // Cursor on Windows does not hand us the payload on a plain pipe. It writes
  // it to %TEMP%\cursor-hook-payload-*.json and runs our command through
  // Windows PowerShell as
  //   Get-Content -LiteralPath '<file>' -Raw | & { $input | node hook.mjs cu }
  // and PowerShell prefixes a UTF-8 BOM to the bytes it writes into a native
  // process's stdin: measured on the owner's Windows 10 PC, 09.10, stdin began
  // ef bb bf 7b. U+FEFF is a syntax error to JSON.parse, the catch at the
  // bottom of this file swallowed it, and so every Cursor turn was dropped in
  // silence. Strip it, and the CRLF the same pipeline appends.
  const payload = JSON.parse(input.replace(/^\uFEFF+/, '').trim() || '{}');

  // Antigravity names no event in its payload, so ours says it on the command
  // line; Cline calls it hookName.
  const raw = String(payload.hook_event_name ?? payload.hookName ?? process.argv[3] ?? '');
  const ev = Object.prototype.hasOwnProperty.call(EVENTS, raw) ? EVENTS[raw] : '';
  const ag = agentOf(String(process.argv[2] ?? ''), process.env, payload, raw);
  if (ag === 'cu') {
    if (raw === 'beforeSubmitPrompt') process.stdout.write('{"continue":true}');
    else if (raw === 'stop') process.stdout.write('{}');
  }
  // Cline reads an answer from every hook; this one changes nothing.
  if (ag === 'cl') process.stdout.write('{"cancel":false}');
  // Antigravity takes an empty object as "nothing to add".
  if (ag === 'ag') process.stdout.write('{}');
  if (!ev) process.exit(0);

  // The session id becomes a file name, so anything that is not plainly an id
  // is treated as no id at all.
  const sid = String(payload.session_id ?? payload.conversation_id ?? payload.conversationId ?? payload.taskId ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) process.exit(0);

  const dir = join(state, 'activity');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const file = join(dir, `${sid}.json`);
  // A heartbeat runs in the background and can land after the turn's own Stop.
  // A Stop written since this process started is newer news: leave it.
  if (HEARTBEATS.has(raw)) {
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

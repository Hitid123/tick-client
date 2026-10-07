#!/usr/bin/env node
// TICK activity hook.
//
// Registered by the editor extension on three events and on nothing else:
// UserPromptSubmit, Stop, SessionEnd. Its whole job is to leave a three-field
// note saying "a turn started" or "a turn ended" and which agent it was,
// because the editor panel has no stdin and therefore no cost figure to watch,
// the way statusline.sh watches cost.total_api_duration_ms in the terminal.
//
// Both agents we support use the same three event names and hand the hook the
// same `hook_event_name` field, so one script serves both. Which agent called
// is passed as an argument at registration time rather than guessed: Claude
// Code is `cc`, Codex is `cx`.
//
// Contract, in the same spirit as the status line (TZ section 2, 4.1):
//   - no network, ever;
//   - prints nothing on stdout. For UserPromptSubmit anything printed is
//     injected into the user's conversation as context, so silence is not
//     tidiness here, it is correctness;
//   - ALWAYS exits 0. A hook that fails loudly is a hook that makes someone
//     else's tool look broken;
//   - writes exactly {ts, ev, ag} and never anything else.
//
// What it deliberately does NOT do: open transcript_path. The hook payload
// hands us the path to the user's conversation with the model, and reading it
// is exactly the thing we criticise the competitor for. Not now, not later.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EVENTS = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);

try {
  const home = process.env.TICK_HOME || join(homedir(), '.tick');
  const state = join(home, 'state');
  // No state directory means TICK is not installed on this machine. Leaving
  // files behind for a tool that is not here would be litter.
  if (!existsSync(state)) process.exit(0);

  let input = '';
  try { input = readFileSync(0, 'utf8'); } catch { /* no stdin: nothing to record */ }
  const payload = JSON.parse(input || '{}');

  const ev = String(payload.hook_event_name ?? '');
  if (!EVENTS.has(ev)) process.exit(0);

  const arg = String(process.argv[2] ?? '');
  const ag = arg === 'cx' || arg === 'cc' ? arg : 'cc';

  // The session id becomes a file name, so anything that is not plainly an id
  // is treated as no id at all.
  const sid = String(payload.session_id ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) process.exit(0);

  const dir = join(state, 'activity');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const file = join(dir, `${sid}.json`);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ev, ag }));
  renameSync(tmp, file);
} catch {
  // Whatever went wrong, it is not worth a line of red text in someone's
  // editor. The panel simply shows nothing until the next turn.
}

process.exit(0);

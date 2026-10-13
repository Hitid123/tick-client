// TICK activity plugin for OpenCode.
//
// Dual entrypoint: OpenCode v1 loads the named `TickActivity` export, v2
// loads the default export (a definition with an id and a setup function).
// Both turn the same events into the same three-field note hook.mjs writes
// for every other agent:
//
//   v2 execution engine        session.execution.started            -> UserPromptSubmit
//                             session.execution.succeeded/failed/
//                               interrupted                        -> Stop
//   v1 status (and any flow    session.status { type: "busy" }      -> UserPromptSubmit
//   that still publishes it)   session.status { type: "idle" }      -> Stop
//   v1 deprecated              session.idle                         -> Stop
//   v2 session end             session.deleted                      -> SessionEnd
//
// A v1 `opencode run` gave busy, busy, busy, idle, then session.idle, each
// with properties.sessionID ("ses_…"); a v2 run gives execution.started and
// execution.succeeded. Nothing else in the event is looked at; message
// events, which carry the conversation, are not even opened.
//
// Same contract as the hook: no network, never throws into OpenCode, writes
// exactly {ts, ev, ag: 'oc'} into ~/.tick/state/activity, and nothing at all
// when TICK is not installed. The TUI footer (plugins/tick/ on v2) draws the
// line and appends ticks; this file never draws and never counts.

import { writeFileSync, renameSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.TICK_HOME || join(homedir(), '.tick');
const STATE = join(HOME, 'state');

function mark(sessionId, ev) {
  try {
    if (!existsSync(STATE)) return;
    const sid = String(sessionId ?? '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) return;
    const dir = join(STATE, 'activity');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sid}.json`);
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ev, ag: 'oc' }));
    renameSync(tmp, file);
  } catch { /* never a reason to disturb OpenCode */ }
}

function daemonAlive() {
  try {
    const raw = readFileSync(join(STATE, 'daemon.pid'), 'utf8').trim();
    if (!/^[0-9]+$/.test(raw)) return false;
    process.kill(Number(raw), 0);
    return true;
  } catch { return false; }
}

/** Same contract as statusline.sh: start the daemon, never wait for it. */
function ensureDaemon() {
  try {
    const daemon = join(HOME, 'daemon.mjs');
    if (!existsSync(daemon) || daemonAlive()) return;
    let nodeBin = 'node';
    try { nodeBin = readFileSync(join(HOME, 'node-path.txt'), 'utf8').trim() || 'node'; } catch { /* not written on POSIX */ }
    const child = spawn(nodeBin, [daemon], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, TICK_HOME: HOME },
    });
    child.unref();
  } catch { /* the next turn tries again */ }
}

function handleEvent(type, payload) {
  if (!type) return;
  if (type === 'session.execution.started') {
    mark(payload?.sessionID, 'UserPromptSubmit');
    ensureDaemon();
    return;
  }
  if (
    type === 'session.execution.succeeded' ||
    type === 'session.execution.failed' ||
    type === 'session.execution.interrupted'
  ) {
    mark(payload?.sessionID, 'Stop');
    return;
  }
  if (type === 'session.deleted') {
    mark(payload?.sessionID, 'SessionEnd');
    return;
  }
  if (type === 'session.status') {
    const status = payload?.status?.type;
    if (status === 'busy') {
      mark(payload?.sessionID, 'UserPromptSubmit');
      ensureDaemon();
    } else if (status === 'idle') {
      mark(payload?.sessionID, 'Stop');
    }
    return;
  }
  if (type === 'session.idle') {
    mark(payload?.sessionID, 'Stop');
    return;
  }
  // Heartbeat: every model step renews a long turn, so one longer than ten
  // minutes keeps its line mid-work (PostToolUse's role elsewhere).
  if (type === 'session.step.started') {
    mark(payload?.sessionID, 'UserPromptSubmit');
  }
}

// OpenCode v1: named plugin functions returning hook maps.
export const TickActivity = async () => ({
  event: async ({ event }) => {
    try {
      handleEvent(event?.type, event?.properties ?? {});
    } catch { /* never into OpenCode */ }
  },
});

// OpenCode v2: a default definition with an id and setup. Plain object, no
// framework import: v1 ignores it, v2 validates the shape. A distinct id from
// the directory plugin (tick), so the two can coexist — marking the same
// three fields twice is the same note, and the daemon pid file is a lock.
// When the directory plugin is installed next to this file it owns v2 and
// this setup stays silent, so one turn is never subscribed twice.
function dirPluginPresent() {
  try {
    const here = fileURLToPath(new URL('./tick/index.ts', import.meta.url));
    return existsSync(here);
  } catch { return false; }
}

export default {
  id: 'tick-activity',
  async setup(ctx) {
    try {
      if (dirPluginPresent()) return () => {};
    } catch { /* fall through to active */ }
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // v2 envelopes the payload in `data`, v1 in `properties`.
            handleEvent(event?.type, event?.data ?? event?.properties ?? {});
          } catch { /* one bad event is not worth a broken plugin */ }
        }
      } catch { /* aborted on unload */ }
    })();
    return () => controller.abort();
  },
};

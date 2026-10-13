// TICK server plugin for OpenCode v2.
//
// Writes the same three-field note hook.mjs writes for every other agent:
// execution started -> UserPromptSubmit, execution finished -> Stop.
// The TUI plugin (tui.tsx) draws the line and appends ticks; this file never
// draws and never counts, so `opencode run` (no TUI, nothing on screen) earns
// nothing — showing an ad is free, charging for it is not.
//
// Contract, like the hook: no network, never throws into OpenCode, writes
// exactly {ts, ev, ag} into ~/.tick/state/activity, and nothing at all when
// TICK is not installed (no ~/.tick/state directory).
//
// v1 compatibility: OpenCode 1.18.29+ also loads this file's `server()`
// export; older v1 keeps using opencode-plugin.js (TickActivity).

import { writeFileSync, renameSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Plugin } from '@opencode/plugin';
import { safeSessionId } from './shared.js';

function tickHome() {
  return process.env.TICK_HOME || join(homedir(), '.tick');
}

function mark(home, sessionId, ev) {
  try {
    const state = join(home, 'state');
    if (!existsSync(state)) return;
    const sid = safeSessionId(sessionId);
    if (!sid) return;
    const dir = join(state, 'activity');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sid}.json`);
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ev, ag: 'oc' }));
    renameSync(tmp, file);
  } catch { /* never a reason to disturb OpenCode */ }
}

function daemonAlive(home) {
  try {
    const raw = readFileSync(join(home, 'state', 'daemon.pid'), 'utf8').trim();
    if (!/^[0-9]+$/.test(raw)) return false;
    process.kill(Number(raw), 0);
    return true;
  } catch { return false; }
}

/** Same contract as statusline.sh: start the daemon, never wait for it. */
function ensureDaemon(home) {
  try {
    const daemon = join(home, 'daemon.mjs');
    if (!existsSync(daemon) || daemonAlive(home)) return;
    const nodePath = (() => {
      try {
        const p = readFileSync(join(home, 'node-path.txt'), 'utf8').trim();
        if (p) return p;
      } catch { /* not written on POSIX installs */ }
      return 'node';
    })();
    const child = spawn(nodePath, [daemon], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, TICK_HOME: home },
    });
    child.unref();
  } catch { /* the next turn tries again */ }
}

function handleEvent(home, event) {
  const type = event?.type;
  if (!type) return;
  // v2 execution engine (2.0.x, verified live): started -> working,
  // succeeded / failed / interrupted -> turn over.
  if (type === 'session.execution.started') {
    const sid = event.data?.sessionID ?? event.properties?.sessionID;
    mark(home, sid, 'UserPromptSubmit');
    ensureDaemon(home);
    return;
  }
  if (
    type === 'session.execution.succeeded' ||
    type === 'session.execution.failed' ||
    type === 'session.execution.interrupted'
  ) {
    const sid = event.data?.sessionID ?? event.properties?.sessionID;
    mark(home, sid, 'Stop');
    return;
  }
  // Heartbeat: every model step renews a long turn. Without it a turn
  // longer than ten minutes looks dead and loses its line mid-work —
  // the same role PostToolUse plays for Claude Code. No daemon wake here;
  // execution.started already did that, and this fires per step.
  if (type === 'session.step.started') {
    const sid = event.data?.sessionID ?? event.properties?.sessionID;
    mark(home, sid, 'UserPromptSubmit');
    return;
  }
  if (type === 'session.deleted') {
    const sid = event.data?.sessionID ?? event.properties?.sessionID;
    mark(home, sid, 'SessionEnd');
    return;
  }
  // v1 fallback (and any flow that still publishes status): busy -> working,
  // idle -> turn over. `data` is v2's envelope, `properties` is v1's; read
  // both, trust neither beyond the status word.
  if (type === 'session.status') {
    const payload = event.data ?? event.properties ?? {};
    const sid = payload.sessionID;
    const status = payload.status?.type;
    if (status === 'busy') {
      mark(home, sid, 'UserPromptSubmit');
      ensureDaemon(home);
    } else if (status === 'idle') {
      mark(home, sid, 'Stop');
    }
    return;
  }
  if (type === 'session.idle') {
    const payload = event.data ?? event.properties ?? {};
    mark(home, payload.sessionID, 'Stop');
  }
}

export default {
  ...Plugin.define({
    id: 'tick',
    async setup(ctx) {
      const home = tickHome();
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              handleEvent(home, event);
            } catch { /* one bad event is not worth a broken plugin */ }
          }
        } catch { /* aborted on unload */ }
      })();
      return () => controller.abort();
    },
  }),
  // v1 (1.18.29+): the same handler through the v1 `server()` entrypoint.
  // Older v1 uses opencode-plugin.js. Nothing here reads the conversation:
  // only the event type and the session id are looked at.
  async server() {
    const home = tickHome();
    return {
      event: async ({ event }) => {
        try {
          handleEvent(home, {
            type: event?.type,
            properties: event?.properties,
            data: event?.properties,
          });
        } catch { /* never into OpenCode */ }
      },
    };
  },
};

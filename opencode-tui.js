// TICK line for OpenCode's own interface (2026-10-19).
//
// OpenCode 1.x loads interface plugins listed in ~/.config/opencode/tui.json
// and lets them draw into named places ("slots"). This one draws into
// app_bottom, the bottom row of the whole window, the way Claude Code draws
// our status line: one short sponsored line, only while OpenCode's agent is
// working. Checked on the owner's Mac against OpenCode 1.18.35: a plugin loaded
// from an absolute path in tui.json, and its app_bottom text appeared beside
// the version number.
//
// What it does, and all it does:
//   - reads ~/.tick/state/current.json (the line the daemon chose) and the
//     activity marks our OpenCode plugin writes (opencode-plugin.js: a time,
//     an event, an agent tag; nothing from the conversation);
//   - shows the line while a turn is under way, nothing otherwise;
//   - every three seconds appends a tick to ~/.tick/state/ticks.ndjson, the
//     same record the editor writes, so the daemon counts it by the same rules
//     (five seconds while the model works and a person is at the computer);
//   - starts the daemon when it is not running.
// No network, ever; it never reads OpenCode's sessions or messages, and it
// never throws into OpenCode: anything wrong and the row is simply empty.

import { createElement, insertNode, insert, setProp, effect } from '@opentui/solid';
import { createRoot, createSignal, onCleanup } from 'solid-js';
import { readFileSync, readdirSync, appendFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.TICK_HOME || join(homedir(), '.tick');
const STATE = join(HOME, 'state');
const TICK_MS = 3000;
const TURN_MS = 10 * 60_000;
const TICKS_MAX = 2 * 1024 * 1024;
// The advertiser's colour by name, as the other surfaces draw it (server/lib/creative.ts).
const ACCENTS = { amber: '#FFB000', green: '#3DBE6E', teal: '#33D6C9', blue: '#5AA9FF', violet: '#B794FF', pink: '#FF6B9A', coral: '#FF8A3D' };

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** An OpenCode turn under way: our plugin marked one started in the last ten minutes and not stopped. */
export function turnUnderWay(marks, now) {
  return marks.some((m) => m && m.ag === 'oc' && m.ev === 'UserPromptSubmit' && typeof m.ts === 'number' && now - m.ts <= TURN_MS);
}

/** The paid line on screen now, or nothing. The daemon cleaned the text before it wrote it. */
export function liveLine(cur, now) {
  if (!cur || typeof cur.text !== 'string' || !cur.text || typeof cur.expires_at !== 'number' || cur.expires_at <= now) return null;
  return {
    cid: String(cur.creative_id ?? ''),
    text: cur.text + (typeof cur.promo_code === 'string' && cur.promo_code && !cur.text.includes(cur.promo_code) ? ` · ${cur.promo_code}` : ''),
    color: ACCENTS[cur.accent] ?? ACCENTS.amber,
  };
}

function marks() {
  const dir = join(STATE, 'activity');
  const out = [];
  try {
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) { const m = readJson(join(dir, f)); if (m) out.push(m); }
  } catch { /* no marks yet */ }
  return out;
}

function ensureDaemon() {
  try {
    const pid = Number(String(readFileSync(join(STATE, 'daemon.pid'), 'utf8')).trim());
    if (pid > 0) { process.kill(pid, 0); return; }
  } catch { /* not running, or never was */ }
  const daemon = join(HOME, 'daemon.mjs');
  if (!existsSync(daemon)) return;
  try {
    // `node`, not process.execPath: OpenCode runs on its own runtime.
    spawn('node', [daemon], { detached: true, stdio: 'ignore', env: { ...process.env, TICK_HOME: HOME } }).unref();
  } catch { /* the editor, the terminal or the next tick starts it */ }
}

function appendTick(tick) {
  try {
    const file = join(STATE, 'ticks.ndjson');
    try { if (statSync(file).size > TICKS_MAX) writeFileSync(file, ''); } catch { /* none yet */ }
    appendFileSync(file, `${JSON.stringify(tick)}\n`);
  } catch { /* a tick lost is a few seconds not counted, nothing worse */ }
}

export default {
  id: 'tick',
  tui: async (api) => {
    if (!existsSync(STATE)) return;   // TICK is not installed here: draw nothing
    createRoot(() => {
      const [line, setLine] = createSignal(null);
      // One stream per OpenCode window, `oc:`, so its ticks never mix with another surface's.
      const sid = `oc:${process.pid}-${Date.now().toString(36)}`;
      let counter = { api_ms: 0, dur_ms: 0, last: 0 };

      const step = () => {
        try {
          const now = Date.now();
          const working = turnUnderWay(marks(), now);
          const live = working ? liveLine(readJson(join(STATE, 'current.json')), now) : null;
          setLine(live);
          if (working) ensureDaemon();
          const elapsed = counter.last > 0 ? Math.max(0, Math.min(now - counter.last, TICK_MS * 2)) : 0;
          counter = { api_ms: counter.api_ms + (working ? elapsed : 0), dur_ms: counter.dur_ms + elapsed, last: now };
          // Unsold working time is written too (cid null): the fill measure counts it.
          if (working) appendTick({ ts: now, sid, cid: live ? live.cid : null, api_ms: counter.api_ms, dur_ms: counter.dur_ms, model: null });
        } catch { setLine(null); }
      };
      step();
      const timer = setInterval(step, TICK_MS);
      onCleanup(() => clearInterval(timer));

      api.slots.register({
        slots: {
          app_bottom(ctx) {
            const row = createElement('box');
            setProp(row, 'flexDirection', 'row');
            setProp(row, 'paddingLeft', 1);
            const ad = createElement('text');
            const text = createElement('text');
            insertNode(row, ad);
            insertNode(row, text);
            insert(ad, () => (line() ? 'Ad  ' : ''));
            insert(text, () => line()?.text ?? '');
            setProp(ad, 'fg', ctx.theme?.current?.textMuted ?? '#8A8782');
            // The colour follows the line: the advertiser's, whenever the line changes.
            effect(() => setProp(text, 'fg', line()?.color ?? ACCENTS.amber));
            return row;
          },
        },
      });
    });
  },
};

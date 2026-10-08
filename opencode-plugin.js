// TICK activity plugin for OpenCode.
//
// OpenCode has no command hooks; it loads plugins from
// ~/.config/opencode/plugins/ and hands them its events. This one turns two of
// them into the same three-field note hook.mjs writes for every other agent:
//
//   session.status { type: "busy" }   the model is working  -> UserPromptSubmit
//   session.status { type: "idle" }   the turn is over      -> Stop
//   session.idle                      the same, said again   -> Stop
//
// Checked against OpenCode 1.18.35 on 08.10: one `opencode run` gave busy,
// busy, busy, idle, then session.idle, each with properties.sessionID
// ("ses_…"). Nothing else in the event is looked at; message events, which
// carry the conversation, are not even opened.
//
// Same contract as the hook: no network, never throws into OpenCode, writes
// exactly {ts, ev, ag} into ~/.tick/state/activity, and nothing at all when
// TICK is not installed.

import { writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE = join(process.env.TICK_HOME || join(homedir(), '.tick'), 'state');

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

export const TickActivity = async () => ({
  event: async ({ event }) => {
    const type = event?.type;
    if (type !== 'session.status' && type !== 'session.idle') return;
    const props = event.properties ?? {};
    if (type === 'session.idle') return mark(props.sessionID, 'Stop');
    const status = props.status?.type;
    if (status === 'busy') mark(props.sessionID, 'UserPromptSubmit');
    else if (status === 'idle') mark(props.sessionID, 'Stop');
  },
});

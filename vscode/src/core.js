'use strict';
//
// TICK — the rules behind the editor status bar.
//
// No `vscode` import and no file I/O lives here: every function is a function
// of its arguments. That is deliberate. This file decides what gets displayed
// and what gets counted as money, and the terminal's equivalent rules are
// covered by tests — these have to be too.
//
// The extension is a second renderer, not a second client (vault:
// Совместимость → «Расширение — это второй рендерер»). It reads the same
// current.json the daemon already writes and appends to the same ticks.ndjson
// the daemon already drains. It knows nothing about the auction, the queue or
// the balance, and the server does not change for it at all.

/**
 * Mirrored from the daemon's DEFAULTS. These are not independent knobs: two
 * of them have to agree with the daemon or the money comes out wrong.
 *
 *   tick_ms          must stay well under the daemon's tick_max_gap_ms (10 s),
 *                    or every pair of ticks is discarded as a gap and the
 *                    publisher earns nothing while everything looks fine.
 *   active_window_ms the daemon's own window. Kept here only so we stop
 *                    appending ticks at the same moment it stops counting them.
 *   max_turn_ms      ours alone: how long a turn may stay "working" with no
 *                    closing event before we assume the session died.
 */
const PANEL_DEFAULTS = {
  tick_ms: 3000,
  active_window_ms: 120000,
  max_turn_ms: 600000,
  text_max: 60,
  claim_stale_ms: 15000,
};

/** How long an offer stays at full brightness. Terminal, editor and the
 *  landing's demo all use this same two seconds. */
const FRESH_MS = 2000;

/**
 * Events the hook reports. Turn boundaries only — see addHooks below.
 *
 * The same three names work for both agents we support, which is not luck:
 * Codex copied Claude Code's hook vocabulary, down to the PascalCase and the
 * {matcher, hooks} nesting. Verified against both installed builds, because a
 * shape taken from documentation is how the spinnerVerbs week happened.
 */
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd'];
const WORK_STARTS = 'UserPromptSubmit';

/**
 * Who was working. The panel does not care — a turn is a turn, and the line is
 * counted the same either way — but the tooltip should be able to say it, and a
 * publisher who cannot see what they are being paid for has only our word.
 *
 * Codex cannot show our line in its own terminal status line: that one is
 * assembled from built-in elements and takes no external command. In the editor
 * it does not have to. The renderer is the editor, and all we need from the
 * agent is "is the model running right now", which its hooks answer.
 */
const AGENTS = {
  cc: 'Claude Code', cx: 'Codex', cu: 'Cursor', dv: 'Devin', oc: 'OpenCode',
  cd: 'Claude', xd: 'Codex',
};

/**
 * Which editor this extension is running in, from vscode.env.appName. The
 * product names were read from the installed builds on 08.10: "Visual Studio
 * Code", "Cursor" (3.23), and "Devin" (1.126, which is what Windsurf became).
 */
function hostOf(appName) {
  const n = String(appName ?? '').toLowerCase();
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('devin') || n.includes('windsurf')) return 'devin';
  return 'vscode';
}

/**
 * Marks an editor window may count.
 *
 * A session in the Claude app (`cd`) or the Codex app (`xd`) is on screen in
 * that app, not in this window: the desktop strip draws and counts it, and
 * counting it here too would bill one display twice. An editor's own agent —
 * Cursor's, Devin's — is on screen only in that editor, so a VS Code window
 * open beside Cursor does not count Cursor's work. Claude Code, Codex and
 * OpenCode run inside any of these editors, so any of them may count those.
 */
function countsInEditor(mark, host = 'vscode') {
  if (!mark || typeof mark !== 'object') return false;
  if (mark.ag === 'cd' || mark.ag === 'xd') return false;
  if (mark.ag === 'cu') return host === 'cursor';
  if (mark.ag === 'dv') return host === 'devin';
  return true;
}

function agentName(tag) {
  return AGENTS[tag] ?? AGENTS.cc;
}

// ------------------------------------------------------------------ text

// OSC (hyperlink, title, clipboard) and CSI/SGR (colour): the same two escape
// families the terminal renderer strips. Here they would not colour anything,
// they would show up as literal garbage in the status bar.
//
// Built from escape sequences rather than written as literals so this file
// stays plain ASCII and survives every editor, diff and clipboard on the way.
const ESCAPES = new RegExp(
  '\\u001b(?:\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\[[0-9;]*[A-Za-z])',
  'g',
);
const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * Make server text safe to put in an editor status bar.
 *
 * The one risk here that the terminal does not have: VS Code reads `$(name)`
 * inside a status bar label as an icon. A creative containing `$(rocket)` would
 * render somebody else's glyph in our slot, and `$(sync~spin)` a spinning one,
 * which reads as the editor doing something. So the dollar-paren pair is broken
 * apart. Everything else matches the terminal's `clean`.
 */
function sanitizeText(value, max = PANEL_DEFAULTS.text_max) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ESCAPES, '')
    .replace(CONTROLS, ' ')
    .replace(/\$\(/g, '$ (')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Only our own http(s) links, and never with a quote or a control character. */
function safeUrl(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(s) ? s : '';
}

const SITE = 'https://gettick.dev';

/**
 * Where a publisher sees earnings and asks for a payout: the dashboard on the
 * same server the daemon talks to. Plain http only for a local dev server; any
 * other address that does not parse falls back to ours rather than to nothing.
 */
function dashboardUrl(apiBase) {
  try {
    const u = new URL(String(apiBase || ''));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return `${u.origin}/dashboard`;
  } catch { /* not a URL */ }
  return `${SITE}/dashboard`;
}

/** Whole micro-dollars to "1.23". Integer arithmetic, like the ledger. */
function usd(micros) {
  const n = typeof micros === 'number' && Number.isFinite(micros) ? micros : 0;
  const cents = Math.floor(n / 10000);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- rendering

/**
 * What the status bar should show right now.
 *
 * The fallback order is the terminal's, from TZ 4.4: a paid creative, then the
 * user's own line, then their balance, then nothing at all. `cid` is null for
 * everything except the paid creative, and a tick with a null cid is never
 * billed — which is the whole reason the own line is free to show.
 */
function render({ current, config, balance, now }) {
  const live =
    current && typeof current === 'object' &&
    typeof current.expires_at === 'number' && current.expires_at > now
      ? current
      : null;

  if (live) {
    const text = sanitizeText(live.text);
    if (text.length > 0) {
      return {
        text,
        cid: live.creative_id === null || live.creative_id === undefined
          ? null
          : String(live.creative_id),
        url: safeUrl(live.click_url),
        promo: sanitizeText(live.promo_code, 32),
        paid: true,
      };
    }
  }

  const own = sanitizeText(config && config.own_line);
  if (own.length > 0) return { text: own, cid: null, url: '', promo: '', paid: false };

  const available = balance && typeof balance.available === 'number' ? balance.available : 0;
  if (available > 0) {
    return { text: `TICK · $${usd(available)}`, cid: null, url: '', promo: '', paid: false };
  }

  return { text: '', cid: null, url: '', promo: '', paid: false };
}

// ----------------------------------------------------------- the label

/**
 * The label as it appears in the status bar.
 *
 * The marker is the block cursor the terminal client prints and the brand guide
 * fixes, not the editor's `$(triangle-right)` codicon. The codicon renders as a
 * filled play button, and a play button in a status bar promises that clicking
 * it runs something; ours opens an advertiser.
 *
 * A paid creative with somewhere to go gets a trailing external-link icon,
 * because a status bar item does not otherwise look clickable, and a click
 * nobody knows about is CTR we are hiding from ourselves. It appears only when
 * there is genuinely a link behind it.
 */
const MARKER = '\u258c';

function statusText(view) {
  if (!view || view.text.length === 0) return '';
  return view.paid && view.url
    ? `${MARKER} ${view.text} $(link-external)`
    : `${MARKER} ${view.text}`;
}

// ------------------------------------------------------------- setup state

/**
 * What the status bar shows before the activity hook is registered.
 *
 * Until it is, nothing is counted at all — the panel has no other way to know
 * the model is working. Leaving that to a single notification was a real bug,
 * not a rough edge: a toast gets dismissed, or collapses into the bell, and
 * then a publisher sits with an extension installed, earning nothing, with
 * nothing on screen to say why. The status bar is already in front of them, so
 * the status bar is where it belongs.
 */
function setupView(pending) {
  const names = pending.map(agentName).join(' and ');
  return {
    text: `${MARKER} TICK · finish setup`,
    tooltip: [
      '**TICK** · not counting anything yet',
      '',
      `One hook still has to be registered for ${names}, otherwise there is no way to know`,
      'when the model is working — and a line nobody can prove was on screen is a line we',
      'will not charge for.',
      '',
      'Click here to set it up. Your config file is backed up first, and nothing else is touched.',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------ tooltip

/**
 * Creative text goes into a Markdown hover, so it has to stop being Markdown
 * first. Without this, `[click here](http://somewhere-else)` in a creative
 * would render as a link we never validated, next to the one we did.
 */
function escapeMarkdown(value) {
  return String(value ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}

/**
 * The hover behind the status bar line.
 *
 * It names the advertiser link as a link, so the one actionable thing in the
 * line is actionable from the hover too and not only from a click on a status
 * bar item that does not look clickable. The link is built from the URL we
 * already validated, never from text the server sent; the text around it is
 * escaped. Nothing here is a trusted Markdown string, so no command: URI can
 * come back through this path.
 *
 * It also says, in plain words, whether this window is counting right now.
 * That sentence is the product: a publisher who cannot check what they are paid
 * for is in the same position as with the competitor, which is the position we
 * are selling our way out of.
 */
function tooltip(view, { counting = false, working = false, agent = null } = {}) {
  const lines = [];
  if (view.paid) {
    lines.push('**TICK** · sponsored');
    lines.push('');
    lines.push(escapeMarkdown(view.text));
    if (view.promo) lines.push(`Promo code: \`${escapeMarkdown(view.promo)}\``);
    if (view.url) lines.push(`[Open the advertiser](${view.url})`);
    lines.push('');
    lines.push('70% of the gross on this line is yours.');
    // Three states, not two, because there really are three. The daemon keeps
    // counting for two minutes after a turn ends — the line is still on screen
    // while the answer is being read, and that is display, not idling. Calling
    // that "not counting" would be a small lie in the one place a publisher
    // comes to check on us.
    if (counting && working) {
      lines.push(`Counting now — ${escapeMarkdown(agentName(agent))} is working.`);
    } else if (counting) {
      lines.push('Counting — the line is still on screen after a turn.');
    } else {
      lines.push('Counting nothing right now: no turn has run recently, or a terminal session is already counting it.');
    }
  } else {
    lines.push('**TICK** · nothing sold for this slot');
    lines.push('');
    lines.push(escapeMarkdown(view.text));
    lines.push('');
    lines.push('Your own line and your balance are never billed to anyone.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- activity

/**
 * Read one session's hook mark into "is the model working, and when did it last
 * work". This is the panel's replacement for the terminal's growing
 * `cost.total_api_duration_ms`, and the economic property is the same one: the
 * window only opens on a real turn, so inflating impressions still costs tokens.
 *
 * Hooks do not report cost or duration — checked against the installed build,
 * not the docs (vault: Совместимость → «Что хук отдаёт на самом деле»). Turn
 * boundaries are all we get, and they are enough.
 */
function activityOf(mark, now, cfg = PANEL_DEFAULTS) {
  if (!mark || typeof mark !== 'object' || typeof mark.ts !== 'number') {
    return { working: false, lastWorkTs: 0 };
  }
  if (mark.ev === WORK_STARTS) {
    // A turn with no closing event for max_turn_ms means the session died
    // mid-answer: a crash, a kill, a closed laptop. Keeping it "working" would
    // bill idle time, so it expires on its own.
    const alive = now - mark.ts <= cfg.max_turn_ms;
    return alive ? { working: true, lastWorkTs: now } : { working: false, lastWorkTs: mark.ts };
  }
  return { working: false, lastWorkTs: mark.ts };
}

/**
 * Does this session still deserve ticks?
 *
 * Yes, for active_window_ms after the model last worked — exactly as long as
 * the daemon would keep counting a terminal session. The ad is still on screen
 * while the answer is being read; that is display, not idling. Past the window
 * we stop appending, because the daemon's own activity check would start
 * dropping those deltas anyway and a tick nobody can count is just noise.
 */
function withinWindow(lastWorkTs, now, cfg = PANEL_DEFAULTS) {
  return lastWorkTs > 0 && now - lastWorkTs <= cfg.active_window_ms;
}

/**
 * Is this offer still new enough to be shown at full brightness?
 *
 * Two seconds, the same as the terminal and the same as the landing's demo.
 * The fade happens once per offer and does not repeat: there is movement
 * exactly when the line changed, and it is gone the moment it has been read.
 *
 * `shown_at` is written by the daemon when the creative is rotated in, so the
 * shade falls out of a number the client already has — no timer of its own and
 * nothing extra to keep in sync.
 */
function offerIsFresh(current, now) {
  if (!current || typeof current.shown_at !== 'number') return false;
  return now - current.shown_at < FRESH_MS;
}

/**
 * Is this editor window one the person is actually working in?
 *
 * The problem this closes showed up during live verification: an agent session
 * anywhere on the machine — a terminal, the desktop app — makes the model
 * "work", and every open editor window would have counted that as display. The
 * line genuinely is on their status bar, but nobody was looking at it.
 *
 * The terminal cannot tell the difference and we accept that there. Here we
 * can, so we should: paying for a window the person had minimised is paying for
 * a guess, and a guess is what we accuse the competitor of selling.
 *
 * Not "focused right now", though. A long turn where somebody glances at a
 * browser while waiting is still display, and demanding focus on the exact
 * second would make the panel earn less than the terminal for identical
 * behaviour. The window stays live for the same two minutes the daemon already
 * keeps a session alive for.
 */
function windowIsLive(lastFocusedTs, now, cfg = PANEL_DEFAULTS) {
  return lastFocusedTs > 0 && now - lastFocusedTs <= cfg.active_window_ms;
}

// ------------------------------------------------------------------- ticks

/**
 * Advance one session's counter and produce the tick to append.
 *
 * `api_ms` is synthesised: it grows by wall time only while the model is
 * working. That is what makes the daemon's unmodified `aggregate()` treat the
 * panel exactly as it treats the terminal — it looks for a growing api figure
 * and finds one precisely when there was real work. No change to the money
 * path, no change to the server.
 *
 * Elapsed time is clamped: a laptop lid closed for two hours must not arrive
 * as two hours of model work.
 */
function advance(prev, { sid, cid, working, now, cfg = PANEL_DEFAULTS }) {
  const base = prev ?? { api_ms: 0, dur_ms: 0, lastTickTs: 0 };
  const raw = base.lastTickTs > 0 ? now - base.lastTickTs : 0;
  const elapsed = Math.max(0, Math.min(raw, cfg.tick_ms * 2));

  const state = {
    api_ms: base.api_ms + (working ? elapsed : 0),
    dur_ms: base.dur_ms + elapsed,
    lastTickTs: now,
  };

  return {
    state,
    tick: {
      ts: now,
      sid,
      cid,
      api_ms: state.api_ms,
      dur_ms: state.dur_ms,
      // Hooks carry no model id, and the only place it could be read from is
      // the transcript. We do not open the transcript. Ever.
      model: null,
    },
  };
}

/** `vsc:` keeps panel ticks in their own session stream, never interleaved
 *  with a terminal session's ticks for the same id — mixed deltas would
 *  corrupt both. The daemon salts and hashes it before it leaves the machine. */
function panelSid(sessionId) {
  return `vsc:${sessionId}`;
}

/** Session ids become file names, so anything that is not one is not a session. */
function safeSessionId(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : '';
}

// ---------------------------------------------------------------- spinner

/**
 * What the editor panel's spinner should say.
 *
 * The daemon already writes `spinnerVerbs` into ~/.claude/settings.json, and
 * that is the right place — for the CLI. The panel does not read it. Checked
 * against the installed build: its webview is handed `spinnerVerbsConfig` from
 * `vscode.workspace.getConfiguration("claudeCode").get("spinnerVerbs")`, which
 * is VS Code's own settings store. Same key name, different file, so our word
 * never arrived and the panel kept showing its built-in list.
 *
 * The rules are the daemon's, unchanged: a paid creative replaces the rotation
 * so it is there every turn; the user's own line only appends, so an unsold
 * machine still looks like Claude Code's; nothing to say means the key goes
 * away and the built-in verbs come back untouched.
 *
 * Nothing here is billed. The impression is already counted on the status bar,
 * which has a way to report what it displayed; this surface does not. It is a
 * second placement for the advertiser, not a second sale.
 */
function spinnerVerbsFor({ view, ownLine = '', enabled = true }) {
  if (!enabled) return null;
  if (view.paid && view.text.length > 0) return { mode: 'replace', verbs: [view.text] };
  const own = sanitizeText(ownLine);
  if (own.length > 0) return { mode: 'append', verbs: [own] };
  return null;
}

/**
 * May we write this key at all?
 *
 * Only if what is there is absent or is exactly what we put there. Anything
 * else means the person (or another tool) owns it, and then we never touch it
 * again — the same rule the daemon follows for the CLI's copy of this key.
 */
function spinnerIsOurs(onDisk, wrote) {
  if (onDisk === undefined || onDisk === null) return true;
  return JSON.stringify(onDisk) === JSON.stringify(wrote ?? null);
}

// -------------------------------------------------------------- diagnosis

/**
 * Why is there no line right now?
 *
 * This exists because the honest answer to "is it working" was, for a while,
 * "ask whoever built it". A publisher who sees nothing has no way to tell an
 * unsold slot from a dead background process from a half-finished setup, and
 * all three look identical: an empty status bar. Guessing wrong once is enough
 * to uninstall.
 *
 * Returns plain sentences in the order a person would want them: what is on
 * screen, then whether it is being counted, then what to do about it.
 */
function diagnose({
  view, pendingSetup = [], daemonAlive = false, working = false,
  windowLive = false, claimedElsewhere = false, apiBase = '', now = Date.now(), current = null,
}) {
  const lines = [];

  if (pendingSetup.length > 0) {
    lines.push(`Not set up yet for ${pendingSetup.map(agentName).join(' and ')}.`);
    lines.push('Nothing is counted until the activity hook is registered. Click the status bar item.');
    return lines;
  }

  if (view.paid) {
    lines.push(`Showing a paid line: ${view.text}`);
  } else if (view.text.length > 0) {
    lines.push(`Showing your own line: ${view.text}`);
    lines.push('Nothing is sold for this slot right now, so the line is yours and earns nothing.');
  } else {
    lines.push('Showing nothing.');
  }

  if (!view.paid) {
    const expired = current && typeof current.expires_at === 'number' && current.expires_at <= now;
    if (expired) {
      lines.push('The last creative expired and no new one arrived.');
    }
    if (!daemonAlive) {
      lines.push('The background process is not running, so nothing can be fetched or reported.');
      lines.push('It restarts itself from the status line or from this extension within half a minute.');
    } else {
      lines.push(`The background process is running and talking to ${apiBase || 'the server'}.`);
      lines.push('An empty slot usually means nothing is sold for you right now.');
    }
    return lines;
  }

  if (!windowLive) {
    lines.push('Not counting: this window has not been in use for two minutes.');
  } else if (claimedElsewhere) {
    lines.push('Not counting here: a terminal session is already counting this one.');
  } else if (!working) {
    lines.push('Not counting right now: no turn has run recently. Ask your agent something.');
  } else {
    lines.push('Counting now.');
  }

  return lines;
}

// ------------------------------------------------------------------- claims

/**
 * One window counts a session, the rest only display it.
 *
 * Three editor windows open on the same project all show the same creative in
 * their status bars, and one human is looking at them. Counting three
 * impressions for that would be billing for a guess — the thing we accuse the
 * competitor of. So a session is claimed, and only the holder appends ticks.
 *
 * Claims expire: a window that was closed must not hold a session hostage.
 */
function claimIsOurs(claim, owner, now, cfg = PANEL_DEFAULTS) {
  if (!claim || typeof claim !== 'object') return true;          // unclaimed
  if (claim.owner === owner) return true;                        // ours already
  const hb = typeof claim.hb === 'number' ? claim.hb : 0;
  return now - hb > cfg.claim_stale_ms;                          // holder is gone
}

/**
 * Is a terminal status line already counting this session?
 *
 * `carry.json` is the daemon's own per-session state, so a session that
 * rendered in a terminal within the last cycle is in it. Ticks not yet drained
 * close the 30-second gap at the start of a session. If either says yes we
 * render the creative but append nothing: the terminal is counting it, and one
 * display to one person is one impression.
 */
function claimedByTerminal({ carry, pendingSids, sessionId, now, cfg = PANEL_DEFAULTS }) {
  const entry = carry && typeof carry === 'object' ? carry[sessionId] : undefined;
  if (entry && entry.last && typeof entry.last.ts === 'number'
      && now - entry.last.ts <= cfg.active_window_ms) {
    return true;
  }
  return Array.isArray(pendingSids) && pendingSids.includes(sessionId);
}

// -------------------------------------------------------------------- hooks

/** One hook entry, in the shape the installed build actually validates:
 *  hooks[Event] = [{ matcher?, hooks: [{ type, command, timeout? }] }].
 *  Snapshotted from the 2.1.292 bundle, not from the settings reference —
 *  reading the reference instead of the bundle is how the spinnerVerbs mistake
 *  happened. */
function hookEntry(command) {
  return { hooks: [{ type: 'command', command, timeout: 5 }] };
}

/**
 * The heartbeat: PostToolUse, in the background. Without it a turn longer than
 * max_turn_ms looked dead and lost its line mid-work. `async: true` is Claude
 * Code's own option — "hook runs in background without blocking", read from
 * the 2.1.294 binary on 08.10 — so a tool call never waits for us. Claude Code
 * only: Codex has the event but no background mode, and a hook it waits for on
 * every tool call is the latency we refused to add.
 */
const HEARTBEAT_EVENT = 'PostToolUse';
function heartbeatEntry(command) {
  return { hooks: [{ type: 'command', command, timeout: 5, async: true }] };
}

function heartbeatInstalled(settings, command) {
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  return !!hooks && typeof hooks === 'object' && hasCommand(hooks[HEARTBEAT_EVENT], command);
}

/** Adds only the heartbeat, for a settings file whose three hooks are already ours. */
function addHeartbeat(settings, command) {
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  const hooks = { ...(next.hooks && typeof next.hooks === 'object' ? next.hooks : {}) };
  const groups = Array.isArray(hooks[HEARTBEAT_EVENT]) ? hooks[HEARTBEAT_EVENT] : [];
  if (hasCommand(groups, command)) return { settings: next, changed: false };
  hooks[HEARTBEAT_EVENT] = [...groups, heartbeatEntry(command)];
  next.hooks = hooks;
  return { settings: next, changed: true };
}

function hasCommand(groups, command) {
  return Array.isArray(groups) && groups.some(
    (g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === command),
  );
}

/**
 * Add our three hooks to someone else's settings file.
 *
 * Purely additive, and that is the whole design: we append a group of our own
 * next to whatever is already registered for the event and never read, reorder
 * or remove anyone else's. There is no shared key to take over and so nothing
 * to yield — unlike spinnerVerbs, where one shared value forced the "if it is
 * not ours we never touch it again" rule.
 *
 * Turn boundaries only. `PostToolUse` would be a sharper activity signal, but
 * it fires once per tool call and every hook is a spawned process, so it would
 * put our latency inside somebody else's working loop. Three events per turn
 * is enough to know whether the model is running.
 */
function addHooks(settings, command, events = HOOK_EVENTS) {
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  const hooks = { ...(next.hooks && typeof next.hooks === 'object' ? next.hooks : {}) };
  let changed = false;

  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (hasCommand(groups, command)) continue;
    hooks[event] = [...groups, hookEntry(command)];
    changed = true;
  }

  if (changed) next.hooks = hooks;
  return { settings: next, changed };
}

/** Remove exactly what we wrote and nothing else, down to dropping the empty
 *  containers we created, so an uninstall leaves the file as it was found. */
function removeHooks(settings, command) {
  const next = { ...(settings && typeof settings === 'object' ? settings : {}) };
  if (!next.hooks || typeof next.hooks !== 'object') return { settings: next, changed: false };

  const hooks = {};
  let changed = false;

  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups
      .map((g) => {
        if (!g || !Array.isArray(g.hooks)) return g;
        const inner = g.hooks.filter((h) => !(h && h.command === command));
        if (inner.length === g.hooks.length) return g;
        changed = true;
        return inner.length > 0 ? { ...g, hooks: inner } : null;
      })
      .filter((g) => g !== null);
    if (kept.length > 0) hooks[event] = kept;
  }

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  return { settings: next, changed };
}

// ------------------------------------------------------- hooks, Codex side

/**
 * Codex keeps its hooks in TOML, and Node has no TOML writer. Rather than pull
 * in a parser to edit somebody else's config file, we append one fenced block
 * and recognise it again by its markers. Appending is the whole point: the rest
 * of the file is never read, rewritten or reordered, so there is nothing we can
 * get wrong in it.
 *
 * The shape below was verified against codex-cli 0.159.3 by feeding it to
 * `codex doctor`: this form reports "config.toml parse ok", and both plausible
 * wrong forms — a flat array of commands, and a handler without a type — are
 * rejected as invalid data. Strict parser, so "ok" means something.
 */
const CODEX_BEGIN = '# >>> TICK activity hook — added by the TICK editor extension';
const CODEX_END = '# <<< TICK activity hook';
// What both writers' opening lines start with: the terminal installer adds the
// same block for the Codex app, signed as itself, and either side has to
// recognise the other's.
const CODEX_MARK = '# >>> TICK activity hook';

function codexHooksBlock(command, events = HOOK_EVENTS) {
  const body = events.map((event) => [
    `[[hooks.${event}]]`,
    'matcher = ""',
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    // Three, not five. Codex caps a SessionEnd hook at three seconds and prints
    // "clamping ... hook timeout" into the user's terminal when you ask for
    // more — a warning about us, in their output, about a limit we could simply
    // have respected. Ours finishes in about thirty milliseconds.
    'timeout = 3',
  ].join('\n')).join('\n\n');

  return [
    CODEX_BEGIN,
    '# Remove it with the editor command "TICK: Turn off in this editor".',
    '# Codex will ask you to review this hook before it runs; that is its own',
    '# trust check, and we do not try to get around it.',
    body,
    CODEX_END,
  ].join('\n');
}

function codexHooksInstalled(text, command) {
  const s = typeof text === 'string' ? text : '';
  return s.includes(CODEX_MARK) && s.includes(JSON.stringify(command));
}

function addCodexHooks(text, command, events = HOOK_EVENTS) {
  const s = typeof text === 'string' ? text : '';
  if (codexHooksInstalled(s, command)) return { text: s, changed: false };

  // An older block of ours with a different path: replace it rather than stack
  // a second one next to it.
  const stripped = removeCodexHooks(s).text;
  const base = stripped.length > 0 && !stripped.endsWith('\n') ? `${stripped}\n` : stripped;
  return { text: `${base}${base.length > 0 ? '\n' : ''}${codexHooksBlock(command, events)}\n`, changed: true };
}

/** Takes back exactly the block we added, and leaves the file otherwise byte
 *  for byte as it was found. */
function removeCodexHooks(text) {
  const s = typeof text === 'string' ? text : '';
  const start = s.indexOf(CODEX_MARK);
  if (start === -1) return { text: s, changed: false };
  const endMark = s.indexOf(CODEX_END, start);
  if (endMark === -1) return { text: s, changed: false };

  const end = endMark + CODEX_END.length;
  let before = s.slice(0, start);
  let after = s.slice(end);
  // Swallow the blank line we inserted ahead of the block, and the newline
  // that closed it, so turning the feature on and off leaves no drift.
  before = before.replace(/\n+$/, before.length > 0 ? '\n' : '');
  after = after.replace(/^\n+/, '');
  return { text: `${before}${after}`, changed: true };
}

// ------------------------------------------------------ hooks, Cursor side

/**
 * Cursor's own agent reports through ~/.cursor/hooks.json, its own format:
 * { version: 1, hooks: { <event>: [{ command, timeout? }] } }, camelCase event
 * names. Read from cursor.com/docs/agent/hooks on 08.10 and from Cursor 3.23.
 * The same additive rules as everywhere: our entry next to anyone else's,
 * never reading, reordering or removing theirs.
 */
const CURSOR_EVENTS = ['beforeSubmitPrompt', 'stop', 'sessionEnd'];

function cursorHooksInstalled(file, command, events = CURSOR_EVENTS) {
  const hooks = file && typeof file === 'object' ? file.hooks : null;
  if (!hooks || typeof hooks !== 'object') return false;
  return events.every((e) => Array.isArray(hooks[e]) && hooks[e].some((h) => h && h.command === command));
}

function addCursorHooks(file, command, events = CURSOR_EVENTS) {
  const next = { ...(file && typeof file === 'object' && !Array.isArray(file) ? file : {}) };
  if (typeof next.version !== 'number') next.version = 1;
  const hooks = { ...(next.hooks && typeof next.hooks === 'object' ? next.hooks : {}) };
  let changed = false;
  for (const e of events) {
    const list = Array.isArray(hooks[e]) ? hooks[e] : [];
    if (list.some((h) => h && h.command === command)) continue;
    hooks[e] = [...list, { command, timeout: 5 }];
    changed = true;
  }
  next.hooks = hooks;
  return { file: next, changed };
}

function removeCursorHooks(file, command) {
  const next = { ...(file && typeof file === 'object' && !Array.isArray(file) ? file : {}) };
  if (!next.hooks || typeof next.hooks !== 'object') return { file: next, changed: false };
  const hooks = {};
  let changed = false;
  for (const [e, list] of Object.entries(next.hooks)) {
    if (!Array.isArray(list)) { hooks[e] = list; continue; }
    const kept = list.filter((h) => !(h && h.command === command));
    if (kept.length !== list.length) changed = true;
    if (kept.length > 0) hooks[e] = kept;
  }
  next.hooks = hooks;
  return { file: next, changed };
}

function hooksInstalled(settings, command, events = HOOK_EVENTS) {
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return false;
  return events.every((event) => hasCommand(hooks[event], command));
}

module.exports = {
  PANEL_DEFAULTS,
  HOOK_EVENTS,
  MARKER,
  FRESH_MS,
  statusText,
  offerIsFresh,
  setupView,
  AGENTS,
  hostOf,
  countsInEditor,
  CURSOR_EVENTS,
  cursorHooksInstalled,
  addCursorHooks,
  removeCursorHooks,
  agentName,
  escapeMarkdown,
  tooltip,
  codexHooksBlock,
  codexHooksInstalled,
  addCodexHooks,
  removeCodexHooks,
  sanitizeText,
  safeUrl,
  SITE,
  dashboardUrl,
  usd,
  render,
  activityOf,
  withinWindow,
  windowIsLive,
  advance,
  panelSid,
  safeSessionId,
  spinnerVerbsFor,
  spinnerIsOurs,
  diagnose,
  claimIsOurs,
  claimedByTerminal,
  addHooks,
  removeHooks,
  hooksInstalled,
  HEARTBEAT_EVENT,
  heartbeatInstalled,
  addHeartbeat,
};

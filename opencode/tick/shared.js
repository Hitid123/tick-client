// TICK shared helpers for the OpenCode plugins.
//
// Pure functions only: no `vscode`, no file I/O, no network. Imported by both
// the server plugin (index.ts) and the TUI plugin (tui.tsx), which run in
// different processes. Mirrors vscode/src/core.js and daemon.mjs where the
// money rules live, so the three stay in agreement.

export const TICK_MS = 3000;
export const ACTIVE_WINDOW_MS = 120000;
export const MAX_TURN_MS = 600000;
export const TEXT_MAX = 60;
export const CLAIM_STALE_MS = 15000;

// OSC (hyperlink, title, clipboard) and CSI/SGR (colour).
const ESCAPES = new RegExp(
  '\\u001b(?:\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\[[0-9;]*[A-Za-z])',
  'g',
);
const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/** Make server text safe for the TUI. Same as core.js sanitizeText. */
export function sanitizeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ESCAPES, '')
    .replace(CONTROLS, ' ')
    .replace(/\$\(/g, '$ (')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Only our own http(s) links. */
export function safeUrl(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(s) ? s : '';
}

/** Whole micro-dollars to "1.23". */
export function usd(micros) {
  const n = typeof micros === 'number' && Number.isFinite(micros) ? micros : 0;
  const cents = Math.floor(n / 10000);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * What to show right now. Fallback order is the terminal's: paid creative,
 * then the user's own line, then balance, then nothing. `cid` is null for
 * everything except the paid creative; a tick with null cid is never billed.
 */
export function renderView({ current, config, balance, now }) {
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

/**
 * Read one session's hook mark into "is the model working, and when did it
 * last work". Same as core.js activityOf: hooks carry no cost figure, so turn
 * boundaries are all there is.
 */
export function activityOf(mark, now) {
  if (!mark || typeof mark !== 'object' || typeof mark.ts !== 'number') {
    return { working: false, lastWorkTs: 0 };
  }
  if (mark.ev === 'UserPromptSubmit') {
    const alive = now - mark.ts <= MAX_TURN_MS;
    return alive ? { working: true, lastWorkTs: now } : { working: false, lastWorkTs: mark.ts };
  }
  return { working: false, lastWorkTs: mark.ts };
}

/** Does this session still deserve ticks? Same 2-minute window as the daemon. */
export function withinWindow(lastWorkTs, now) {
  return lastWorkTs > 0 && now - lastWorkTs <= ACTIVE_WINDOW_MS;
}

/** Session ids become file names, so anything that is not one is not a session. */
export function safeSessionId(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : '';
}

/** `oc:` keeps OpenCode ticks in their own stream. The daemon hashes it before it leaves. */
export function ocSid(sessionId) {
  return `oc:${sessionId}`;
}

/**
 * Advance one session's counter and produce the tick fields to append.
 * `api_ms` grows by wall time only while the model is working, so the
 * daemon's unmodified aggregate() treats OpenCode exactly as the terminal.
 * Elapsed time is clamped so a closed lid does not arrive as hours of work.
 */
export function advance(prev, { working, now }) {
  const base = prev ?? { api_ms: 0, dur_ms: 0, lastTickTs: 0 };
  const raw = base.lastTickTs > 0 ? now - base.lastTickTs : 0;
  const elapsed = Math.max(0, Math.min(raw, TICK_MS * 2));
  return {
    api_ms: base.api_ms + (working ? elapsed : 0),
    dur_ms: base.dur_ms + elapsed,
    lastTickTs: now,
  };
}

/** Split "Name: offer CODE" into name / before / promo / after, like every surface. */
export function splitPromo(text, promo) {
  const i = text.indexOf(':');
  const name = i > 0 && [...text.slice(0, i)].length <= 24 ? text.slice(0, i) : '';
  const rest = name ? text.slice(name.length) : text;
  const at = promo ? rest.indexOf(promo) : -1;
  if (at < 0) return { name, before: rest, promo: '', after: '' };
  return { name, before: rest.slice(0, at), promo, after: rest.slice(at + promo.length) };
}

export const ACCENT_HEX = {
  amber: '#FFB000', green: '#3DD68C', teal: '#33D6C9',
  blue: '#62AEFF', violet: '#B794FF', pink: '#FF85BE', coral: '#FF7466',
};

/** The advertiser's colour by name, amber for anything else. */
export function accentHex(name) {
  return ACCENT_HEX[name] ?? ACCENT_HEX.amber;
}

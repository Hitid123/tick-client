#!/usr/bin/env node
// TICK background daemon.
//
// Spawned detached by statusline.sh, one per machine, guarded by a PID lock.
// Everything that talks to the network or thinks lives here; statusline.sh
// must stay dumb and fast (TZ section 2).
//
// No dependencies. Node 20+.

import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, statSync, realpathSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const HOME = process.env.TICK_HOME || join(homedir(), '.tick');
const STATE = join(HOME, 'state');
const P = {
  config: join(HOME, 'config.json'),
  ticks: join(STATE, 'ticks.ndjson'),
  taking: join(STATE, 'ticks.taking.ndjson'),
  carry: join(STATE, 'carry.json'),
  pending: join(STATE, 'pending.json'),
  outbox: join(STATE, 'outbox.json'),
  queue: join(STATE, 'queue.json'),
  current: join(STATE, 'current.json'),
  balance: join(STATE, 'balance.json'),
  milestones: join(STATE, 'milestones.json'),
  device: join(STATE, 'device.json'),
  pid: join(STATE, 'daemon.pid'),
  spinner: join(STATE, 'spinner.json'),
  update: join(STATE, 'update.json'),
  updated: join(STATE, 'updated.json'),
};

const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');


// Business rules stay configurable (TZ section 16). Client-side subset only.
const DEFAULTS = {
  api_base: 'https://gettick.dev/api/v1',
  cycle_ms: 30_000,
  impression_ms: 5_000,
  tick_max_gap_ms: 10_000,
  active_window_ms: 120_000,
  queue_low_water: 3,
  queue_fetch: 10,
  fetch_backoff_max_ms: 30 * 60_000,
  idle_exit_ms: 15 * 60_000,
  request_timeout_ms: 5_000,
  request_attempts: 3,
  session_ttl_ms: 60 * 60_000,
  // Impressions go to the server every five minutes, not every cycle: the
  // same impressions in a tenth of the rows, and the database the server
  // pays for grows ten times slower (09.10). They wait in pending.json, so a
  // daemon that stops in between loses none of them.
  batch_every_ms: 5 * 60_000,
  milestones_micros: [5e6, 10e6, 25e6, 50e6, 100e6],
  spinner: true,
  // Updates install themselves (see selfUpdate). false keeps this machine on
  // what it has; the next install, or turning it back on, catches it up.
  auto_update: true,
  update_every_ms: 3 * 60 * 60_000,
};

// ---------------------------------------------------------------- utilities

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};

const writeJson = (p, value) => {
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, p);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What comes from the server is shown in people's terminals, so it is cleaned
 * here, once, for every surface: no escape sequence, no control character of
 * either range, nothing invisible that changes what the line says. The server
 * refuses all of that when an ad is written; this is the second lock, for the
 * day our server is not the one answering. A terminal obeys what it is sent,
 * and an escape sequence can write someone's clipboard.
 */
const ESCAPES = /\u001b(\][^\u0007\u001b]*(\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const cleanText = (s, max) =>
  String(s ?? '').replace(ESCAPES, '').replace(INVISIBLE, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
// A link goes inside a terminal hyperlink: only plain URL characters, so it
// cannot close the sequence early and smuggle in one of its own.
export const SAFE_LINK = /^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{1,2000}$/;

export const hashSession = (sessionId, salt) =>
  createHash('sha256').update(`${sessionId}${salt}`).digest('hex');

// --------------------------------------------------------------- aggregation

/**
 * Turn raw ticks into billable impressions (TZ section 5).
 *
 * An impression is 5 s of uninterrupted display of one creative inside an
 * ACTIVE session. A pair of neighbouring ticks contributes its delta only if
 * every guard below holds; anything else is silently dropped, because paying
 * for a forgotten window is how an ad network loses its advertisers.
 *
 * `carry` holds the per-session tail of the previous cycle, so a cycle
 * boundary never costs the publisher a fraction of a second.
 */
export function aggregate(ticks, carry, cfg = DEFAULTS, now = Date.now()) {
  const next = { ...carry };
  const bySession = new Map();

  for (const t of ticks) {
    if (!t || typeof t.sid !== 'string' || typeof t.ts !== 'number') continue;
    if (!bySession.has(t.sid)) bySession.set(t.sid, []);
    bySession.get(t.sid).push(t);
  }

  const items = [];

  for (const [sid, raw] of bySession) {
    raw.sort((a, b) => a.ts - b.ts);

    const s = next[sid] ?? { last: null, lastIncreaseTs: 0, pending: {} };
    let prev = s.last;
    let lastIncreaseTs = s.lastIncreaseTs;
    const pending = s.pending; // cid -> { rem, active, api, first, last, model }

    for (const cur of raw) {
      const api = typeof cur.api_ms === 'number' ? cur.api_ms : 0;

      if (prev) {
        // The model did work between these two ticks: the session is alive.
        if (api > prev.api_ms) lastIncreaseTs = cur.ts;

        const delta = cur.ts - prev.ts;
        const sameCreative = cur.cid != null && prev.cid === cur.cid;
        const withinGap = delta > 0 && delta <= cfg.tick_max_gap_ms;
        const active = cur.ts - lastIncreaseTs <= cfg.active_window_ms;

        if (sameCreative && withinGap && active) {
          const b = (pending[cur.cid] ??= {
            rem: 0, active: 0, api: 0, first: prev.ts, last: cur.ts, model: cur.model ?? null,
          });
          b.rem += delta;
          b.active += delta;
          b.api += Math.max(0, api - prev.api_ms);
          b.last = cur.ts;
          if (cur.model) b.model = cur.model;
        }
      }
      // Note there is no seeding of lastIncreaseTs from the first tick: a
      // session that merely *has* api time behind it is not working now, and
      // treating a non-zero total as activity would pay for idle windows.

      prev = { ts: cur.ts, api_ms: api, cid: cur.cid ?? null };
    }

    for (const [cid, b] of Object.entries(pending)) {
      const count = Math.floor(b.rem / cfg.impression_ms);
      if (count <= 0) continue;
      items.push({
        creative_id: cid,
        count,
        session_hash: sid,          // replaced with the salted hash by buildBatch
        first_ts: b.first,
        last_ts: b.last,
        active_ms: b.active,
        api_ms_delta: b.api,
        model: b.model,
      });
      b.rem -= count * cfg.impression_ms;
      b.active = 0;
      b.api = 0;
      b.first = b.last;
      if (b.rem === 0) delete pending[cid];
    }

    next[sid] = { last: prev, lastIncreaseTs, pending };
  }

  // Forget sessions that went quiet, so carry.json cannot grow forever.
  for (const [sid, s] of Object.entries(next)) {
    if (!s.last || now - s.last.ts > cfg.session_ttl_ms) delete next[sid];
  }

  return { items, carry: next };
}

/** Wrap items into the wire payload. Raw session_id never leaves the machine. */
/**
 * Items of one session and one campaign, added up across cycles: their counts
 * and times summed, the earliest start and the latest end kept. Kept apart by
 * session, because two windows at once are two items: the server checks each
 * against its own time span.
 */
export function mergeItems(prev, items) {
  const out = prev.map((i) => ({ ...i }));
  for (const it of items) {
    const same = out.find((o) => o.session_hash === it.session_hash && o.creative_id === it.creative_id);
    if (!same) { out.push({ ...it }); continue; }
    same.count += it.count;
    same.active_ms += it.active_ms;
    same.api_ms_delta += it.api_ms_delta;
    same.first_ts = Math.min(same.first_ts, it.first_ts);
    same.last_ts = Math.max(same.last_ts, it.last_ts);
    if (it.model) same.model = it.model;
  }
  return out;
}

export function buildBatch(items, salt) {
  return {
    batch_id: randomUUID(),
    items: items.map((i) => ({
      creative_id: i.creative_id,
      count: i.count,
      session_hash: hashSession(i.session_hash, salt),
      first_ts: i.first_ts,
      last_ts: i.last_ts,
      active_ms: i.active_ms,
      api_ms_delta: i.api_ms_delta,
      model: i.model,
    })),
  };
}

// ------------------------------------------------------------------- queue

/**
 * Whether to ask the server for more creatives, and how many.
 *
 * Asking is not free. The server counts a hand-out against the device's daily
 * frequency cap, so a client that asks four times has spent the whole day's
 * allowance for that campaign whether or not anything was ever displayed.
 *
 * Two things went wrong before this existed. The queue only refills below the
 * low-water mark, but with fewer live campaigns than that mark the queue can
 * never reach it — so the daemon asked every single cycle, burned the default
 * cap of four in two minutes, and the line went dark for the rest of the day.
 * That is the normal state of a young network, not an edge case. And asking for
 * ten when two are needed spends cap on eight campaigns that will not be shown
 * before the next request anyway.
 *
 * So: ask for what is missing, not for a bucketful, and after a request that
 * brought back nothing new, wait longer each time before asking again.
 */
export function fetchPlan(queue, cfg, state, now, currentExpiresAt = 0) {
  if (queue.length >= cfg.queue_low_water) return { fetch: false, n: 0 };
  // The backoff protects the server while there is nothing to be had. It must
  // not leave the line empty: when the creative on screen is about to run out
  // and nothing is queued behind it, ask now rather than at the end of a
  // doubled wait.
  const runningOut = queue.length === 0 && currentExpiresAt > 0 && currentExpiresAt - now <= cfg.cycle_ms;
  if (now < state.until && !runningOut) return { fetch: false, n: 0 };
  const missing = cfg.queue_low_water - queue.length;
  return { fetch: true, n: Math.max(1, Math.min(cfg.queue_fetch, missing)) };
}

/** Back off while there is nothing to be had; snap back the moment there is. */
export function backoffAfter(gained, state, cfg, now) {
  if (gained > 0) return { until: 0, step: 0 };
  const step = Math.min(cfg.fetch_backoff_max_ms, (state.step || cfg.cycle_ms) * 2);
  return { until: now + step, step };
}

// ------------------------------------------------------------------ identity

function machineSeed() {
  try {
    if (platform() === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8', timeout: 2000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    }
  } catch { /* fall through to nonce-only */ }
  return '';
}

function loadDevice() {
  let d = readJson(P.device, null);
  if (!d || typeof d.nonce !== 'string' || typeof d.salt !== 'string') {
    d = { nonce: randomBytes(16).toString('hex'), salt: randomBytes(32).toString('hex'), token: null };
    d.fingerprint = createHash('sha256')
      .update(`${machineSeed()}|${platform()}|${arch()}|${d.nonce}`)
      .digest('hex');
    writeJson(P.device, d);
  }
  return d;
}

// ------------------------------------------------------------------- network

async function request(cfg, method, path, body, token) {
  let lastErr;
  for (let attempt = 0; attempt < cfg.request_attempts; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(`${cfg.api_base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.request_timeout_ms),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        // 4xx is our own fault; retrying will not fix it.
        if (res.status >= 400 && res.status < 500) return { ok: false, status: res.status, json };
        throw new Error(`HTTP ${res.status}`);
      }
      return { ok: true, status: res.status, json };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, status: 0, error: String(lastErr) };
}

// ---------------------------------------------------------------- the daemon

function takeTicks() {
  // Rename, then read: statusline.sh keeps appending to a fresh file meanwhile,
  // so no tick can be lost between the read and the truncate (TZ section 4.2).
  if (!existsSync(P.ticks)) return [];
  try { renameSync(P.ticks, P.taking); } catch { return []; }
  let lines = [];
  try { lines = readFileSync(P.taking, 'utf8').split('\n'); } catch { /* ignore */ }
  try { unlinkSync(P.taking); } catch { /* ignore */ }
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not worth a crash */ }
  }
  return out;
}

/**
 * One daemon per machine. The exclusive create is what makes this a lock
 * rather than a suggestion: two daemons spawned in the same instant would
 * otherwise both read "no pid file" and both proceed.
 */
function lockOrExit() {
  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
  try {
    writeFileSync(P.pid, String(process.pid), { flag: 'wx' });
    return true;
  } catch { /* someone got there first, or left a stale file behind */ }

  let existing = NaN;
  try { existing = Number(readFileSync(P.pid, 'utf8').trim()); } catch { /* unreadable */ }
  if (Number.isInteger(existing) && existing > 0 && existing !== process.pid) {
    try {
      process.kill(existing, 0);
      return false;                       // the holder is alive; stand down
    } catch { /* stale pid, take over */ }
  }
  writeFileSync(P.pid, String(process.pid));
  return true;
}

function loadConfig() {
  const user = readJson(P.config, {}) ?? {};
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (user[k] !== undefined && typeof user[k] === typeof DEFAULTS[k]) cfg[k] = user[k];
  }
  if (process.env.TICK_API_BASE) cfg.api_base = process.env.TICK_API_BASE;
  return cfg;
}

function rotateCurrent(queue, now) {
  const cur = readJson(P.current, null);
  if (cur && typeof cur.expires_at === 'number' && cur.expires_at > now) return false;
  const next = queue.shift();
  if (!next) return false;
  writeJson(P.current, {
    creative_id: next.creative_id,
    text: next.text,
    // When this one arrived, so the status line can mark its arrival and then
    // stop. The eye catches a change; it ignores a thing that is simply there.
    shown_at: now,
    expires_at: now + (next.ttl_sec ?? 300) * 1000,
    // Present only when the campaign has somewhere to send a click. The status
    // line validates it again before printing; a server is not a reason to trust.
    ...(typeof next.click_url === 'string' ? { click_url: next.click_url } : {}),
    ...(typeof next.promo_code === 'string' ? { promo_code: next.promo_code } : {}),
    ...(typeof next.accent === 'string' ? { accent: next.accent } : {}),
  });
  return true;
}

/** The milestone to announce, or null. Each threshold fires once, ever. */
function pendingMilestone(cfg) {
  const accrued = Number(readJson(P.balance, null)?.accrued ?? 0);
  const shown = readJson(P.milestones, []) ?? [];
  const hit = [...cfg.milestones_micros].reverse().find((m) => accrued >= m && !shown.includes(m));
  return hit === undefined ? null : hit;
}

/**
 * The spinner carries the user's own line and their milestones — never an ad.
 *
 * This is the one place we write to someone else's settings file after install,
 * so the rules are strict. We only ever append to Claude Code's own verbs. We
 * write only when the resulting array actually differs, which in practice means
 * once when a line is set and once more per milestone, not every cycle. And we
 * remember exactly what we wrote: if the value on disk is not ours, the user
 * (or another tool) owns the key and we never touch it again.
 *
 * No impressions are counted here and nothing is billed. The surface has no way
 * to report what it displayed, so charging for it would be charging for a guess.
 */
function syncSpinner(cfg) {
  const state = readJson(P.spinner, null);
  const ours = state?.wrote ?? null;

  const settings = readJson(SETTINGS, null);
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return;

  const current = settings.spinnerVerbs;
  const theirs = current !== undefined && (ours === null || JSON.stringify(current) !== JSON.stringify(ours));
  if (theirs) {
    // Somebody else owns this key. Record that and stop trying, for good.
    if (state?.yielded !== true) writeJson(P.spinner, { wrote: null, yielded: true });
    return;
  }
  if (state?.yielded === true) return;

  // Priority is the point of the product: a paid creative outranks everything.
  const now = Date.now();
  const cur = readJson(P.current, null);
  const paid = cfg.spinner && cur && cur.creative_id && (cur.expires_at ?? 0) > now
    ? String(cur.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';

  const milestone = cfg.spinner && !paid ? pendingMilestone(cfg) : null;
  const ownLine = cfg.spinner && !paid
    ? String(readJson(P.config, {})?.own_line ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    : '';

  // { mode, verbs } is the shape Claude Code actually validates — not the plain
  // array the public settings reference shows, which is rejected silently.
  //
  // A sold creative replaces the rotation so it is on screen every turn, which
  // is what the advertiser paid the status line for. Nothing extra is billed
  // here: the impression is already counted downstairs, and this surface cannot
  // report what it displayed. It is a free second placement, not a second sale.
  //
  // Our own content only appends, so an unsold machine still looks like Claude
  // Code's, and with nothing to say the key is removed and the built-in verbs
  // come back untouched.
  let desired = null;
  if (paid) {
    desired = { mode: 'replace', verbs: [paid] };
  } else if (milestone !== null) {
    desired = { mode: 'append', verbs: [`TICK · you earned $${Math.floor(milestone / 1e6)}`] };
  } else if (ownLine.length > 0) {
    desired = { mode: 'append', verbs: [ownLine] };
  }
  if (JSON.stringify(desired ?? null) === JSON.stringify(ours ?? null)) return;

  if (desired === null) {
    delete settings.spinnerVerbs;
  } else {
    settings.spinnerVerbs = desired;
  }

  try {
    const tmp = `${SETTINGS}.tick.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, SETTINGS);
  } catch {
    return; // read-only or generated settings file: leave it alone
  }

  writeJson(P.spinner, { wrote: desired });
  if (milestone !== null && !paid) {
    writeJson(P.milestones, [...(readJson(P.milestones, []) ?? []), milestone]);
  }
}

/**
 * A device token belongs to the server that issued it. Pointed at another one
 * (server/scripts/dev-up.mjs does that, and back), the client keeps each
 * server's token apart and starts clean there: the queue's click links, the
 * outbox's creative ids and the balance all mean nothing to the new server.
 * Until 08.10 the token simply went along, the new server answered 401 to
 * everything, and the line kept whatever the old one had sold — the owner's
 * Mac served the local test server's ads for five days after a demo.
 *
 * A token written before this existed has no server on it; it is taken to be
 * the current one's, which it was for everybody who never switched.
 */
function followServer(device, cfg) {
  if (!device.api_base) {
    if (device.token) { device.api_base = cfg.api_base; writeJson(P.device, device); }
    return false;
  }
  if (device.api_base === cfg.api_base) return false;
  const tokens = { ...(device.tokens ?? {}) };
  if (device.token) tokens[device.api_base] = device.token;
  device.token = tokens[cfg.api_base] ?? null;
  delete tokens[cfg.api_base];
  device.tokens = tokens;
  device.api_base = cfg.api_base;
  writeJson(P.device, device);
  for (const f of [P.queue, P.current, P.outbox, P.carry, P.pending, P.balance]) {
    try { unlinkSync(f); } catch { /* not there */ }
  }
  fetchState = { until: 0, step: 0 };
  return true;
}

/** How long to wait before asking for creatives again. See fetchPlan. */
let fetchState = { until: 0, step: 0 };

async function cycle(cfg, device, cycleNo) {
  followServer(device, cfg);
  const now = Date.now();

  const ticks = takeTicks();
  if (ticks.length) {
    const { items, carry } = aggregate(ticks, readJson(P.carry, {}) ?? {}, cfg, now);
    writeJson(P.carry, carry);
    if (items.length) {
      const pending = readJson(P.pending, null) ?? { since: now, items: [] };
      pending.items = mergeItems(pending.items ?? [], items);
      writeJson(P.pending, pending);
    }
  }
  // Every few minutes what has gathered becomes one batch.
  const pending = readJson(P.pending, null);
  if (pending?.items?.length && now - (pending.since ?? 0) >= cfg.batch_every_ms) {
    const outbox = readJson(P.outbox, []) ?? [];
    outbox.push(buildBatch(pending.items, device.salt));
    writeJson(P.outbox, outbox);
    try { unlinkSync(P.pending); } catch { /* already gone */ }
  }

  if (!device.token) {
    const res = await request(cfg, 'POST', '/devices', { fingerprint: device.fingerprint });
    if (res.ok && res.json?.device_token) {
      device.token = res.json.device_token;
      device.api_base = cfg.api_base;
      writeJson(P.device, device);
    }
  }

  if (device.token) {
    // Batches keep their batch_id across retries, so a redelivery is a no-op.
    let outbox = readJson(P.outbox, []) ?? [];
    while (outbox.length) {
      const batch = outbox[0];
      const res = await request(cfg, 'POST', '/impressions', batch, device.token);
      if (!res.ok && res.status === 0) break;                 // offline: keep the backlog
      if (res.ok && res.json?.balance) writeJson(P.balance, res.json.balance);
      outbox = outbox.slice(1);
      writeJson(P.outbox, outbox);
    }

    const queue = readJson(P.queue, []) ?? [];
    const onScreen = readJson(P.current, null);
    const plan = fetchPlan(queue, cfg, fetchState, Date.now(),
      typeof onScreen?.expires_at === 'number' ? onScreen.expires_at : 0);
    if (plan.fetch) {
      lastFetchAt = Date.now();
      const res = await request(cfg, 'GET', `/creatives?n=${plan.n}`, undefined, device.token);
      let gained = 0;
      if (res.ok && Array.isArray(res.json?.creatives)) {
        // The creative on screen counts as seen: the same line queued right
        // behind itself would be one ad for twice its window.
        const seen = new Set([...queue.map((c) => c.creative_id), onScreen?.creative_id].filter(Boolean));
        for (const c of res.json.creatives) {
          if (!c?.creative_id || typeof c.text !== 'string' || seen.has(c.creative_id)) continue;
          seen.add(c.creative_id);
          const text = cleanText(c.text, 120);
          if (!text) continue;
          const promo = typeof c.promo_code === 'string' ? cleanText(c.promo_code, 32) : '';
          queue.push({
            creative_id: c.creative_id,
            text,
            ttl_sec: typeof c.ttl_sec === 'number' ? c.ttl_sec : 600,
            ...(typeof c.click_url === 'string' && SAFE_LINK.test(c.click_url) ? { click_url: c.click_url } : {}),
            ...(promo ? { promo_code: promo } : {}),
            // The advertiser's colour, by name. Each client knows the names it
            // can draw and falls back to amber on the rest, so only the shape
            // is checked here.
            ...(typeof c.accent === 'string' && /^[a-z]{1,16}$/.test(c.accent) ? { accent: c.accent } : {}),
          });
          gained += 1;
        }
      }
      fetchState = backoffAfter(gained, fetchState, cfg, Date.now());
    }

    if (cycleNo % 10 === 0) {
      const res = await request(cfg, 'GET', '/balance', undefined, device.token);
      if (res.ok && res.json) writeJson(P.balance, res.json);
    }

    rotateCurrent(queue, Date.now());
    writeJson(P.queue, queue);
  }

  // Every cycle, not every tenth: editing own_line should take effect in half a
  // minute rather than five. The promise of writing rarely comes from comparing
  // content before writing, not from checking seldom — in the steady state this
  // reads two small files and does nothing.
  try { syncSpinner(cfg); } catch { /* the spinner is a nicety, never a failure */ }
}

async function main() {
  if (!lockOrExit()) process.exit(0);
  const cleanup = () => { try { unlinkSync(P.pid); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  let cfg = loadConfig();
  const device = loadDevice();
  let lastTickSeen = Date.now();

  for (let n = 1; ; n++) {
    try {
      // Re-read every cycle. Editing api_base or own_line and seeing nothing
      // happen until you kill the process is indistinguishable from broken,
      // and Claude Code itself reloads its settings on change.
      cfg = loadConfig();
      const before = existsSync(P.ticks) ? statSync(P.ticks).size : 0;
      if (before > 0) lastTickSeen = Date.now();
      await cycle(cfg, device, n);
      // A daemon that replaced itself makes way for the new one.
      if (await selfUpdate(cfg, device)) process.exit(0);
    } catch (e) {
      process.stderr.write(`[tick] cycle error: ${e?.stack ?? e}\n`);
    }
    // Our home was removed out from under us: uninstalled, or a test sandbox
    // was torn down. Nothing left to serve and nowhere left to write.
    if (!existsSync(STATE)) process.exit(0);
    // Claude Code is gone; nothing to do until statusline.sh respawns us.
    if (Date.now() - lastTickSeen > cfg.idle_exit_ms) process.exit(0);

    // Rotation is local and cheap, so it does not wait for the network cycle.
    // A creative that expired a second into the cycle used to leave every
    // surface without one for the rest of it — up to half a minute of an empty
    // line, and the desktop strip, which appears with the turn, just late.
    //
    // And the network cycle comes early when the line is about to run out
    // with nothing queued behind it: waiting out the half minute left a turn
    // that began just then with no line for seconds (the owner, 08.10, "it
    // should light up as soon as the AI starts thinking"). At most one early
    // ask per ten seconds, so a server with nothing to give is not hammered.
    const until = Date.now() + cfg.cycle_ms;
    while (Date.now() < until) {
      await sleep(Math.min(1000, until - Date.now()));
      try { rotateLocally(); } catch { /* the next cycle rotates anyway */ }
      const t = Date.now();
      if (lineEndingSoon(t) && t - lastFetchAt > 10_000 && t - lastEarlyAt > 10_000) { lastEarlyAt = t; break; }
    }
  }
}

/** Between network cycles: move to the next queued creative once the current
 *  one expires. Disk only, never the network; written only when it changed. */
let lastFetchAt = 0;
let lastEarlyAt = 0;

/** Nothing queued, and the line on screen is gone or about to go. */
function lineEndingSoon(now) {
  const queue = readJson(P.queue, []) ?? [];
  if (Array.isArray(queue) && queue.length > 0) return false;
  const cur = readJson(P.current, null);
  const ends = cur && typeof cur.expires_at === 'number' ? cur.expires_at : 0;
  return ends - now < 15_000;
}

function rotateLocally() {
  const queue = readJson(P.queue, null);
  if (!Array.isArray(queue) || queue.length === 0) return;
  if (rotateCurrent(queue, Date.now())) writeJson(P.queue, queue);
}

/**
 * True when this file was run, not imported. The realpath matters: node
 * resolves symlinks when it loads a module, so on macOS an entry point under
 * /var/... arrives here as /private/var/... and a naive compare silently
 * decides the daemon was imported and exits 0 without doing anything.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- the cabinet

/**
 * The site behind an API address: ours, or a local dev server. Anything else
 * that does not parse falls back to ours rather than to nothing.
 */
export function siteOf(apiBase) {
  try {
    const u = new URL(String(apiBase || ''));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
  } catch { /* not a URL */ }
  return 'https://gettick.dev';
}

/** How each system opens an address in the default browser, as an argv: no shell. */
export function browserCommand(url, os = platform()) {
  if (os === 'darwin') return ['open', url];
  if (os === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url];
  return ['xdg-open', url];
}

/**
 * `node daemon.mjs --dashboard`: opens this computer's cabinet, signed in as
 * this computer. The device token never goes into the address — an address
 * stays in browser history, and a synced history travels — so the server
 * trades it for a code good for one use within five minutes (#c=…, after the
 * #, which a browser never sends). Prints one line of JSON for whoever ran it.
 */
async function openDashboard() {
  const cfg = loadConfig();
  const device = readJson(P.device, null);
  let url = `${siteOf(cfg.api_base)}/dashboard`;
  let signedIn = false;
  if (device?.token && (!device.api_base || device.api_base === cfg.api_base)) {
    const r = await request({ ...cfg, request_attempts: 2 }, 'POST', '/account/handoff', {}, device.token);
    if (r.ok && /^[0-9a-f]{48}$/.test(String(r.json?.code))) { url += `#c=${r.json.code}`; signedIn = true; }
  }
  const [cmd, ...args] = browserCommand(url);
  const opened = await new Promise((done) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => done(false));
      child.once('spawn', () => { child.unref(); done(true); });
    } catch { done(false); }
  });
  // The address goes out only when no browser could take it: then it is the
  // one way in, and its code is spent at first use or in five minutes anyway.
  process.stdout.write(JSON.stringify({ opened, signed_in: signedIn, registered: Boolean(device?.token), ...(opened ? {} : { url }) }) + '\n');
}

// ---------------------------------------------------------------- updates

/**
 * Updates install themselves, so nobody has to remember to (the owner,
 * 09.10: "people will get fed up installing updates every time").
 *
 * Every few hours, while it runs, the daemon asks our server which files the
 * current release is made of: a name and a SHA-256 each, from the server's own
 * deploy. It downloads only the ones that differ from what is installed, from
 * the public repository, and keeps each only if its hash is the one the server
 * named. So a forged update needs both the GitHub repository and our server;
 * either alone gets nowhere.
 *
 *   - Only what is already installed is replaced, in place, with the same
 *     paths everything points at. Settings files are never touched.
 *   - Each file is checked before it goes live (node --check, sh -n), swapped
 *     in with a rename, and the old one kept in state/previous.
 *   - Not everyone at once: each machine waits its own few hours after a
 *     release first appears, so a bad one can be withdrawn while it reaches
 *     few. Withdrawing is just publishing the old files again.
 *   - The server can pause updates for everyone (CLIENT_UPDATES=off there).
 *   - A daemon that replaced itself exits; whatever started it starts the new
 *     one within seconds, as it does after any exit.
 */
const UPDATE_BASE = process.env.TICK_UPDATE_BASE || 'https://raw.githubusercontent.com/Hitid123/tick-client/main';
const STAGGER_MS = 3 * 60 * 60_000;
const MAX_FILE = 30 * 1024 * 1024;

/** The files a release is made of, where each lives once installed, and how it is checked first. */
export function installedFiles(home, os = platform(), running = process.argv[1]) {
  const at = (name) => join(home, name);
  const list = [
    // The daemon is always ours to keep current: where only the Claude Code
    // plugin is installed, it runs the plugin's copy until this one exists.
    { name: 'daemon.mjs', dest: at('daemon.mjs'), always: true, check: 'node', mode: 0o755, from: existsSync(at('daemon.mjs')) ? at('daemon.mjs') : running },
    { name: 'hook.mjs', dest: at('hook.mjs'), check: 'node' },
    { name: 'opencode-plugin.js', dest: at('opencode-plugin.js'), check: 'node' },
    { name: 'install-windows.mjs', dest: at('install-windows.mjs'), check: 'node' },
    { name: 'statusline.sh', dest: at('statusline.sh'), check: 'sh', mode: 0o755 },
    { name: 'nojq.sh', dest: at('nojq.sh'), check: 'sh', mode: 0o755 },
    { name: 'uninstall.sh', dest: at('uninstall.sh'), check: 'sh', mode: 0o755 },
  ];
  if (os === 'darwin') list.push({ name: 'tick-satellite-macos', dest: join(home, 'TICK.app', 'Contents', 'MacOS', 'TICK'), kind: 'mac-app', mode: 0o755 });
  if (os === 'win32') list.push({ name: 'tick-satellite-windows.exe', dest: at('tick-satellite.exe'), kind: 'win-exe' });
  return list.filter((f) => f.always || existsSync(f.dest)).map((f) => ({ from: f.dest, kind: 'file', ...f }));
}

const sha256Of = (path) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };

/**
 * What an installed file is, as a release names it. The Mac strip is signed
 * on the machine when it is put in place (codesign, by install.sh and here),
 * which changes its bytes, so it is known by the release hash its bundle was
 * marked with instead (Contents/Resources/source). Read by its bytes, it never
 * matched, and it was replaced every few hours (found 10.10).
 */
export function localHash(f) {
  if (f.kind === 'mac-app') {
    try {
      const m = /^bundle-\d+ ([0-9a-f]{64})/.exec(readFileSync(join(f.dest, '..', '..', 'Resources', 'source'), 'utf8'));
      return m ? m[1] : null;
    } catch { return null; }
  }
  return sha256Of(f.from);
}

/** Which installed files differ from the release. Pure, for the tests. */
export function planUpdate(release, local) {
  if (!release || typeof release !== 'object') return [];
  return local.filter((f) => /^[0-9a-f]{64}$/.test(String(release[f.name] ?? '')) && f.hash !== release[f.name]).map((f) => f.name);
}

/** This machine's own wait after a release first appears: 0 to 3 hours, the same every time. */
export function staggerOf(nonce) {
  return parseInt(createHash('sha256').update(`update:${nonce}`).digest('hex').slice(0, 8), 16) % STAGGER_MS;
}

const isLocal = (u) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

/** Returns true when the daemon replaced itself and should exit. */
async function selfUpdate(cfg, device, now = Date.now()) {
  if (!cfg.auto_update) return false;
  // A daemon pointed at a local server is a developer's or a test's: it is
  // not updated from the public repository behind their back.
  if (isLocal(cfg.api_base) && !process.env.TICK_UPDATE_BASE) return false;
  const st = readJson(P.update, {}) ?? {};
  if (now - (st.checked_at ?? 0) < cfg.update_every_ms) return false;
  const save = (more) => writeJson(P.update, { ...st, checked_at: now, ...more });

  const r = await request({ ...cfg, request_attempts: 1, request_timeout_ms: 10_000 }, 'GET', '/client/release');
  if (!r.ok || !r.json || typeof r.json.files !== 'object') { save({ error: `release: ${r.status || r.error}` }); return false; }
  if (r.json.paused) { save({ error: null, paused: true }); return false; }

  const files = installedFiles(HOME).map((f) => ({ ...f, hash: localHash(f) }));
  const plan = planUpdate(r.json.files, files);
  if (plan.length === 0) { save({ error: null, paused: false, current: true }); return false; }

  // Not everyone at once. Until this machine's turn, it looks again then.
  const id = createHash('sha256').update(JSON.stringify(Object.entries(r.json.files).sort())).digest('hex').slice(0, 16);
  const seenAt = st.release === id && st.seen_at ? st.seen_at : now;
  const due = seenAt + staggerOf(device.nonce);
  if (now < due) {
    writeJson(P.update, { ...st, release: id, seen_at: seenAt, checked_at: due - cfg.update_every_ms, waiting: plan });
    return false;
  }

  // From one commit, not "main": GitHub's file host caches main for minutes,
  // file by file, and a stale file would only fail its hash and wait hours.
  let base = UPDATE_BASE;
  if (!process.env.TICK_UPDATE_BASE) {
    try {
      const res = await fetch('https://api.github.com/repos/Hitid123/tick-client/commits/main', {
        headers: { accept: 'application/vnd.github.sha', 'user-agent': 'tick' }, signal: AbortSignal.timeout(10_000),
      });
      const sha = (await res.text()).trim();
      if (res.ok && /^[0-9a-f]{40}$/.test(sha)) base = `https://raw.githubusercontent.com/Hitid123/tick-client/${sha}`;
    } catch { /* main, then */ }
  }

  // Everything is downloaded and checked before anything is replaced.
  const dir = join(STATE, 'update');
  mkdirSync(dir, { recursive: true });
  const ready = [];
  try {
    for (const name of plan) {
      const res = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_FILE) throw new Error(`${name}: too large`);
      if (createHash('sha256').update(body).digest('hex') !== r.json.files[name]) throw new Error(`${name}: not the file the release names`);
      // Under its own name, in a folder of its own: node tells a module by its extension.
      const tmp = join(dir, name);
      writeFileSync(tmp, body);
      const f = files.find((x) => x.name === name);
      if (f.check === 'node') execFileSync(process.execPath, ['--check', tmp], { stdio: 'ignore', timeout: 10_000 });
      if (f.check === 'sh' && platform() !== 'win32') execFileSync('sh', ['-n', tmp], { stdio: 'ignore', timeout: 10_000 });
      ready.push({ ...f, tmp, hash: r.json.files[name] });
    }
  } catch (e) {
    save({ release: id, seen_at: seenAt, error: String(e?.message ?? e) });
    return false;
  }

  const prev = join(STATE, 'previous');
  mkdirSync(prev, { recursive: true });
  const done = readJson(P.updated, {}) ?? {};
  for (const f of ready) {
    try { if (existsSync(f.dest)) copyFileSync(f.dest, join(prev, f.name)); } catch { /* a backup is a convenience */ }
    if (f.kind === 'win-exe') {
      // A running program cannot be overwritten on Windows, but it can be renamed.
      try { unlinkSync(`${f.dest}.old`); } catch { /* still running, or not there */ }
      try { renameSync(f.dest, `${f.dest}.old`); } catch { /* not running */ }
    }
    renameSync(f.tmp, f.dest);
    if (f.mode && platform() !== 'win32') { try { chmodSync(f.dest, f.mode); } catch { /* keeps its mode */ } }
    done[f.name] = f.hash;
    if (f.kind === 'mac-app') restartMacSatellite(f.dest, f.hash);
    if (f.kind === 'win-exe') restartWindowsSatellite(f.dest);
  }
  writeJson(P.updated, done);
  save({ release: id, seen_at: seenAt, error: null, current: true, applied_at: now, applied: ready.map((f) => f.name), waiting: [] });
  return ready.some((f) => f.name === 'daemon.mjs');
}

/** The Mac strip: its app bundle marked the way install.sh marks it, signed again, restarted by launchd. */
function restartMacSatellite(binary, hash) {
  const app = join(binary, '..', '..', '..');
  const icns = sha256Of(join(app, 'Contents', 'Resources', 'TICK.icns'));
  try { writeFileSync(join(app, 'Contents', 'Resources', 'source'), `bundle-3 ${hash} ${icns ?? ''}`.trim() + '\n'); } catch { /* install.sh redoes it */ }
  const quiet = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 20_000 }); } catch { /* best effort */ } };
  quiet('codesign', ['--force', '--sign', '-', '--identifier', 'dev.gettick.satellite', app]);
  // Only a real login session's job; a test's sandbox has none.
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'dev.gettick.satellite.plist');
  if (process.env.TICK_NO_LAUNCHD !== '1' && existsSync(plist)) {
    quiet('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/dev.gettick.satellite`]);
  }
}

/** The Windows strip: the old one stopped, the new one started, as the installer does. */
function restartWindowsSatellite(exe) {
  if (process.env.TICK_NO_LAUNCHD === '1') return;
  try { execFileSync('taskkill', ['/IM', 'tick-satellite.exe', '/F'], { stdio: 'ignore', timeout: 10_000 }); } catch { /* not running */ }
  try { spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* starts at the next login */ }
}

if (invokedDirectly()) {
  if (process.argv.includes('--dashboard')) openDashboard();
  else main();
}

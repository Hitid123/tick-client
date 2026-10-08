#!/usr/bin/env node
// TICK background daemon.
//
// Spawned detached by statusline.sh, one per machine, guarded by a PID lock.
// Everything that talks to the network or thinks lives here; statusline.sh
// must stay dumb and fast (TZ section 2).
//
// No dependencies. Node 20+.

import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOME = process.env.TICK_HOME || join(homedir(), '.tick');
const STATE = join(HOME, 'state');
const P = {
  config: join(HOME, 'config.json'),
  ticks: join(STATE, 'ticks.ndjson'),
  taking: join(STATE, 'ticks.taking.ndjson'),
  carry: join(STATE, 'carry.json'),
  outbox: join(STATE, 'outbox.json'),
  queue: join(STATE, 'queue.json'),
  current: join(STATE, 'current.json'),
  balance: join(STATE, 'balance.json'),
  milestones: join(STATE, 'milestones.json'),
  device: join(STATE, 'device.json'),
  pid: join(STATE, 'daemon.pid'),
  spinner: join(STATE, 'spinner.json'),
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
  milestones_micros: [5e6, 10e6, 25e6, 50e6, 100e6],
  spinner: true,
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

/** How long to wait before asking for creatives again. See fetchPlan. */
let fetchState = { until: 0, step: 0 };

async function cycle(cfg, device, cycleNo) {
  const now = Date.now();

  const ticks = takeTicks();
  if (ticks.length) {
    const { items, carry } = aggregate(ticks, readJson(P.carry, {}) ?? {}, cfg, now);
    writeJson(P.carry, carry);
    if (items.length) {
      const outbox = readJson(P.outbox, []) ?? [];
      outbox.push(buildBatch(items, device.salt));
      writeJson(P.outbox, outbox);
    }
  }

  if (!device.token) {
    const res = await request(cfg, 'POST', '/devices', { fingerprint: device.fingerprint });
    if (res.ok && res.json?.device_token) {
      device.token = res.json.device_token;
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
      const res = await request(cfg, 'GET', `/creatives?n=${plan.n}`, undefined, device.token);
      let gained = 0;
      if (res.ok && Array.isArray(res.json?.creatives)) {
        // The creative on screen counts as seen: the same line queued right
        // behind itself would be one ad for twice its window.
        const seen = new Set([...queue.map((c) => c.creative_id), onScreen?.creative_id].filter(Boolean));
        for (const c of res.json.creatives) {
          if (!c?.creative_id || typeof c.text !== 'string' || seen.has(c.creative_id)) continue;
          seen.add(c.creative_id);
          queue.push({
            creative_id: c.creative_id,
            text: c.text,
            ttl_sec: typeof c.ttl_sec === 'number' ? c.ttl_sec : 600,
            ...(typeof c.click_url === 'string' ? { click_url: c.click_url } : {}),
            ...(typeof c.promo_code === 'string' ? { promo_code: c.promo_code } : {}),
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
    const until = Date.now() + cfg.cycle_ms;
    while (Date.now() < until) {
      await sleep(Math.min(1000, until - Date.now()));
      try { rotateLocally(); } catch { /* the next cycle rotates anyway */ }
    }
  }
}

/** Between network cycles: move to the next queued creative once the current
 *  one expires. Disk only, never the network; written only when it changed. */
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

if (invokedDirectly()) {
  main();
}

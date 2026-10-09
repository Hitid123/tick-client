'use strict';
//
// TICK — the editor half of the renderer.
//
// Everything that decides anything lives in core.js. This file is the adapter:
// it reads files, draws a status bar item, appends ticks, and keeps the daemon
// alive. Nothing here talks to the network, because nothing here needs to —
// the daemon has done that since phase 1 and it is already cross-platform,
// which is also why this extension is the Windows story and no PowerShell
// client was ever written.

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const core = require('./core.js');

const HOME = process.env.TICK_HOME || path.join(os.homedir(), '.tick');
const STATE = path.join(HOME, 'state');
const P = {
  config: path.join(HOME, 'config.json'),
  daemon: path.join(HOME, 'daemon.mjs'),
  hook: path.join(HOME, 'hook.mjs'),
  opencodePlugin: path.join(HOME, 'opencode-plugin.js'),
  current: path.join(STATE, 'current.json'),
  balance: path.join(STATE, 'balance.json'),
  device: path.join(STATE, 'device.json'),
  carry: path.join(STATE, 'carry.json'),
  ticks: path.join(STATE, 'ticks.ndjson'),
  pid: path.join(STATE, 'daemon.pid'),
  activity: path.join(STATE, 'activity'),
  claims: path.join(STATE, 'claims'),
  installed: path.join(STATE, 'panel-hooks.json'),
  shipped: path.join(STATE, 'panel-files.json'),
  spinner: path.join(STATE, 'panel-spinner.json'),
};

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

// Codex keeps its own config, in TOML, in its own home. It cannot show our
// line in its terminal status line — that one is built from fixed elements and
// takes no external command — but in the editor it does not need to: the
// editor draws, and Codex only has to say when its model is working.
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');

// The editors that are VS Code underneath, each with its own agent and its own
// hook file. Paths read from the installed builds and their docs on 08.10.
const HOST = core.hostOf(vscode.env.appName);
const CURSOR_HOOKS = path.join(os.homedir(), '.cursor', 'hooks.json');
const DEVIN_CONFIG = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devin', 'config.json')
  : path.join(os.homedir(), '.config', 'devin', 'config.json');

// OpenCode has no command hooks; it loads plugins from this folder, and ours
// writes the same three-field note the hook does (client/opencode-plugin.js).
const OPENCODE_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const OPENCODE_PLUGIN = path.join(OPENCODE_DIR, 'plugins', 'tick.js');

/** Every agent we can register with, and the file each one keeps it in. */
const AGENT_TAGS = ['cc', 'cx', 'cu', 'dv', 'oc'];
const AGENT_FILES = {
  cc: '~/.claude/settings.json', cx: '~/.codex/config.toml', cu: '~/.cursor/hooks.json',
  dv: '~/.config/devin/config.json', oc: '~/.config/opencode/plugins/tick.js',
};

const DECLINED = 'tick.setUpDeclined';
const TICKS_MAX_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;

// ------------------------------------------------------------------- files

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value, pretty = false) {
  const tmp = `${file}.tick.tmp.${process.pid}`;
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeTextAtomic(file, text) {
  const tmp = `${file}.tick.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function stamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

/** Which agents are on this machine. Absence of a home directory is the
 *  honest signal: it only exists once the agent has actually been run. */
function agentsPresent() {
  return {
    cc: fs.existsSync(CLAUDE_DIR),
    cx: fs.existsSync(CODEX_DIR),
    // An editor's own agent matters only in that editor, and is there by
    // definition when we are.
    cu: HOST === 'cursor',
    dv: HOST === 'devin',
    oc: fs.existsSync(OPENCODE_DIR),
  };
}

/**
 * Append one tick, with the same 2 MB guard the status line uses: a backlog
 * that large means the daemon is dead and the ticks are stale anyway.
 */
function appendTick(tick) {
  try {
    if (!fs.existsSync(STATE)) return;
    let size = 0;
    try { size = fs.statSync(P.ticks).size; } catch { size = 0; }
    if (size > TICKS_MAX_BYTES) fs.writeFileSync(P.ticks, '');
    fs.appendFileSync(P.ticks, `${JSON.stringify(tick)}\n`);
  } catch { /* a lost tick costs a fraction of a cent; a thrown error costs trust */ }
}

/**
 * Session ids sitting in the not-yet-drained tail of ticks.ndjson, excluding
 * our own. Together with carry.json this answers "is a terminal already
 * counting this session", and it covers the up-to-30-second window before the
 * daemon's next cycle writes carry.json.
 */
function pendingTerminalSids() {
  try {
    const size = fs.statSync(P.ticks).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(P.ticks, 'r');
    try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }

    const out = new Set();
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        const t = JSON.parse(line);
        if (typeof t.sid === 'string' && !t.sid.startsWith('vsc:')) out.add(t.sid);
      } catch { /* a torn first line, or our own partial write */ }
    }
    return [...out];
  } catch { return []; }
}

// ------------------------------------------------------------------ runtime

/**
 * Which Node to run the daemon with.
 *
 * A real `node` on PATH is preferred: it is lighter and it outlives the editor
 * cleanly. Failing that we run the editor's own runtime as Node, which is what
 * makes this work on a machine that never ran install.sh — a Windows machine,
 * in practice.
 */
let nodeCmd = null;
function resolveNode() {
  if (nodeCmd !== null) return nodeCmd;
  try {
    const probe = spawnSync('node', ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8', timeout: 2000,
    });
    const major = Number(String(probe.stdout ?? '').trim());
    if (Number.isInteger(major) && major >= 20) {
      nodeCmd = { command: 'node', args: [], env: {} };
      return nodeCmd;
    }
  } catch { /* fall through to the editor's runtime */ }
  nodeCmd = { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return nodeCmd;
}

function daemonAlive() {
  const raw = (() => { try { return fs.readFileSync(P.pid, 'utf8').trim(); } catch { return ''; } })();
  if (!/^[0-9]+$/.test(raw)) return false;
  try { process.kill(Number(raw), 0); return true; } catch { return false; }
}

/** Same contract as statusline.sh: start it, never wait for it. */
function ensureDaemon(log) {
  if (!fs.existsSync(P.daemon) || daemonAlive()) return;
  const node = resolveNode();
  try {
    const child = spawn(node.command, [...node.args, P.daemon], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...node.env, TICK_HOME: HOME },
    });
    child.unref();
    log(`daemon started with ${node.command}`);
  } catch (e) {
    log(`daemon could not be started: ${e && e.message}`);
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Make ~/.tick usable without install.sh having ever run, and keep it that way.
 *
 * This is the whole Windows answer: the editor provides the runtime, the daemon
 * is already portable, and the shell script the terminal needs is not needed
 * here at all.
 *
 * "Copy if missing" was not enough, and that was a real bug rather than a rough
 * edge. The extension ships these two files, so when it updates they have to
 * update with it; an extension carrying a new hook next to a year-old copy of
 * it on disk is a silent, permanent version skew, and the symptom would be
 * money quietly not being counted.
 *
 * So we remember the hash of what we wrote. If the file on disk is still ours,
 * we refresh it. If it is not — install.sh put it there, or somebody edited it
 * — we leave it alone for good, the same rule the spinner follows for a key it
 * does not own.
 */
function ensureHome(context, log) {
  try {
    if (!fs.existsSync(STATE)) fs.mkdirSync(STATE, { recursive: true });

    const ours = readJson(P.shipped, {}) || {};
    // Files the daemon's own updater put in place (daemon.mjs, selfUpdate):
    // those follow the latest release, which this extension's copies, fixed at
    // whenever it was packaged, may be behind. Left alone while still theirs.
    const updated = readJson(path.join(STATE, 'updated.json'), {}) || {};
    let changed = false;

    // hook.mjs is ours outright: this extension is the only thing that installs
    // it, so there is no third party whose copy we could be stepping on, and
    // the hash bookkeeping below would only strand it. daemon.mjs is different
    // — install.sh puts that one there on a terminal install, and that
    // installation stays in charge of it.
    for (const [name, dest, alwaysOurs] of [
      ['daemon.mjs', P.daemon, false],
      ['hook.mjs', P.hook, true],
      ['opencode-plugin.js', P.opencodePlugin, true],
    ]) {
      const src = path.join(context.extensionPath, 'vendor', name);
      if (!fs.existsSync(src)) continue;

      const shipped = fs.readFileSync(src);
      const shippedHash = sha256(shipped);

      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, shipped);
        ours[name] = shippedHash;
        changed = true;
        log(`installed ${name}`);
        continue;
      }

      const onDisk = sha256(fs.readFileSync(dest));
      if (updated[name] === onDisk && onDisk !== shippedHash) continue;
      if (onDisk === shippedHash) {
        if (ours[name] !== shippedHash) { ours[name] = shippedHash; changed = true; }
        continue;
      }
      if (!alwaysOurs && ours[name] !== onDisk) {
        log(`${name} on disk is not ours, leaving it alone`);
        continue;
      }

      fs.writeFileSync(dest, shipped);
      ours[name] = shippedHash;
      changed = true;
      log(`updated ${name} to the version this extension ships`);
    }

    if (changed) writeJsonAtomic(P.shipped, ours);
    if (!fs.existsSync(P.config)) writeJsonAtomic(P.config, { own_line: '' }, true);
    return true;
  } catch (e) {
    log(`setup failed: ${e && e.message}`);
    return false;
  }
}

// -------------------------------------------------------------------- hooks

function hookCommand(agent = 'cc') {
  return `node "${P.hook}" ${agent}`;
}

/**
 * Register the activity hook in the user's settings file.
 *
 * This is the one file outside ~/.tick we touch, and the rules are the ones
 * install.sh already follows: back it up byte-for-byte first, add only our own
 * entry, never read or remove anyone else's, write atomically, and record what
 * we wrote so turning it off can take back exactly that and nothing more.
 */
function installHooks(log) {
  const command = hookCommand('cc');
  const existing = readJson(SETTINGS, null);
  const settings = existing === null || typeof existing !== 'object' || Array.isArray(existing)
    ? {}
    : existing;

  if (core.hooksInstalled(settings, command)) return { ok: true, already: true };

  try {
    if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS)) {
      fs.copyFileSync(SETTINGS, path.join(HOME, `settings.backup.${stamp()}.json`));
    }
    const { settings: withHooks } = core.addHooks(settings, command);
    const { settings: next } = core.addHeartbeat(withHooks, command);
    writeJsonAtomic(SETTINGS, next, true);
    writeJsonAtomic(P.installed, {
      ...(readJson(P.installed, {}) || {}), claude: command, events: core.HOOK_EVENTS, at: Date.now(),
    });
    log('Claude Code activity hook registered');
    return { ok: true, already: false };
  } catch (e) {
    log(`hook registration failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/**
 * Register the activity hook with Codex.
 *
 * Same promise as the Claude Code side, kept a different way because the file
 * is TOML: we append one marked block and never read or rewrite the rest. The
 * shape was checked against the installed codex-cli with `codex doctor`, which
 * has a strict parser — two plausible wrong forms are rejected as invalid data,
 * so "parse ok" on ours is worth something.
 *
 * Codex then asks the user to review the hook before it will run. That is its
 * own trust gate and we leave it alone: there is a flag to bypass it, and using
 * it would be the same move we refuse to make three times over.
 */
function installCodexHooks(log) {
  const command = hookCommand('cx');
  const existing = readText(CODEX_CONFIG);
  if (core.codexHooksInstalled(existing, command)) return { ok: true, already: true };

  try {
    if (!fs.existsSync(CODEX_DIR)) fs.mkdirSync(CODEX_DIR, { recursive: true });
    if (fs.existsSync(CODEX_CONFIG)) {
      fs.copyFileSync(CODEX_CONFIG, path.join(HOME, `codex-config.backup.${stamp()}.toml`));
    }
    const { text } = core.addCodexHooks(existing, command);
    writeTextAtomic(CODEX_CONFIG, text);
    writeJsonAtomic(P.installed, {
      ...(readJson(P.installed, {}) || {}), codex: command, events: core.HOOK_EVENTS, at: Date.now(),
    });
    log('Codex activity hook registered, pending its own review');
    return { ok: true, already: false };
  } catch (e) {
    log(`Codex hook registration failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/**
 * The heartbeat for installs made before it existed (see core.js). Our three
 * hooks there mean the person already agreed to this one entry of ours; it is
 * the same command, one more event, backed up first like every write.
 */
function ensureHeartbeat(log) {
  const command = hookCommand('cc');
  const settings = readJson(SETTINGS, null);
  if (!settings || typeof settings !== 'object' || !core.hooksInstalled(settings, command)) return;
  if (core.heartbeatInstalled(settings, command)) return;
  try {
    fs.copyFileSync(SETTINGS, path.join(HOME, `settings.backup.${stamp()}.json`));
    writeJsonAtomic(SETTINGS, core.addHeartbeat(settings, command).settings, true);
    log('Claude Code heartbeat added: a long turn keeps its line');
  } catch (e) {
    log(`heartbeat: ${e && e.message}`);
  }
}

/** Cursor's own agent: ~/.cursor/hooks.json, Cursor's format (see core.js). */
function installCursorHooks(log) {
  const command = hookCommand('cu');
  const existing = readJson(CURSOR_HOOKS, null);
  if (core.cursorHooksInstalled(existing, command)) return { ok: true, already: true };
  try {
    fs.mkdirSync(path.dirname(CURSOR_HOOKS), { recursive: true });
    if (fs.existsSync(CURSOR_HOOKS)) {
      if (existing === null) throw new Error('~/.cursor/hooks.json is not valid JSON; fix it first');
      fs.copyFileSync(CURSOR_HOOKS, path.join(HOME, `cursor-hooks.backup.${stamp()}.json`));
    }
    writeJsonAtomic(CURSOR_HOOKS, core.addCursorHooks(existing, command).file, true);
    writeJsonAtomic(P.installed, { ...(readJson(P.installed, {}) || {}), cursor: command, at: Date.now() });
    log('Cursor activity hook registered');
    return { ok: true, already: false };
  } catch (e) {
    log(`Cursor hook registration failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/** Devin: the "hooks" key of its user config, in Claude Code's own format —
 *  Devin adopted it whole. It also reads ~/.claude/settings.json, so where
 *  Claude Code is set up this is a second copy of the same entry, which only
 *  writes the same note twice. */
function installDevinHooks(log) {
  const command = hookCommand('cc');
  const existing = readJson(DEVIN_CONFIG, null);
  const config = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  if (core.hooksInstalled(config, command)) return { ok: true, already: true };
  try {
    fs.mkdirSync(path.dirname(DEVIN_CONFIG), { recursive: true });
    if (fs.existsSync(DEVIN_CONFIG)) {
      if (existing === null) throw new Error('the Devin config is not valid JSON; fix it first');
      fs.copyFileSync(DEVIN_CONFIG, path.join(HOME, `devin-config.backup.${stamp()}.json`));
    }
    writeJsonAtomic(DEVIN_CONFIG, core.addHooks(config, command).settings, true);
    writeJsonAtomic(P.installed, { ...(readJson(P.installed, {}) || {}), devin: command, at: Date.now() });
    log('Devin activity hook registered');
    return { ok: true, already: false };
  } catch (e) {
    log(`Devin hook registration failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/** OpenCode: our plugin file in its plugins folder, a copy of ~/.tick's. */
function installOpenCodePlugin(log) {
  try {
    const ours = fs.readFileSync(P.opencodePlugin);
    if (fs.existsSync(OPENCODE_PLUGIN) && fs.readFileSync(OPENCODE_PLUGIN).equals(ours)) return { ok: true, already: true };
    fs.mkdirSync(path.dirname(OPENCODE_PLUGIN), { recursive: true });
    fs.writeFileSync(OPENCODE_PLUGIN, ours);
    log('OpenCode activity plugin installed');
    return { ok: true, already: false };
  } catch (e) {
    log(`OpenCode plugin install failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

function installFor(agent, log) {
  if (agent === 'cc') return installHooks(log);
  if (agent === 'cx') return installCodexHooks(log);
  if (agent === 'cu') return installCursorHooks(log);
  if (agent === 'dv') return installDevinHooks(log);
  return installOpenCodePlugin(log);
}

function uninstallHooks(log) {
  const recorded = readJson(P.installed, null) || {};
  const ccCommand = recorded.claude || recorded.command || hookCommand('cc');
  const cxCommand = recorded.codex || hookCommand('cx');
  let ok = true;

  const settings = readJson(SETTINGS, null);
  if (settings && typeof settings === 'object') {
    try {
      const { settings: next, changed } = core.removeHooks(settings, ccCommand);
      if (changed) writeJsonAtomic(SETTINGS, next, true);
      log('Claude Code activity hook removed');
    } catch (e) {
      log(`hook removal failed: ${e && e.message}`);
      ok = false;
    }
  }

  const toml = readText(CODEX_CONFIG);
  if (toml.length > 0) {
    try {
      const { text, changed } = core.removeCodexHooks(toml);
      if (changed) writeTextAtomic(CODEX_CONFIG, text);
      log('Codex activity hook removed');
    } catch (e) {
      log(`Codex hook removal failed: ${e && e.message}`);
      ok = false;
    }
  }

  const cursor = readJson(CURSOR_HOOKS, null);
  if (cursor && typeof cursor === 'object') {
    try {
      const { file, changed } = core.removeCursorHooks(cursor, recorded.cursor || hookCommand('cu'));
      if (changed) { writeJsonAtomic(CURSOR_HOOKS, file, true); log('Cursor activity hook removed'); }
    } catch (e) { log(`Cursor hook removal failed: ${e && e.message}`); ok = false; }
  }

  const devin = readJson(DEVIN_CONFIG, null);
  if (devin && typeof devin === 'object') {
    try {
      const { settings: next, changed } = core.removeHooks(devin, recorded.devin || hookCommand('cc'));
      if (changed) { writeJsonAtomic(DEVIN_CONFIG, next, true); log('Devin activity hook removed'); }
    } catch (e) { log(`Devin hook removal failed: ${e && e.message}`); ok = false; }
  }

  // Only our own file: the same bytes we put there.
  try {
    if (fs.existsSync(OPENCODE_PLUGIN) && fs.existsSync(P.opencodePlugin)
        && fs.readFileSync(OPENCODE_PLUGIN).equals(fs.readFileSync(P.opencodePlugin))) {
      fs.unlinkSync(OPENCODE_PLUGIN);
      log('OpenCode activity plugin removed');
    }
  } catch (e) { log(`OpenCode plugin removal failed: ${e && e.message}`); ok = false; }

  try { fs.unlinkSync(P.installed); } catch { /* never written */ }
  return ok;
}

/** Recompute which agents are present but not yet registered. */
function refreshSetupState() {
  const present = agentsPresent();
  const have = registered();
  pendingSetup = AGENT_TAGS.filter((a) => present[a] && !have[a]);
}

/** Which agents we are registered with right now, read from their own files
 *  rather than from our own note about it. */
function registered() {
  return {
    cc: core.hooksInstalled(readJson(SETTINGS, {}) || {}, hookCommand('cc')),
    cx: core.codexHooksInstalled(readText(CODEX_CONFIG), hookCommand('cx')),
    cu: core.cursorHooksInstalled(readJson(CURSOR_HOOKS, null), hookCommand('cu')),
    dv: core.hooksInstalled(readJson(DEVIN_CONFIG, {}) || {}, hookCommand('cc'))
      || core.hooksInstalled(readJson(SETTINGS, {}) || {}, hookCommand('cc')),
    oc: fs.existsSync(OPENCODE_PLUGIN),
  };
}

// ----------------------------------------------------------------- the loop

let item = null;
let timer = null;
let clickUrl = '';
let lastText = '';
let counting = false;
let countingWorking = false;
let countingAgent = null;
let pendingSetup = [];   // agents on this machine we are not registered with yet
let lastFocusedTs = 0;   // when this window last had the person's attention
let cycleNo = 0;
const owner = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const sessions = new Map(); // sessionId -> { api_ms, dur_ms, lastTickTs }
let countedLast = null;      // the session this window counted last cycle

function log(channel, message) {
  try { channel.appendLine(`[${new Date().toISOString()}] ${message}`); } catch { /* disposed */ }
}

/** Read every hook mark. Few files, small files, and only ever two fields. */
function activityMarks() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(P.activity); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sessionId = core.safeSessionId(name.slice(0, -5));
    if (!sessionId) continue;
    const mark = readJson(path.join(P.activity, name), null);
    if (core.countsInEditor(mark, HOST, process.platform)) out.push({ sessionId, mark });
  }
  return out;
}

/**
 * Claim a session so that exactly one editor window counts it.
 *
 * Exclusive create is what makes this a lock rather than a suggestion, the
 * same trick the daemon uses for its pid file: two windows starting in the
 * same instant would otherwise both see "unclaimed" and both proceed.
 */
function claim(sessionId, now) {
  const file = path.join(P.claims, `${sessionId}.json`);
  try {
    if (!fs.existsSync(P.claims)) fs.mkdirSync(P.claims, { recursive: true });
    try {
      fs.writeFileSync(file, JSON.stringify({ owner, hb: now }), { flag: 'wx' });
      return true;
    } catch { /* already claimed, or a dead window left it behind */ }
    if (!core.claimIsOurs(readJson(file, null), owner, now)) return false;
    writeJsonAtomic(file, { owner, hb: now });
    return true;
  } catch { return false; }
}

/** Marks and claims from sessions that ended hours ago are litter, not data. */
function prune(now) {
  for (const [dir, maxAge] of [[P.activity, 6 * 3600_000], [P.claims, 3600_000]]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file);
      } catch { /* vanished under us, which is the outcome we wanted */ }
    }
  }
}

/**
 * The accounting half of a cycle.
 *
 * A tick is appended for a session only when all of this holds: the model has
 * worked recently, no terminal status line is already counting that session,
 * and this window holds the claim. Everything else renders the creative and
 * counts nothing — showing an ad is free, charging for it is not.
 */
function accountFor(view, now, channel) {
  counting = false;
  countingWorking = false;
  countingAgent = null;

  // A window nobody has looked at in two minutes is not showing anything to
  // anyone, whatever is running elsewhere on the machine.
  if (!core.windowIsLive(lastFocusedTs, now)) {
    sessions.clear();
    return;
  }

  const marks = activityMarks();
  if (marks.length === 0) return;

  const carry = readJson(P.carry, {}) || {};
  let pending = null; // read at most once per cycle, and only if needed

  // Every session this window could count.
  const candidates = [];
  for (const { sessionId, mark } of marks) {
    const { working, lastWorkTs } = core.activityOf(mark, now);
    if (!core.withinWindow(lastWorkTs, now)) {
      sessions.delete(sessionId);
      continue;
    }

    if (pending === null) pending = pendingTerminalSids();
    if (core.claimedByTerminal({ carry, pendingSids: pending, sessionId, now })) {
      sessions.delete(sessionId);
      continue;
    }
    candidates.push({ sessionId, mark, working });
  }

  // But one status bar is one display. Two agents busy in one window showed
  // one line and, until 08.10, wrote two streams of ticks for it: two
  // impressions for one thing on screen. Now the window counts one session,
  // the way the desktop strip always has — a working one first, the one it was
  // already counting next, then the most recent — and claims only that one,
  // so another window is free to count the rest.
  candidates.sort((a, b) => (Number(b.working) - Number(a.working))
    || (Number(b.sessionId === countedLast) - Number(a.sessionId === countedLast))
    || ((b.mark.ts || 0) - (a.mark.ts || 0)));
  const chosen = candidates.find((c) => claim(c.sessionId, now));
  for (const c of candidates) if (c !== chosen) sessions.delete(c.sessionId);
  countedLast = chosen ? chosen.sessionId : null;

  if (chosen) {
    const { sessionId, mark, working } = chosen;
    const { state, tick } = core.advance(sessions.get(sessionId), {
      sid: core.panelSid(sessionId),
      cid: view.cid,
      working,
      now,
    });
    sessions.set(sessionId, state);
    appendTick(tick);
    if (view.cid) {
      counting = true;
      if (working) countingWorking = true;
      countingAgent = typeof mark.ag === 'string' ? mark.ag : 'cc';
    }
  }

  if (cycleNo % 200 === 0) prune(now);
  if (cycleNo % 50 === 0) {
    log(channel, `sessions=${sessions.size} counting=${counting} working=${countingWorking}`);
  }
}

/**
 * The hover. A Markdown string, so the advertiser link is a link the reader can
 * see and click, instead of a status bar item that happens to be clickable.
 *
 * Never a trusted one: trusted Markdown in VS Code can carry command: URIs,
 * and the text in here came from a server over the wire. Untrusted plus the
 * escaping core.tooltip does means the only live link in the hover is the one
 * we validated ourselves.
 */
/**
 * Put the line into the panel's spinner too.
 *
 * Two things had to be found out before this could exist, both checked against
 * the installed build rather than assumed.
 *
 * The panel does honour spinnerVerbs, and it honours it live: it watches
 * `claudeCode.spinnerVerbs` and pushes a fresh state to its webview the moment
 * the setting changes. But it reads VS Code's own settings store, not the
 * ~/.claude/settings.json the daemon writes — same key name, different file,
 * which is why our word never arrived there.
 *
 * And VS Code refuses that key to every extension, because Claude Code reads it
 * without declaring it. The way through is not to edit the settings file behind
 * the editor's back; it is to declare the key in our own manifest, which we do.
 * The write then goes through the ordinary API and the editor handles the
 * formatting, the comments and the concurrent writes.
 *
 * The rules are the daemon's, unchanged. A paid creative replaces the rotation
 * so it is on screen every turn. The user's own line only appends, so an unsold
 * machine still looks like Claude Code's. Nothing to say removes the key and
 * the built-in verbs come back untouched. We write only when the value really
 * changes, which is once per creative rotation rather than once per cycle, and
 * if what is there was not put there by us we yield the key for good.
 *
 * Nothing here is billed. The impression is already counted on the status bar,
 * which can report what it displayed; this surface cannot. It is a second
 * placement for the advertiser, not a second sale.
 */
function syncSpinner(view, channel) {
  const cfg = readJson(P.config, {}) || {};
  const enabled = cfg.spinner !== false
    && vscode.workspace.getConfiguration('tick').get('enabled', true);

  const state = readJson(P.spinner, null);
  if (state && state.yielded === true) return;
  const ours = state ? state.wrote ?? null : null;

  const conf = vscode.workspace.getConfiguration('claudeCode');
  const theirs = conf.inspect('spinnerVerbs')?.globalValue;

  if (!core.spinnerIsOurs(theirs, ours)) {
    writeJsonAtomic(P.spinner, { wrote: null, yielded: true });
    log(channel, 'the panel spinner key belongs to someone else, leaving it alone for good');
    return;
  }

  const desired = core.spinnerVerbsFor({
    view,
    ownLine: typeof cfg.own_line === 'string' ? cfg.own_line : '',
    enabled,
  });
  if (JSON.stringify(desired ?? null) === JSON.stringify(ours ?? null)) return;

  conf.update('spinnerVerbs', desired ?? undefined, vscode.ConfigurationTarget.Global).then(
    () => {
      writeJsonAtomic(P.spinner, { wrote: desired });
      log(channel, `panel spinner: ${desired ? desired.verbs.join(' / ') : 'cleared'}`);
    },
    (err) => log(channel, `panel spinner not written: ${err && err.message}`),
  );
}

function tooltipFor(view) {
  const md = new vscode.MarkdownString(
    core.tooltip(view, { counting, working: countingWorking, agent: countingAgent }),
  );
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

function cycle(context, channel) {
  cycleNo += 1;
  const now = Date.now();
  if (vscode.window.state.focused) lastFocusedTs = now;

  if (!vscode.workspace.getConfiguration('tick').get('enabled', true)) {
    item.hide();
    return;
  }

  // Two small file reads, so not every cycle. Immediately after a setup run
  // the flag is refreshed by hand, so the call to action never lingers.
  if (cycleNo % 10 === 1) refreshSetupState();

  if (pendingSetup.length > 0) {
    const prompt = core.setupView(pendingSetup);
    if (prompt.text !== lastText) { item.text = prompt.text; lastText = prompt.text; }
    const md = new vscode.MarkdownString(prompt.tooltip);
    md.isTrusted = false;
    item.tooltip = md;
    item.command = 'tick.setUp';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.show();
    if (cycleNo % 10 === 1) ensureDaemon((m) => log(channel, m));
    return;
  }
  item.backgroundColor = undefined;

  const current = readJson(P.current, null);
  const view = core.render({
    current,
    config: readJson(P.config, {}) || {},
    balance: readJson(P.balance, null),
    now,
  });

  // Accounting runs before the tooltip is built so it can say, truthfully,
  // whether this window is the one counting.
  accountFor(view, now, channel);

  if (view.text.length === 0) {
    item.hide();
    lastText = '';
  } else {
    const text = core.statusText(view);
    if (text !== lastText) { item.text = text; lastText = text; }

    // The same two-step fade the terminal does, in the only way a status bar
    // item allows: one colour for the whole item. Theme colours rather than the
    // brand's hexes, because those are terminal values — #F0EEE9 is white, and
    // white on a light theme's status bar is nothing at all.
    item.color = core.offerIsFresh(current, now)
      ? undefined
      : new vscode.ThemeColor('descriptionForeground');

    item.tooltip = tooltipFor(view);
    clickUrl = view.url;
    item.command = view.url ? 'tick.openClick' : 'tick.status';
    item.show();
  }

  // Every cycle, and with the same `view` the status bar was just drawn from.
  // The two surfaces have to name the same advertiser at the same moment: a
  // spinner still saying Linear while the line below says Tailscale is an ad
  // nobody bought in a place nobody can check. Running this often is cheap
  // because it writes only when the value actually changes, which is once per
  // rotation; the rest of the time it is two small reads.
  try { syncSpinner(view, channel); } catch (e) { log(channel, `spinner: ${e && e.message}`); }

  if (cycleNo % 10 === 1) ensureDaemon((m) => log(channel, m));
}

// ----------------------------------------------------------------- commands

async function offerSetUp(context, channel, { force } = { force: false }) {
  if (!ensureHome(context, (m) => log(channel, m))) {
    vscode.window.showWarningMessage('TICK could not prepare ~/.tick. See the TICK output channel.');
    return false;
  }

  const present = agentsPresent();
  const have = registered();
  const todo = AGENT_TAGS.filter((a) => present[a] && !have[a]);
  if (todo.length === 0) return AGENT_TAGS.some((a) => present[a]);
  if (!force && context.globalState.get(DECLINED) === true) return false;

  const node = resolveNode();
  const detail = node.command === 'node'
    ? ''
    : ' Node 20+ was not found on PATH; the hook needs it, so install Node before setting up.';

  const names = todo.map((a) => core.agentName(a)).join(' and ');
  const files = todo.map((a) => AGENT_FILES[a]).join(' and ');

  const answer = await vscode.window.showInformationMessage(
    `TICK needs to know when ${names} is working, so it only counts a line that was actually on screen.`
    + ` It adds one hook to ${files} and backs the file up first.`
    + ' Nothing else is touched, and the hook records a timestamp, an event name and which agent it was'
    + ' — never your conversation.'
    + detail,
    'Set up', 'Not now',
  );

  if (answer !== 'Set up') {
    if (answer === 'Not now') context.globalState.update(DECLINED, true);
    return false;
  }

  const failed = [];
  for (const agent of todo) {
    const res = installFor(agent, (m) => log(channel, m));
    if (!res.ok) failed.push(`${core.agentName(agent)}: ${res.error}`);
  }
  if (failed.length > 0) {
    vscode.window.showWarningMessage(`TICK could not register its hook — ${failed.join('; ')}`);
    if (failed.length === todo.length) return false;
  }

  refreshSetupState();
  context.globalState.update(DECLINED, false);
  const enabled = vscode.workspace.getConfiguration('tick');
  if (enabled.get('enabled', true) !== true) await enabled.update('enabled', true, true);

  // Codex will not run a newly added hook until it has been reviewed, and
  // saying so is the difference between "set up" and "set up and silent".
  const note = todo.includes('cx')
    ? ' Codex will ask you to approve the new hook first — run /hooks inside Codex and trust it.'
    : '';
  vscode.window.showInformationMessage(
    `TICK is set up for ${names}. Start a turn and the line appears in the status bar.${note}`,
  );
  return true;
}

/**
 * The answer to "is this thing working", in words, without reading a log.
 *
 * It leads with why there is or is not a line, because that is the question
 * being asked. The accounting detail comes after.
 */
function showStatus(channel) {
  const now = Date.now();
  const balance = readJson(P.balance, null);
  const current = readJson(P.current, null);
  const config = readJson(P.config, {}) || {};
  const view = core.render({ current, config, balance, now });

  refreshSetupState();

  const why = core.diagnose({
    view,
    current,
    now,
    pendingSetup,
    daemonAlive: daemonAlive(),
    working: countingWorking,
    windowLive: core.windowIsLive(lastFocusedTs, now),
    claimedElsewhere: counting === false && sessions.size === 0 && activityMarks().length > 0,
    apiBase: typeof config.api_base === 'string' ? config.api_base : '',
  });

  const present = agentsPresent();
  const have = registered();
  const hooks = AGENT_TAGS
    .filter((a) => present[a])
    .map((a) => `${core.agentName(a)} ${have[a] ? 'registered' : 'not registered'}`)
    .join(', ') || 'no agent found on this machine';

  const detail = [
    `Hooks: ${hooks}`,
    `Background process: ${daemonAlive() ? 'running' : 'not running'}`,
    `Sessions this window counts: ${sessions.size}`,
    `Balance: $${core.usd(balance && balance.available)} to withdraw, $${core.usd(balance && balance.accrued)} earned`,
    `Account: ${balance && balance.account === true ? 'yes' : balance && balance.account === false ? 'not yet, make one with TICK: Open dashboard' : 'unknown yet'}`,
  ];

  log(channel, `status — ${why.join(' ')} | ${detail.join(' · ')}`);
  vscode.window.showInformationMessage(why.join(' '), 'Details', 'Dashboard', 'Open log').then((pick) => {
    if (pick === 'Details') vscode.window.showInformationMessage(detail.join('   ·   '));
    if (pick === 'Dashboard') openDashboard();
    if (pick === 'Open log') channel.show(true);
  });
}

/**
 * Payouts are requested in the dashboard, and the dashboard knows a computer
 * by the device token the daemon was issued. The token itself never goes into
 * the address, where browser history keeps it and a synced history carries it
 * off: the server trades it for a code good for one use within five minutes,
 * and the page opens with that (#c=…, after the #, which a browser never
 * sends). A server too old to trade it, or no network, gets the way before
 * 0.1.3: the token on the clipboard, to paste.
 */
async function openDashboard() {
  const config = readJson(P.config, {}) || {};
  const apiBase = typeof config.api_base === 'string' && config.api_base ? config.api_base : 'https://gettick.dev/api/v1';
  const url = core.dashboardUrl(apiBase);
  const device = readJson(P.device, null);
  const token = device && typeof device.token === 'string' ? device.token : '';
  if (!/^[0-9a-f]{32,128}$/.test(token)) {
    vscode.window.showInformationMessage(
      'This machine has not registered yet. It does so by itself the first time an agent turn runs; try again after one.',
    );
    return;
  }
  // A token is good on the server that issued it, and nowhere else.
  if (!device.api_base || device.api_base === apiBase) {
    try {
      const res = await fetch(`${apiBase}/account/handoff`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const json = await res.json();
      if (res.ok && /^[0-9a-f]{48}$/.test(String(json.code))) {
        vscode.env.openExternal(vscode.Uri.parse(`${url}#c=${json.code}`));
        return;
      }
    } catch { /* the clipboard, below */ }
  }
  await vscode.env.clipboard.writeText(token);
  vscode.env.openExternal(vscode.Uri.parse(url));
  vscode.window.showInformationMessage(
    'Your device token is on the clipboard. On the dashboard choose "I have a device token" and paste it. Treat it like a password.',
  );
}

// -------------------------------------------------------------------- entry

function activate(context) {
  const channel = vscode.window.createOutputChannel('TICK');
  context.subscriptions.push(channel);

  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'TICK';
  context.subscriptions.push(item);

  if (vscode.window.state.focused) lastFocusedTs = Date.now();
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) lastFocusedTs = Date.now();
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('tick.setUp', () => offerSetUp(context, channel, { force: true })),
    vscode.commands.registerCommand('tick.status', () => showStatus(channel)),
    vscode.commands.registerCommand('tick.dashboard', () => openDashboard()),
    vscode.commands.registerCommand('tick.openClick', () => {
      // The server counts the click at the other end of this redirect, exactly
      // as it does for the terminal's OSC 8 link. The client never reports a
      // click about itself.
      if (clickUrl) vscode.env.openExternal(vscode.Uri.parse(clickUrl));
    }),
    vscode.commands.registerCommand('tick.turnOff', async () => {
      uninstallHooks((m) => log(channel, m));
      try {
        if (((readJson(P.spinner, null) || {}).wrote ?? null) !== null) {
          await vscode.workspace.getConfiguration('claudeCode')
            .update('spinnerVerbs', undefined, vscode.ConfigurationTarget.Global);
        }
        fs.unlinkSync(P.spinner);
      } catch { /* never written, or already gone */ }
      refreshSetupState();
      await vscode.workspace.getConfiguration('tick').update('enabled', false, true);
      item.hide();
      vscode.window.showInformationMessage(
        'TICK is off. The hook is out of every config file we put it in, and they are back as they were.',
      );
    }),
  );

  ensureHome(context, (m) => log(channel, m));
  ensureHeartbeat((m) => log(channel, m));
  refreshSetupState();
  offerSetUp(context, channel).catch((e) => log(channel, `setup: ${e && e.message}`));

  timer = setInterval(() => {
    try { cycle(context, channel); } catch (e) { log(channel, `cycle: ${e && e.stack}`); }
  }, core.PANEL_DEFAULTS.tick_ms);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  // A minute in, so it never lands on top of the setup question.
  const hint = setTimeout(() => { try { suggestAccount(context); } catch { /* a hint */ } }, 60_000);
  context.subscriptions.push({ dispose: () => clearTimeout(hint) });

  log(channel, `activated in ${vscode.env.appName} (${HOST}), home=${HOME}`);
}

/**
 * Once there is money on this computer and no account to keep it in, say so,
 * at most once a week: an account keeps the earnings through a reinstall and
 * gathers several computers on one balance. The plugin for Claude Code says
 * the same in its own words.
 */
const ACCOUNT_HINT = 'tick.accountHintAt';
function suggestAccount(context) {
  const balance = readJson(P.balance, null);
  if (!balance || balance.account !== false || !(Number(balance.accrued) > 0)) return;
  const last = context.globalState.get(ACCOUNT_HINT, 0);
  if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
  context.globalState.update(ACCOUNT_HINT, Date.now());
  vscode.window.showInformationMessage(
    `TICK: you have earned $${core.usd(balance.accrued)}. Make an account so it stays yours if you reinstall, and your computers share one balance.`,
    'Open dashboard', 'Later',
  ).then((pick) => { if (pick === 'Open dashboard') openDashboard(); });
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };

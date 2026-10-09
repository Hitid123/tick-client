#!/usr/bin/env node
// TICK installer for Windows: the desktop strip for the Codex app and Cursor
// (and the Claude app where Claude Code's plugin cannot draw), and the TICK
// plugin for Claude Code, which draws the line itself in the terminal and in
// the Claude app.
//
//   iwr https://raw.githubusercontent.com/Hitid123/tick-client/main/install-windows.mjs -OutFile $env:TEMP\tick-install.mjs
//   node $env:TEMP\tick-install.mjs
//
//   node %USERPROFILE%\.tick\install-windows.mjs --report      what it sees, to send us
//   node %USERPROFILE%\.tick\install-windows.mjs --uninstall
//
// install.sh needs a POSIX shell and jq; this needs only Node, which the hook
// and the daemon need anyway. It downloads four files, checks every one against
// the published SHA256SUMS and stops without installing anything if one does
// not match.
//
// What it changes outside %USERPROFILE%\.tick, and nothing else:
//   - our hook entries in %USERPROFILE%\.claude\settings.json, in the same
//     form the editor extension and the Mac installer write, so they never
//     duplicate; backed up first;
//   - where Claude Code is installed, the TICK plugin, with Claude Code's own
//     `claude plugin install`;
//   - where Codex is installed, one marked block in .codex\config.toml;
//   - where OpenCode is installed, one plugin file in its plugins folder;
//   - one value under HKCU\...\CurrentVersion\Run, so the satellite starts at
//     login.
// --uninstall takes all of it back.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = process.env.TICK_REPO ?? 'Hitid123/tick-client';
let BASE = process.env.TICK_BASE ?? `https://raw.githubusercontent.com/${REPO}/main`;

// GitHub's file host caches "main" for a few minutes, file by file: just after
// a release one file can still be the old one while the checksums are new, and
// the install stops, rightly, on the mismatch (10.10). So the release is pinned
// to its commit first and every file comes from that one snapshot.
async function pinRelease() {
  if (process.env.TICK_BASE) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'tick-install' }, signal: AbortSignal.timeout(15_000),
    });
    const sha = (await res.text()).trim();
    if (res.ok && /^[0-9a-f]{40}$/.test(sha)) BASE = `https://raw.githubusercontent.com/${REPO}/${sha}`;
  } catch { /* main, as before */ }
}
const HOME = process.env.TICK_HOME ?? join(homedir(), '.tick');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const MANIFEST = join(HOME, 'install.manifest.json');
const EXE = join(HOME, 'tick-satellite.exe');
const FILES = ['daemon.mjs', 'hook.mjs', 'opencode-plugin.js', 'tick-satellite-windows.exe', 'install-windows.mjs'];
const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const CODEX_CONFIG = join(CODEX_DIR, 'config.toml');
const CODEX_CMD = `node "${join(HOME, 'hook.mjs')}" cx`;
const OPENCODE_PLUGIN = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'plugins', 'tick.js');
// Cursor's own hook file. Cursor on Windows did not run Claude Code's hooks
// (the owner's report of 08.10 had no Cursor turn at all), so ours goes here,
// in Cursor's format, beside anyone else's.
const CURSOR_DIR = join(homedir(), '.cursor');
const CURSOR_HOOKS = join(CURSOR_DIR, 'hooks.json');
const CURSOR_CMD = `node "${join(HOME, 'hook.mjs')}" cu`;
const CURSOR_EVENTS = ['beforeSubmitPrompt', 'stop', 'sessionEnd'];
// A status line of ours from the version that set one (08.10, briefly): taken
// back now that the plugin draws the line in the terminal.
const isOurStatusLine = (sl) => String(sl?.command ?? '').includes('.tick') && String(sl?.command ?? '').includes('statusline.sh');
const EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd'];
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// The tests run this on a Mac against a sandbox: everything that would reach
// the real system — the registry, other processes — stays out of it.
const SYSTEM = platform() === 'win32' && process.env.TICK_NO_SYSTEM !== '1';
// Exactly the extension's command: path.join gives the same backslashes.
const HOOK_CMD = `node "${join(HOME, 'hook.mjs')}" cc`;

const say = (m) => process.stdout.write(`tick: ${m}\n`);
const die = (m) => { process.stderr.write(`tick: ${m}\n`); process.exit(1); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const quiet = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch { /* not there: fine */ } };

// Bytes, not text: one of the files is a compiled program. A local directory
// as TICK_BASE is how the tests feed it the repository's own files.
async function fetchBytes(name) {
  if (!/^https?:/.test(BASE)) {
    try { return readFileSync(join(BASE, name)); } catch { die(`could not read ${name}; nothing was installed`); }
  }
  const res = await fetch(`${BASE}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) die(`could not download ${name} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function stopSatellite() {
  // A running program's file cannot be replaced on Windows, so it stops first.
  if (SYSTEM) quiet('taskkill', ['/IM', 'tick-satellite.exe', '/F']);
}

// The daemon keeps running the code it started with. After an update it would
// go on with the old version until it happened to exit, so it is stopped too;
// the satellite starts the new one within half a minute.
function stopDaemon() {
  if (!SYSTEM) return;
  let pid = 0;
  try { pid = Number(readFileSync(join(HOME, 'state', 'daemon.pid'), 'utf8').trim()); } catch { /* not running */ }
  if (Number.isInteger(pid) && pid > 0) quiet('taskkill', ['/PID', String(pid), '/F']);
}

// PostToolUse is the heartbeat: every tool call renews a long turn, run in the
// background (async) so the agent never waits for it. See hook.mjs.
const HEARTBEAT = 'PostToolUse';
const ours = (groups) => Array.isArray(groups) && groups.some((g) => g?.hooks?.some((h) => h?.command === HOOK_CMD));

/** Returns what was added: the three turn hooks (then all four are ours), only
 *  the heartbeat (the editor extension owns the three), or nothing. */
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// Seconds Codex gives our hook. Codex runs hooks on Windows through a
// PowerShell of its own, inside its package's sandbox, and on the owner's
// Windows 10 PC with Avast that took 3007 ms and 3010 ms against timeout = 3,
// and those turns lost their mark, while a warm run took 1235 ms (Codex's own
// hook/started and hook/completed, 09.10). Ten for the two that start and end
// a turn; never more than three for SessionEnd, which Codex clamps to three
// with a warning printed into the user's terminal. The editor extension
// writes the same numbers.
const codexTimeout = (e) => (e === 'SessionEnd' ? 3 : 10);

function codexBlock() {
  const body = EVENTS.map((e) => [
    `[[hooks.${e}]]`, 'matcher = ""', `[[hooks.${e}.hooks]]`, 'type = "command"',
    `command = ${JSON.stringify(CODEX_CMD)}`, `timeout = ${codexTimeout(e)}`,
  ].join('\n')).join('\n\n');
  return ['# >>> TICK activity hook — added by the TICK installer',
    '# Remove it with install-windows.mjs --uninstall. Codex will ask you to review',
    '# this hook before it runs; that is its own trust check, and we do not get around it.',
    body, '# <<< TICK activity hook'].join('\n');
}

/** Our block taken out of config.toml, and nothing else: Codex appends its own
 *  tables after the last one, which is ours, so they land inside our fence —
 *  [windows] sandbox and the trust it keeps for our hooks on the owner's PC,
 *  09.10. What goes is the markers, our comments and each [[hooks.<event>]]
 *  whose handlers all run our hook; every other table stays, byte for byte.
 *  The same as removeCodexHooks in the editor extension and in uninstall.sh. */
function stripCodexBlock(s) {
  const START = '# >>> TICK activity hook', END = '# <<< TICK activity hook';
  const start = s.indexOf(START);
  const endMark = start === -1 ? -1 : s.indexOf(END, start);
  if (endMark === -1) return null;
  const tables = [[]];
  for (const line of s.slice(start, endMark).split('\n')) {
    if (/^\s*\[/.test(line)) tables.push([]);
    tables[tables.length - 1].push(line);
  }
  const runsOurs = (t) => t.some((l) => /^\s*command\s*=.*hook\.mjs\\?"?\s+cx"\s*$/.test(l));
  const kept = [];
  for (let i = 1; i < tables.length; i++) {
    const m = /^\s*\[\[hooks\.([A-Za-z]+)\]\]\s*$/.exec(tables[i][0]);
    if (!m) { kept.push(tables[i]); continue; }
    let j = i + 1;
    while (j < tables.length && tables[j][0].trim() === `[[hooks.${m[1]}.hooks]]`) j++;
    const handlers = tables.slice(i + 1, j);
    if (!(handlers.length > 0 && handlers.every(runsOurs))) kept.push(...tables.slice(i, j));
    i = j - 1;
  }
  const theirs = kept.map((t) => t.join('\n')).join('\n').replace(/\s+$/, '');
  const before = s.slice(0, start).replace(/\n+$/, start > 0 ? '\n' : '');
  const after = s.slice(endMark + END.length).replace(/^\n+/, '');
  const middle = theirs ? `${before.length > 0 ? '\n' : ''}${theirs}\n${after ? '\n' : ''}` : '';
  return `${before}${middle}${after}`;
}

function removeCodexBlock() {
  const next = stripCodexBlock(readText(CODEX_CONFIG));
  if (next === null) return;
  if (next.trim() === '') rmSync(CODEX_CONFIG, { force: true }); else writeFileSync(CODEX_CONFIG, next);
  say('removed our hook from Codex\'s config.toml');
}

function addHooks(settings) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const basePresent = EVENTS.every((ev) => ours(settings.hooks[ev]));
  let added = false;
  for (const ev of [...EVENTS, HEARTBEAT]) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (!ours(groups)) {
      groups.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5, ...(ev === HEARTBEAT ? { async: true } : {}) }] });
      added = true;
    }
    settings.hooks[ev] = groups;
  }
  return !added ? 'none' : basePresent ? 'heartbeat' : 'all';
}

function removeHooks(settings, events = [...EVENTS, HEARTBEAT]) {
  if (!settings?.hooks || typeof settings.hooks !== 'object') return;
  for (const ev of events) {
    if (!Array.isArray(settings.hooks[ev])) continue;
    settings.hooks[ev] = settings.hooks[ev]
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => h?.command !== HOOK_CMD) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

async function install() {
  const apiAt = process.argv.indexOf('--api-base');
  const apiBase = apiAt > 0 ? process.argv[apiAt + 1] : '';

  await pinRelease();
  say(`fetching the client from ${BASE}`);
  const sums = new Map((await fetchBytes('SHA256SUMS')).toString('utf8')
    .split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
  const bodies = new Map();
  for (const name of FILES) {
    const body = await fetchBytes(name);
    const want = sums.get(name);
    if (!want) die(`${name} is missing from the published checksums; nothing was installed`);
    if (sha256(body) !== want) die(`${name} does not match its published checksum; nothing was installed`);
    bodies.set(name, body);
  }
  say('checksums verified');

  // Read and check settings.json before changing anything at all: a file we
  // cannot parse stops the install with nothing written anywhere.
  const hadFile = existsSync(SETTINGS);
  const raw = hadFile ? readFileSync(SETTINGS, 'utf8') : '';
  let settings = {};
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch { die(`${SETTINGS} is not valid JSON; fix it before installing`); }
  }

  stopSatellite();
  stopDaemon();
  mkdirSync(join(HOME, 'state'), { recursive: true });
  writeFileSync(join(HOME, 'daemon.mjs'), bodies.get('daemon.mjs'));
  writeFileSync(join(HOME, 'hook.mjs'), bodies.get('hook.mjs'));
  writeFileSync(join(HOME, 'opencode-plugin.js'), bodies.get('opencode-plugin.js'));
  writeFileSync(EXE, bodies.get('tick-satellite-windows.exe'));
  writeFileSync(join(HOME, 'install-windows.mjs'), bodies.get('install-windows.mjs'));
  // Started at login there is no PATH guarantee; the satellite reads this to
  // start the daemon with the same Node that ran the installer.
  writeFileSync(join(HOME, 'node-path.txt'), process.execPath);

  const configPath = join(HOME, 'config.json');
  const config = readJson(configPath, null) ?? { own_line: '' };
  if (apiBase) config.api_base = apiBase;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // settings.json: the first install's backup is the one uninstall restores, so
  // a reinstall keeps it rather than backing up a file that already has us in.
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const prev = readJson(MANIFEST, null);
  const backup = prev?.backup && existsSync(prev.backup)
    ? prev.backup
    : join(HOME, `settings.backup.${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
  if (!prev?.backup || !existsSync(prev.backup)) writeFileSync(backup, raw);
  const added = addHooks(settings);
  // The plugin draws the line in the terminal; a status line of ours from the
  // briefly published version that set one goes.
  if (isOurStatusLine(settings.statusLine)) delete settings.statusLine;
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);

  // The TICK plugin, with Claude Code's own command, where Claude Code is
  // installed: it draws the line above the prompt in the terminal and in the
  // Claude app, and the strip stands aside over Claude for it. Through a
  // shell, since claude is claude.exe or an npm claude.cmd.
  let plugin = prev?.plugin_added ?? false;
  if (SYSTEM) {
    try {
      execFileSync('claude', ['plugin', 'marketplace', 'add', 'Hitid123/tick-client'], { stdio: 'ignore', shell: true, timeout: 120_000 });
    } catch { /* already added, or no claude: the install below says which */ }
    try {
      execFileSync('claude', ['plugin', 'install', 'tick@tick'], { stdio: 'ignore', shell: true, timeout: 120_000 });
      plugin = true;
      // Claude Code updates plugins from a marketplace like ours only when
      // that marketplace has auto-update on, off by default for all but
      // Anthropic's own. On here, so new versions arrive by themselves.
      const now = readJson(SETTINGS, null);
      if (now?.extraKnownMarketplaces?.tick && now.extraKnownMarketplaces.tick.autoUpdate !== true) {
        now.extraKnownMarketplaces.tick.autoUpdate = true;
        writeFileSync(SETTINGS, `${JSON.stringify(now, null, 2)}\n`);
      }
    } catch {
      say('Claude Code was not found, so its plugin is not installed; the strip covers the Claude app');
    }
  }

  // The Codex app (and Codex in a terminal or editor) runs hooks from
  // config.toml: one marked block, the same the Mac installer and the editor
  // extension write, nothing else in the file read or rewritten.
  let codexAdded = prev?.codex_added ?? false;
  if (existsSync(CODEX_DIR) && !readText(CODEX_CONFIG).includes('# >>> TICK activity hook')) {
    const text = readText(CODEX_CONFIG);
    if (text) copyFileSync(CODEX_CONFIG, join(HOME, 'codex-config.backup.toml'));
    const base = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
    writeFileSync(CODEX_CONFIG, `${base}${base ? '\n' : ''}${codexBlock()}\n`);
    codexAdded = true;
  }

  // Cursor: three entries in its own hooks.json, where Cursor has been run.
  let cursorAdded = prev?.cursor_added ?? false;
  if (existsSync(CURSOR_DIR)) {
    const had = existsSync(CURSOR_HOOKS);
    const file = had ? readJson(CURSOR_HOOKS, null) : { version: 1, hooks: {} };
    if (file && typeof file === 'object') {
      file.version = file.version ?? 1;
      file.hooks = file.hooks && typeof file.hooks === 'object' ? file.hooks : {};
      let changed = !had;
      for (const e of CURSOR_EVENTS) {
        const list = Array.isArray(file.hooks[e]) ? file.hooks[e] : [];
        if (!list.some((h) => h?.command === CURSOR_CMD)) { list.push({ command: CURSOR_CMD, timeout: 5 }); changed = true; }
        file.hooks[e] = list;
      }
      if (changed) {
        if (had) copyFileSync(CURSOR_HOOKS, join(HOME, 'cursor-hooks.backup.json'));
        writeFileSync(CURSOR_HOOKS, `${JSON.stringify(file, null, 2)}\n`);
        cursorAdded = true;
      }
    } else {
      say('Cursor\'s hooks.json is not valid JSON; Cursor is left out');
    }
  }

  // OpenCode: one plugin file, where OpenCode has been run.
  let opencode = prev?.opencode_plugin ?? null;
  if (existsSync(join(OPENCODE_PLUGIN, '..', '..'))) {
    mkdirSync(join(OPENCODE_PLUGIN, '..'), { recursive: true });
    writeFileSync(OPENCODE_PLUGIN, bodies.get('opencode-plugin.js'));
    opencode = OPENCODE_PLUGIN;
  }
  writeFileSync(MANIFEST, `${JSON.stringify({
    settings: SETTINGS,
    backup,
    had_file: prev ? prev.had_file : hadFile,
    wrote_hash: sha256(readFileSync(SETTINGS)),
    // Already there means the editor extension put it there, and it stays its own.
    hook: added === 'all' || prev?.hook ? HOOK_CMD : null,
    heartbeat: added === 'heartbeat' || prev?.heartbeat ? HOOK_CMD : null,
    plugin_added: plugin,
    cursor_added: cursorAdded,
    codex_added: codexAdded,
    opencode_plugin: opencode,
  }, null, 2)}\n`);

  if (SYSTEM) {
    execFileSync('reg', ['add', RUN_KEY, '/v', 'TICK', '/t', 'REG_SZ', '/d', `"${EXE}"`, '/f'], { stdio: 'ignore' });
    // Started by Explorer, as at login, not as our own child: a program started
    // from a shell can belong to that shell's job and die with it, which is how
    // a strip started from a tool's shell on the owner's PC went away (09.10).
    spawn('explorer.exe', [EXE], { detached: true, stdio: 'ignore' }).unref();
  }

  say('installed.');
  process.stdout.write(`
  The Claude app, the Codex app and Cursor now show one short sponsored line by the
  message box while their AI works, marked "Ad"; Claude Code in a terminal shows it
  above the prompt. A click opens the advertiser.
${codexAdded && !prev?.codex_added ? `
  Codex asks to review a new hook once before it runs it: allow ours when it does.
` : ''}
  It sees only where each window is, never what is in it.
  What it sees: node "${join(HOME, 'install-windows.mjs')}" --report
  Turn it off:  "desktop": {"enabled": false} in ${configPath}
  Remove it:    node "${join(HOME, 'install-windows.mjs')}" --uninstall

`);
}

function uninstall() {
  stopSatellite();
  stopDaemon();
  if (SYSTEM) quiet('reg', ['delete', RUN_KEY, '/v', 'TICK', '/f']);

  const m = readJson(MANIFEST, null);
  if (m && existsSync(SETTINGS)) {
    const now = readFileSync(SETTINGS);
    if (sha256(now) === m.wrote_hash && existsSync(m.backup)) {
      // Untouched since install: put it back byte for byte, or remove it if it
      // did not exist before.
      if (m.had_file) copyFileSync(m.backup, SETTINGS); else rmSync(SETTINGS, { force: true });
      say('restored settings.json byte for byte');
    } else if (m.hook || m.heartbeat) {
      const settings = readJson(SETTINGS, null);
      if (settings) {
        removeHooks(settings, m.hook ? undefined : [HEARTBEAT]);
        if (isOurStatusLine(settings.statusLine)) delete settings.statusLine;
        writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
        say('settings.json changed since install; removed only our hook entries');
      }
    }
  }
  if (m?.plugin_added && SYSTEM) {
    for (const args of [['plugin', 'uninstall', 'tick@tick'], ['plugin', 'marketplace', 'remove', 'tick']]) {
      try { execFileSync('claude', args, { stdio: 'ignore', shell: true, timeout: 60_000 }); } catch { /* already gone */ }
    }
    say('removed the Claude Code plugin');
  }
  if (m?.codex_added) removeCodexBlock();
  if (m?.cursor_added && existsSync(CURSOR_HOOKS)) {
    const file = readJson(CURSOR_HOOKS, null);
    if (file?.hooks && typeof file.hooks === 'object') {
      for (const [e, list] of Object.entries(file.hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter((h) => h?.command !== CURSOR_CMD);
        if (kept.length > 0) file.hooks[e] = kept; else delete file.hooks[e];
      }
      const onlyOurs = Object.keys(file.hooks).length === 0 && Object.keys(file).every((k) => k === 'version' || k === 'hooks');
      if (onlyOurs) rmSync(CURSOR_HOOKS, { force: true }); else writeFileSync(CURSOR_HOOKS, `${JSON.stringify(file, null, 2)}\n`);
      say('removed our hook from Cursor');
    }
  }
  if (m?.opencode_plugin && existsSync(m.opencode_plugin)) {
    rmSync(m.opencode_plugin, { force: true });
    say('removed our OpenCode plugin');
  }
  rmSync(HOME, { recursive: true, force: true });
  say('removed. Nothing of TICK is left on this machine.');
}

if (platform() !== 'win32' && process.env.TICK_NO_SYSTEM !== '1' && !process.argv.includes('--report')) {
  die('this installer is for Windows. On a Mac or Linux: curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh | sh');
}
/**
 * What this machine looks like from TICK's side, to paste into a chat with us:
 * the strip's own log, which agents reported a turn and when, what is sold
 * right now, and which config files carry our hook. Never the conversation,
 * never a token, never a path beyond our own files.
 */
function report() {
  const now = Date.now();
  const ago = (ts) => (typeof ts === 'number' ? `${Math.round((now - ts) / 1000)} s ago` : '?');
  say(`report ${new Date().toISOString()}`);
  const pid = Number(readText(join(HOME, 'state', 'daemon.pid')).trim()) || 0;
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
  say(`background process: ${alive ? 'running' : 'not running'}`);
  const cur = readJson(join(HOME, 'state', 'current.json'), null);
  say(cur ? `line: ${cur.expires_at > now ? 'live' : 'expired'} — "${cur.text}"` : 'line: none yet');
  const settings = readJson(SETTINGS, {}) ?? {};
  say(`Claude Code hooks: ${EVENTS.every((e) => JSON.stringify(settings.hooks?.[e] ?? '').includes('hook.mjs')) ? 'yes' : 'no'}, heartbeat: ${JSON.stringify(settings.hooks?.PostToolUse ?? '').includes('hook.mjs') ? 'yes' : 'no'}`);
  say(`Claude Code plugin: ${settings.enabledPlugins?.['tick@tick'] === true ? 'enabled' : 'not installed'}`);
  const beat = readJson(join(HOME, 'state', 'mod-desktop.json'), null);
  say(`plugin drawing in the Claude app: ${beat ? `signalled ${ago(beat.ts)}` : 'never yet'}`);
  say(`Codex config: ${existsSync(CODEX_CONFIG) ? (readText(CODEX_CONFIG).includes('TICK activity hook') ? 'has our hook' : 'no hook of ours') : 'not found'}`);
  say(`OpenCode plugin: ${existsSync(OPENCODE_PLUGIN) ? 'yes' : 'no'}`);
  say(`Cursor hooks: ${readText(CURSOR_HOOKS).includes('hook.mjs') ? 'has our hook' : existsSync(CURSOR_DIR) ? 'no hook of ours' : 'Cursor not found'}`);
  say('recent turns (agent, event, when):');
  const dir = join(HOME, 'state', 'activity');
  let marks = [];
  try { marks = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f), null)).filter(Boolean); } catch { /* none */ }
  marks.sort((a, b) => b.ts - a.ts).slice(0, 8).forEach((m) => say(`  ${m.ag}  ${m.ev}  ${ago(m.ts)}`));
  say('strip log (last 25 lines):');
  readText(join(HOME, 'state', 'satellite.log')).trim().split('\n').slice(-25).forEach((l) => say(`  ${l}`));
}

if (process.argv.includes('--report')) report();
else if (process.argv.includes('--uninstall')) uninstall();
else await install();

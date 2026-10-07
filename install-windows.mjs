#!/usr/bin/env node
// TICK installer for Windows: the desktop satellite for the Claude app.
//
//   iwr https://raw.githubusercontent.com/Hitid123/tick-client/main/install-windows.mjs -OutFile $env:TEMP\tick-install.mjs
//   node $env:TEMP\tick-install.mjs
//
//   node %USERPROFILE%\.tick\install-windows.mjs --uninstall
//
// install.sh needs a POSIX shell and jq; this needs only Node, which the hook
// and the daemon need anyway. It downloads four files, checks every one against
// the published SHA256SUMS and stops without installing anything if one does
// not match.
//
// What it changes outside %USERPROFILE%\.tick, and nothing else:
//   - three hook entries in %USERPROFILE%\.claude\settings.json, in the same
//     form the editor extension and the Mac installer write, so they never
//     duplicate; the file is backed up first;
//   - one value under HKCU\...\CurrentVersion\Run, so the satellite starts at
//     login.
// --uninstall takes all of it back.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = process.env.TICK_REPO ?? 'Hitid123/tick-client';
const BASE = process.env.TICK_BASE ?? `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = process.env.TICK_HOME ?? join(homedir(), '.tick');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const MANIFEST = join(HOME, 'install.manifest.json');
const EXE = join(HOME, 'tick-satellite.exe');
const FILES = ['daemon.mjs', 'hook.mjs', 'tick-satellite-windows.exe', 'install-windows.mjs'];
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
  if (!/^https?:/.test(BASE)) return readFileSync(join(BASE, name));
  const res = await fetch(`${BASE}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) die(`could not download ${name} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function stopSatellite() {
  // A running program's file cannot be replaced on Windows, so it stops first.
  if (SYSTEM) quiet('taskkill', ['/IM', 'tick-satellite.exe', '/F']);
}

function addHooks(settings) {
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  let added = false;
  for (const ev of EVENTS) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (!groups.some((g) => g?.hooks?.some((h) => h?.command === HOOK_CMD))) {
      groups.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] });
      added = true;
    }
    settings.hooks[ev] = groups;
  }
  return added;
}

function removeHooks(settings) {
  if (!settings?.hooks || typeof settings.hooks !== 'object') return;
  for (const ev of EVENTS) {
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
  mkdirSync(join(HOME, 'state'), { recursive: true });
  writeFileSync(join(HOME, 'daemon.mjs'), bodies.get('daemon.mjs'));
  writeFileSync(join(HOME, 'hook.mjs'), bodies.get('hook.mjs'));
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
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(MANIFEST, `${JSON.stringify({
    settings: SETTINGS,
    backup,
    had_file: prev ? prev.had_file : hadFile,
    wrote_hash: sha256(readFileSync(SETTINGS)),
    // Already there means the editor extension put it there, and it stays its own.
    hook: added || prev?.hook ? HOOK_CMD : null,
  }, null, 2)}\n`);

  if (SYSTEM) {
    execFileSync('reg', ['add', RUN_KEY, '/v', 'TICK', '/t', 'REG_SZ', '/d', `"${EXE}"`, '/f'], { stdio: 'ignore' });
    spawn(EXE, [], { detached: true, stdio: 'ignore' }).unref();
  }

  say('installed.');
  process.stdout.write(`
  The Claude desktop app now shows one short sponsored line under its message box
  while Claude works, marked "Ad". Drag it sideways to move it within that row;
  a click opens the advertiser.

  It sees only where Claude's window is, never what is in it.
  Turn it off:  "desktop": {"enabled": false} in ${configPath}
  Remove it:    node "${join(HOME, 'install-windows.mjs')}" --uninstall

`);
}

function uninstall() {
  stopSatellite();
  if (SYSTEM) {
    quiet('reg', ['delete', RUN_KEY, '/v', 'TICK', '/f']);
    let pid = 0;
    try { pid = Number(readFileSync(join(HOME, 'state', 'daemon.pid'), 'utf8').trim()); } catch { /* not running */ }
    if (Number.isInteger(pid) && pid > 0) quiet('taskkill', ['/PID', String(pid), '/F']);
  }

  const m = readJson(MANIFEST, null);
  if (m && existsSync(SETTINGS)) {
    const now = readFileSync(SETTINGS);
    if (sha256(now) === m.wrote_hash && existsSync(m.backup)) {
      // Untouched since install: put it back byte for byte, or remove it if it
      // did not exist before.
      if (m.had_file) copyFileSync(m.backup, SETTINGS); else rmSync(SETTINGS, { force: true });
      say('restored settings.json byte for byte');
    } else if (m.hook) {
      const settings = readJson(SETTINGS, null);
      if (settings) {
        removeHooks(settings);
        writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
        say('settings.json changed since install; removed only our hook entries');
      }
    }
  }
  rmSync(HOME, { recursive: true, force: true });
  say('removed. Nothing of TICK is left on this machine.');
}

if (platform() !== 'win32' && process.env.TICK_NO_SYSTEM !== '1') {
  die('this installer is for Windows. On a Mac or Linux: curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh | sh');
}
if (process.argv.includes('--uninstall')) uninstall(); else await install();

#!/usr/bin/env node
// What the Claude desktop app on Windows actually does, measured before anything
// is built for it. Three questions, the same three the Mac answered:
//
//   1. does it run Claude Code hooks at all,
//   2. does it say it is the desktop app (CLAUDE_CODE_ENTRYPOINT=claude-desktop),
//   3. with which shell, and is Node on its PATH.
//
//   node probe.mjs install     back up settings.json, add a probe hook
//   (send one message in the Claude desktop app)
//   node probe.mjs report      what the hook saw, and what this machine has
//   node probe.mjs uninstall   put settings.json back
//
// The hook records a time, the event name, the entrypoint, the shell and the
// Node version. Never the prompt, never the transcript: it does not read the
// payload beyond the event name.

import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const BACKUP = join(HOME, 'tick-probe.settings-backup.json');
const LOG = join(HOME, 'tick-probe.log');
const SELF = resolve(fileURLToPath(import.meta.url));
const COMMAND = `node "${SELF}" hook`;
const EVENTS = ['UserPromptSubmit', 'Stop'];

const say = (m) => process.stdout.write(`${m}\n`);
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };

function install() {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, BACKUP); else writeFileSync(BACKUP, '');
  const settings = readJson(SETTINGS, {});
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const ev of EVENTS) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (!groups.some((g) => g?.hooks?.some((h) => h?.command === COMMAND))) {
      groups.push({ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] });
    }
    settings.hooks[ev] = groups;
  }
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  rmSync(LOG, { force: true });
  say('Probe installed. Now open the Claude desktop app, start or open a session in its');
  say('Code tab, send any short message, wait for the answer, then run:  node probe.mjs report');
}

function hook() {
  let ev = '';
  try { ev = String(JSON.parse(readFileSync(0, 'utf8') || '{}').hook_event_name ?? ''); } catch { /* no payload */ }
  const line = {
    ts: new Date().toISOString(),
    ev,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
    shell: process.env.SHELL ?? process.env.ComSpec ?? null,
    node: process.version,
  };
  try { appendFileSync(LOG, `${JSON.stringify(line)}\n`); } catch { /* never fail the user's turn */ }
  process.exit(0);
}

function report() {
  const claudeConfig = readJson(join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Claude', 'config.json'), null);
  say(`OS: ${platform()} ${release()}   Node here: ${process.version}`);
  say(`Claude desktop config found: ${claudeConfig ? 'yes' : 'no'}`);
  if (claudeConfig) {
    say(`  theme setting (userThemeMode): ${claudeConfig.userThemeMode ?? 'absent'}`);
    say(`  sidebar layout (bootFrameLayout): ${claudeConfig.bootFrameLayout ? JSON.stringify(claudeConfig.bootFrameLayout) : 'absent'}`);
  }
  const lines = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : [];
  if (lines.length === 0) {
    say('Hook: NOT called. Either no message was sent yet, or the desktop app does not run hooks here.');
  } else {
    say(`Hook: called ${lines.length} time(s):`);
    for (const l of lines) say(`  ${l}`);
  }
}

function uninstall() {
  // Takes out exactly our two entries and whatever container is left empty
  // because of it, rather than restoring the backup over anything that changed
  // in between. The backup stays on disk until this succeeds.
  const settings = readJson(SETTINGS, null);
  if (settings?.hooks && typeof settings.hooks === 'object') {
    for (const ev of EVENTS) {
      if (!Array.isArray(settings.hooks[ev])) continue;
      settings.hooks[ev] = settings.hooks[ev]
        .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => h?.command !== COMMAND) } : g))
        .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
      if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    const before = readFileSync(BACKUP, 'utf8');
    if (before === '' && Object.keys(settings).length === 0) rmSync(SETTINGS, { force: true });
    else writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  }
  rmSync(BACKUP, { force: true });
  say('Probe removed from settings.json; everything else in it is as it was.');
}

const cmd = process.argv[2];
if (cmd === 'install') install();
else if (cmd === 'hook') hook();
else if (cmd === 'report') report();
else if (cmd === 'uninstall') uninstall();
else say('usage: node probe.mjs install | report | uninstall');

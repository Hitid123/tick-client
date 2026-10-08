// TICK for Claude Code, as a mod: the sponsored line drawn by Claude Code
// itself, in the band above the prompt, in the terminal and in the Claude
// app's Code tab alike. No window of ours laid over Claude's, nothing to place.
//
// It is one more renderer of the client that is already there, not a second
// client. The daemon still does all the network and all the money — the one
// in ~/.tick if the client was installed, otherwise the copy this plugin
// carries (runtime/daemon.mjs), run with the same ~/.tick for its state:
// it picks the line (state/current.json) and turns ticks into impressions.
// This file reads that line, draws it while Claude works, and appends the same
// three-second ticks every other surface appends (TZ section 4.1):
//
//   - drawn while a turn runs, gone the moment it ends;
//   - a tick every three seconds while drawn; api_ms grows only while the
//     turn runs, so the daemon's aggregate() counts it as it counts the rest;
//   - in a terminal where our status line already shows the line, the band
//     stays empty and counts nothing: one display, one impression;
//   - in the Claude app it tells the desktop strip to stand aside
//     (state/mod-desktop.json, every three seconds while the session lives
//     there), for the same reason.
//
// What it reads: the files of ours in ~/.tick, the session's id, whether a
// turn is running, and Claude's theme setting. Never a prompt, a message or a
// tool call: no hook here is on any of those events.

// Out the moment the turn ends: the owner, 08.10, "as soon as it stops, it
// should go". It used to stay four seconds.
const LINGER_MS = 0
const TICK_MS = 3000
const BEAT_MS = 3000

const ACCENTS = {
  amber: ['#FFB000', '#8F5600'], green: ['#3DD68C', '#1A7044'], teal: ['#33D6C9', '#0D6E66'],
  blue: ['#62AEFF', '#1F5FBF'], violet: ['#B794FF', '#6A3FC2'], pink: ['#FF85BE', '#A8235F'],
  coral: ['#FF7466', '#B42318'],
}

let home = ''          // ~/.tick
let node = 'node'      // the Node that runs the daemon
let sid = ''
let ourStatusLine = false
let creative = null    // the live line from current.json, or null
let working = false
let workEndedAt = 0
let lastShown = { terminal: 0, desktop: 0 }
let renderWorking = false
let counter = { api: 0, dur: 0, last: 0 }
let pending = []       // tick lines not yet appended
let lightTheme = false

export function register(on) {
  on('session.start', async ($, e, next) => {
    inApp = e.surface === 'desktop'
    await $.command.register({ name: 'tick', description: 'TICK: what the sponsored line is doing' })
    await setUp($)
    $.clock.every(1000, () => pulse($))
    // While a turn runs and nothing is on screen yet, look for a line four
    // times a second: one arriving mid-turn shows within a quarter second.
    $.clock.every(250, () => (working && !creative ? refresh($) : undefined))
    $.clock.every(TICK_MS, () => count($))
    $.clock.every(30000, () => ensureDaemon($))
    return next(e)
  })

  // e.text is the prompt: never read. Only the fact that a turn began.
  on('turn.start', async ($, e, next) => {
    working = true
    // The line as it stands this instant, not as of the last second's read,
    // so the band lights up with the turn rather than up to a second after.
    await refresh($)
    $.ui.invalidate('ui.render')
    // A daemon that went idle between turns is woken, without holding the
    // turn up for it.
    void ensureDaemon($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working = false
    workEndedAt = await $.clock.now()
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const surface = e.surface === 'desktop' ? 'desktop' : 'terminal'
    const now = await $.clock.now()
    renderWorking = e.props.isWorking
    const visible = e.props.isWorking || working || now - workEndedAt < LINGER_MS
    if (!creative || !visible || (surface === 'terminal' && ourStatusLine)) return next(e)

    lastShown[surface] = now

    const { Box, Text, Link } = $.ui.resolve(e)
    const pair = ACCENTS[creative.accent] || ACCENTS.amber
    const accent = surface === 'desktop' && lightTheme ? pair[1] : pair[0]
    const parts = split(creative.text, creative.promo_code)
    const words = [
      parts.name ? Text({ color: accent, bold: true, children: [parts.name] }) : null,
      Text({ color: 'text', children: [parts.before] }),
      parts.promo ? Text({ color: accent, bold: true, children: [parts.promo] }) : null,
      parts.after ? Text({ color: 'text', children: [parts.after] }) : null,
    ].filter(Boolean)
    return Box({
      flexDirection: 'row',
      children: [
        Text({ color: 'subtle', children: ['Ad  '] }),
        creative.click_url && (surface === 'desktop' || terminalLinks)
          ? Link({ href: creative.click_url, children: words })
          : Box({ flexDirection: 'row', children: words }),
      ],
    })
  })

  on('command.run', { command: 'tick' }, async ($) => {
    const bundled = await $.fs.exists(`${$.plugin.root}/runtime/daemon.mjs`)
    const shown = (await $.clock.now()) - Math.max(lastShown.terminal, lastShown.desktop) < TICK_MS * 2
    const line = creative ? `“${creative.text}”` : 'nothing sold right now'
    return {
      text: [
        `line: ${line}`,
        `drawn: ${shown ? 'yes' : 'not right now (only while Claude works)'}`,
        `terminal: ${ourStatusLine ? 'the status line shows it, so the band stays empty' : 'the band shows it'}`,
        `home: ${home}${bundled ? '' : ' (the plugin\'s own daemon copy is missing: reinstall the plugin)'}`,
        noNode ? 'Node.js was not found: install it from nodejs.org and start a new session' : `daemon: started with ${node}`,
      ].join('\n'),
    }
  })
}

// ------------------------------------------------------------------ helpers

async function setUp($) {
  const explicit = await $.env.get('TICK_HOME')
  // Windows first: under Git Bash HOME reads /c/Users/..., a path Windows
  // programs, and so $.fs, do not open. USERPROFILE is the real one there and
  // absent on a Mac.
  const user = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  home = (explicit || `${user}/.tick`).replace(/\\/g, '/')
  sid = await $.session.id()
  const program = (await $.env.get('TERM_PROGRAM')) || ''
  const term = (await $.env.get('TERM')) || ''
  terminalLinks = Boolean(await $.env.get('WT_SESSION')) || Boolean(await $.env.get('KITTY_WINDOW_ID'))
    || /iTerm|vscode|WezTerm|ghostty|Hyper|Tabby|rio|WarpTerminal/i.test(program)
    || /kitty|ghostty|alacritty|foot|wezterm/i.test(term)
  try {
    const settings = await $.settings.read()
    ourStatusLine = String(settings?.statusLine?.command ?? '').includes('.tick')
  } catch { ourStatusLine = false }
  // Windows: the installer wrote the Node it ran with, since a login item has
  // no PATH to count on.
  try { node = (await $.fs.read(`${home}/node-path.txt`)).trim() || 'node' } catch { node = 'node' }
  try {
    const config = JSON.parse(await $.fs.read(`${user}/Library/Application Support/Claude/config.json`))
    lightTheme = config.userThemeMode === 'light'
  } catch { lightTheme = false }
  await ensureDaemon($)
  await refresh($)
}

// Once a second. The band is drawn when Claude Code redraws it, and it does
// not redraw on its own while nothing changes: until 08.10 the band went
// stale mid-turn, the strip over the window took that for "the mod is gone"
// and came back, and the mod's own ticks, timed from redraws, counted nothing.
// So while a turn runs, or lingers, the band is redrawn every second, and the
// strip is told every few seconds that the line is on screen here.
async function pulse($) {
  await refresh($)
  const now = await $.clock.now()
  // Where this session is drawn. Not settled at session.start in the Claude
  // app (its surface attaches after), so asked again every few seconds.
  if (now - surfacesAt > 5000) {
    surfacesAt = now
    try { inApp = (await $.session.surfaces()).includes('desktop') } catch { /* keep the last answer */ }
  }
  // And once more when it should go: without that last redraw the band kept
  // its line after the linger, on screen and no longer counted (08.10).
  const visible = Boolean(creative) && (working || renderWorking || now - workEndedAt < LINGER_MS)
  if (visible || wasVisible) $.ui.invalidate('ui.render')
  wasVisible = visible
  // As long as this session lives in the Claude app, not only while the line
  // shows: otherwise the strip saw a stale signal at the start of every turn
  // and showed itself for the second before the band did.
  if ((inApp || now - lastShown.desktop < 2000) && now - lastBeat > BEAT_MS) {
    lastBeat = now
    await $.fs.write(`${home}/state/mod-desktop.json`, JSON.stringify({ ts: now }))
  }
}
let lastBeat = 0
let wasVisible = false
let inApp = false
let lastUsd = null
// Whether the terminal turns a link into a clickable word. Where it cannot,
// Claude Code prints the address after the text — the owner's PowerShell
// window on 08.10 showed the line followed by gettick.dev/c/… — so there the
// line goes out as plain text. Known by what the terminal says about itself.
let terminalLinks = false
let surfacesAt = 0

// The live line, as the daemon left it. Redrawn only when it changes.
async function refresh($) {
  let next = null
  try {
    const c = JSON.parse(await $.fs.read(`${home}/state/current.json`))
    if (c && typeof c.text === 'string' && c.text && c.expires_at > (await $.clock.now())) {
      next = {
        id: typeof c.creative_id === 'string' ? c.creative_id : null,
        text: clean(c.text).slice(0, 60),
        promo_code: typeof c.promo_code === 'string' ? clean(c.promo_code) : '',
        accent: typeof c.accent === 'string' ? c.accent : 'amber',
        click_url: safeUrl(c.click_url),
      }
    }
  } catch { next = null }
  const changed = JSON.stringify(next) !== JSON.stringify(creative)
  creative = next
  if (changed) $.ui.invalidate('ui.render')
}

// One tick per period while the band shows, as every other surface does.
async function count($) {
  const now = await $.clock.now()
  // Drawn within the last two seconds: with a redraw every second while it
  // shows, a gap longer than that means it is not on screen.
  const shown = now - Math.max(lastShown.terminal, lastShown.desktop) < 2000
  if (!shown || !creative || !creative.id) {
    counter = { api: 0, dur: 0, last: 0 }
  } else {
    const elapsed = counter.last > 0 ? Math.max(0, Math.min(now - counter.last, TICK_MS * 2)) : 0
    // Model time grows only when the model really answered: the session's
    // cost went up since the last tick. That is the terminal's own rule, where
    // cost.total_api_duration_ms moves as each response lands, and it is the
    // whole economic defence: the owner's PowerShell on 08.10 showed the line
    // through "API error · Retrying", a turn running with no model behind it,
    // which a turn-boundary rule would have paid for. Where the host keeps no
    // cost ledger, the turn boundaries are all there is.
    let busy = working || renderWorking
    try {
      const usd = (await $.session.usage()).cost?.usd
      if (typeof usd === 'number') {
        busy = lastUsd !== null && usd > lastUsd
        lastUsd = usd
      }
    } catch { /* keep the turn rule */ }
    counter = { api: counter.api + (busy ? elapsed : 0), dur: counter.dur + elapsed, last: now }
    pending.push(JSON.stringify({
      ts: now, sid: `mod:${sid}`, cid: creative.id, api_ms: counter.api, dur_ms: counter.dur, model: null,
    }))
  }
  if (pending.length === 0) return
  // $.fs.write replaces a file; ticks.ndjson is shared with the status line
  // and drained by the daemon, so lines are appended by a one-line Node
  // process, the way the other surfaces append.
  const lines = pending.join('\n') + '\n'
  pending = []
  try {
    await $.process.run([node, '-e', APPEND, `${home}/state/ticks.ndjson`], { stdin: lines, timeoutMs: 5000 })
  } catch { /* the next period tries again with its own ticks; these are dropped, never doubled */ }
}

const APPEND = "const fs=require('fs');const f=process.argv[1];try{if(fs.statSync(f).size>2097152)fs.writeFileSync(f,'')}catch{}fs.appendFileSync(f,fs.readFileSync(0))"

// The daemon does the network. Started if it is not running, detached so it
// outlives the session; it refuses to run twice by itself.
async function ensureDaemon($) {
  try {
    const r = await $.process.run([node, '-e', LAUNCH, home, `${$.plugin.root}/runtime/daemon.mjs`], { timeoutMs: 5000 })
    noNode = r.exitCode !== 0 && /not found|ENOENT/i.test(String(r.stderr))
  } catch { noNode = true }
}
let noNode = false

// The installed client's daemon if there is one, else the plugin's own copy;
// either way with ~/.tick as its home, and either way only one runs.
const LAUNCH = "const fs=require('fs'),p=require('path'),{spawn}=require('child_process');const h=process.argv[1];let alive=false;try{process.kill(+fs.readFileSync(p.join(h,'state','daemon.pid'),'utf8'),0);alive=true}catch{}const own=p.join(h,'daemon.mjs');const d=fs.existsSync(own)?own:process.argv[2];if(!alive&&fs.existsSync(d))spawn(process.execPath,[d],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,TICK_HOME:h}}).unref()"

// The advertiser's name (before an early colon), and the promo code: its
// first occurrence after the name. The same split as every other surface.
function split(text, promo) {
  const i = text.indexOf(':')
  const name = i > 0 && [...text.slice(0, i)].length <= 24 ? text.slice(0, i) : ''
  const rest = name ? text.slice(name.length) : text
  const at = promo ? rest.indexOf(promo) : -1
  if (at < 0) return { name, before: rest, promo: '', after: '' }
  return { name, before: rest.slice(0, at), promo, after: rest.slice(at + promo.length) }
}

// A line, never a cursor movement: control characters and escapes go.
function clean(s) {
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(u) ? u : ''
}

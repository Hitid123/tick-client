import { expect, mock, test } from 'claude-code/testing'

// The line the daemon left in current.json.
const LINE = {
  creative_id: 'c1', text: 'Acme: deploy fast · GO5', promo_code: 'GO5', accent: 'green',
  click_url: 'https://gettick.dev/c/tok', shown_at: 0, expires_at: 9e15,
}

// What Claude Code passes for the band above the prompt.
const BAND = {
  plugin: 'tick',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// Everything the mod asks Claude Code for, answered here; what it writes and
// what it runs, collected.
function machine(on, { statusLine = '', line = LINE as typeof LINE | null, surfaces = ['desktop'] as string[], env = { HOME: '/Users/dev' } as Record<string, string>, costStep = 0.01, dashboard = {} as Record<string, unknown>, marketplace = null as null | Record<string, unknown>, stored = {} as Record<string, unknown>, balance = null as null | Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  const runs: any[] = []
  const writes: any[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.surfaces', () => ({ value: surfaces }))
  // The session's cost, as /cost totals it: rising while the model answers.
  let usd = 0
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: (usd += costStep) } } }))
  on('settings.read', () => ({ value: {
    ...(statusLine ? { statusLine: { type: 'command', command: statusLine } } : {}),
    ...(marketplace ? { extraKnownMarketplaces: { tick: marketplace } } : {}),
  } }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  // The store that outlives sessions.
  const store = new Map<string, unknown>(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('fs.read', ($, e) => {
    if (line && e.path.endsWith('/.tick/state/current.json')) return { value: JSON.stringify(line) }
    if (balance && e.path.endsWith('/.tick/state/balance.json')) return { value: JSON.stringify(balance) }
    return { deny: 'no such file' }
  })
  on('fs.write', ($, e) => { writes.push(e); return { value: undefined } })
  on('fs.exists', () => ({ value: true }))
  // `daemon.mjs --dashboard` answers with one line of JSON.
  on('process.run', ($, e) => {
    runs.push(e)
    return { value: { exitCode: 0, stdout: e.argv.includes('--dashboard') ? JSON.stringify(dashboard) : '', stderr: '' } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  // The ticks the mod appended, in order, from the stdin of its append runs.
  const ticks = () => runs
    .filter((r) => String(r.argv?.[3] ?? '').endsWith('/state/ticks.ndjson'))
    .flatMap((r) => String(r.init?.stdin ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  return { clock, runs, writes, ticks, toasts }
}

async function start($, surface: 'terminal' | 'desktop') {
  await $.session.start({ surface, isInteractive: true, cwd: '/work' })
}

test('during a turn the band shows the line: marked Ad, clickable, in the advertiser colour', async ($, on) => {
  machine(on)
  await start($, 'desktop')
  await $.turn.start({ turnId: 't1', text: 'never read' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Ad  ' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: LINE.click_url } })
  expect(await ui.find({ type: 'Text', text: 'Acme' })).toMatchObject({ props: { color: '#3DD68C', bold: true } })
  expect(await ui.find({ type: 'Text', text: 'GO5' })).toMatchObject({ props: { color: '#3DD68C', bold: true } })
})

test('a terminal that cannot make a link clickable gets the line without its address', async ($, on) => {
  machine(on)  // HOME only: no Windows Terminal, no known program
  await start($, 'terminal')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Acme' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('Windows Terminal makes it a link', async ($, on) => {
  machine(on, { env: { HOME: '/Users/dev', WT_SESSION: 'abc' } })
  await start($, 'terminal')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: LINE.click_url } })
})

test('in a terminal that already has our status line, the band is left to Claude Code', async ($, on) => {
  machine(on, { statusLine: '/Users/dev/.tick/statusline.sh' })
  await start($, 'terminal')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
})

test('a turn is counted as the other surfaces count it, and stops after the linger', async ($, on) => {
  const { clock, ticks, writes } = machine(on)
  await start($, 'desktop')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (let i = 0; i < 15; i++) await clock.advance(1000)

  const during = ticks()
  expect(during.length >= 4).toBe(true)
  for (const t of during) expect(t).toMatchObject({ sid: 'mod:abc', cid: 'c1', model: null })
  // Model time grows with wall time while the turn runs, a tick at a time.
  const last = during[during.length - 1]
  expect(last.api_ms > 0).toBe(true)
  expect(last.api_ms).toBe(last.dur_ms)
  // The strip over the window is told the line is on screen here.
  expect(writes.some((w) => String(w.path).endsWith('/state/mod-desktop.json'))).toBe(true)

  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 15000, reason: 'answer', usage: null })
  // Claude Code draws the band again with the turn over.
  await ui.unmount()
  const idle = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false }, surface: 'desktop' })
  for (let i = 0; i < 12; i++) await clock.advance(1000)
  const after = ticks()
  const tail = after.slice(during.length)
  // While it lingers the line is still on screen, but the model is not working.
  for (const t of tail) expect(t.api_ms).toBe(last.api_ms)
  // And then it is gone, and nothing more is counted.
  const settled = after.length
  for (let i = 0; i < 10; i++) await clock.advance(1000)
  expect(ticks().length).toBe(settled)
  expect(await idle.find({ type: 'Link' })).toBeUndefined()
  await idle.unmount()
})

test('in the Claude app the strip is told to stand aside even before anything is drawn', async ($, on) => {
  // The app attaches after session.start, which reports no surface yet.
  const { clock, writes } = machine(on, { line: null })
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  for (let i = 0; i < 12; i++) await clock.advance(1000)
  expect(writes.some((w) => String(w.path).endsWith('/state/mod-desktop.json'))).toBe(true)
})

test('in a terminal the strip is never told to stand aside', async ($, on) => {
  const { clock, writes } = machine(on, { line: null, surfaces: ['terminal'] })
  await start($, 'terminal')
  for (let i = 0; i < 12; i++) await clock.advance(1000)
  expect(writes.some((w) => String(w.path).endsWith('/state/mod-desktop.json'))).toBe(false)
})

test('on Windows the home is USERPROFILE, not the HOME Git Bash spells /c/Users/...', async ($, on) => {
  const runs: any[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/c/Users/dev', USERPROFILE: 'C:\\Users\\dev' })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'abc' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('process.run', ($, e) => { runs.push(e); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const launch = runs.find((r) => String(r.argv?.[2] ?? '').includes('daemon.pid'))
  expect(launch.argv[3]).toBe('C:/Users/dev/.tick')
  // A daemon started from the Claude app opens no console window.
  expect(launch.argv[2]).toContain('windowsHide:true')
})

test('a turn whose model never answers is shown but not paid for', async ($, on) => {
  // "API error · Retrying": the turn runs, the cost does not move.
  const { clock, ticks } = machine(on, { costStep: 0 })
  await start($, 'desktop')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (let i = 0; i < 15; i++) await clock.advance(1000)
  const all = ticks()
  expect(all.length >= 4).toBe(true)
  for (const t of all) expect(t.api_ms).toBe(0)
  await ui.unmount()
})

test('with nothing sold the band is empty and nothing is counted', async ($, on) => {
  const { clock, ticks } = machine(on, { line: null })
  await start($, 'desktop')
  await $.turn.start({ turnId: 't1', text: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (let i = 0; i < 8; i++) await clock.advance(1000)
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(ticks().length).toBe(0)
})

test('/tick-dashboard opens the cabinet through the daemon, with the token traded for a one-time code', async ($, on) => {
  const { runs } = machine(on, { dashboard: { opened: true, signed_in: true, registered: true } })
  await start($, 'terminal')
  const r = await $.command.run({ command: 'tick-dashboard' })
  const run = runs.find((x) => x.argv.includes('--dashboard'))
  expect(String(run.argv[1]).endsWith('/runtime/daemon.mjs')).toBe(true)
  expect(run.init.env.TICK_HOME).toBe('/Users/dev/.tick')
  // The token never reaches the command line or the transcript.
  expect(JSON.stringify(run.argv)).not.toContain('token')
  expect(r.text).toContain('signed in as this computer')
})

test('/tick-dashboard where no browser opens gives the address to open by hand', async ($, on) => {
  machine(on, { dashboard: { opened: false, signed_in: true, registered: true, url: 'https://gettick.dev/dashboard#c=ab' } })
  await start($, 'terminal')
  const r = await $.command.run({ command: 'tick-dashboard' })
  expect(r.text).toContain('https://gettick.dev/dashboard#c=ab')
  expect(r.text).toContain('five minutes')
})

const MARKET = { source: { source: 'github', repo: 'Hitid123/tick-client' } }

test('the first session says what TICK is and where the earnings are, once', async ($, on) => {
  const { toasts, clock } = machine(on, { marketplace: { ...MARKET, autoUpdate: true } })
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/tick-dashboard')
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
})

test('with money earned and no account, it suggests one, at most weekly', async ($, on) => {
  const { toasts, clock } = machine(on, { marketplace: { ...MARKET, autoUpdate: true }, stored: { welcomed: 1 }, balance: { accrued: 1_230_000, account: false } })
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('$1.23')
  expect(toasts[0]).toContain('Make an account')
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
  const r = await $.command.run({ command: 'tick' })
  expect(r.text).toContain('account: not yet')
})

test('with an account, nothing is suggested', async ($, on) => {
  const { toasts, clock } = machine(on, { marketplace: { ...MARKET, autoUpdate: true }, stored: { welcomed: 1 }, balance: { accrued: 1_230_000, account: true } })
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(0)
  expect((await $.command.run({ command: 'tick' })).text).toContain('account: yes')
})

test('installed from our marketplace with auto-update off, it says once how to turn it on', async ($, on) => {
  const { toasts, clock } = machine(on, { marketplace: MARKET, stored: { welcomed: 1 } })
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/plugin → Marketplaces → tick')
  // Not again within the week.
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(1)
  const r = await $.command.run({ command: 'tick' })
  expect(r.text).toContain('the daemon updates itself')
})

test('with auto-update on, nothing is said', async ($, on) => {
  const { toasts, clock } = machine(on, { marketplace: { ...MARKET, autoUpdate: true }, stored: { welcomed: 1 } })
  await start($, 'terminal')
  await clock.settle()
  expect(toasts.length).toBe(0)
})

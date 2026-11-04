import { expect, mock, test } from 'claude-code/testing'

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

// Everything outside the mod, answered beneath it: usage, the session id, the
// cache-length script, files, the store and toasts.
function setup(on: TestOn, opts: { ttl?: () => string; store?: Record<string, unknown>; limits?: () => unknown[] } = {}) {
  const files: Record<string, string> = {}
  const store: Record<string, unknown> = opts.store ?? {}
  const toasts: string[] = []
  const forks: string[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async () => ({}) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('prompt.submit', async ($, e) => ({ text: (e as { text: string }).text }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('env.get', async () => ({ value: '/Users/test' }) as never)
  on('session.usage', async () =>
    ({
      value: {
        context: {
          tokens: 182_000,
          window: 1_000_000,
          percent: 18,
          breakdown: { categories: [{ name: 'Messages', tokens: 150_000, kind: 'used' }, { name: 'Free space', tokens: 800_000, kind: 'free' }] },
        },
        rateLimits: opts.limits?.() ?? [],
      },
    }) as never,
  )
  on('process.run', async ($, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'date') return { value: { exitCode: 0, stdout: '20:32\n', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: `${opts.ttl?.() ?? '5m'}\n`, stderr: '' } } as never
  })
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] ?? '' }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('store.get', async ($, e) => ({ value: store[(e as { key: string }).key] }) as never)
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store[key] = value
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('model.fork', async ($, e) => {
    forks.push((e as { prompt: string }).prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 182_000, cache_creation_input_tokens: 0 } } } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>REST</Text>
  })
  return { files, store, toasts, forks }
}

const props = (isWorking = false) => ({ isWorking, hasSurvey: false, maxRows: 10, bodyColumns: 120 }) as never
const run = async ($: TestDollar, args: string) => JSON.stringify(await $.command.run({ command: 'context-pane', args } as never))

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the cache bar counts down, colours by zone and goes grey when lost (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    expect(await v.find({ text: /182k/ }), 'context figures').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^ ?182k \/ 1m/ }))?.props.color, 'total in the GOOD label colour').toBe('#00ACC1')
    expect(await v.find({ text: /Cache/ }), 'no cache bar before the first reply').toBeUndefined()

    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    await clock.advance(30_000)
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^4:30 left/ }), '4:30 left of a 5 min cache').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^4:30 left/ }))?.props.color, 'FRESH label colour').toBe('#1E8E3E')
    expect(await v.find({ type: 'Button', text: '⏱ 5 min' }), 'cache length').toBeDefined()

    // The ⏱ switch flips the timer to 1 hour and back, and remembers it.
    await v.press({ key: 'cache-ttl' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), 'switched to 1 hour').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^59:30 left/ }), 'counts from 1 hour').toBeDefined()
    await v.press({ key: 'cache-ttl' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 5 min' }), 'back to 5 min').toBeDefined()

    // The same by command.
    expect(await run($, '1h'), '/context-pane 1h').toContain('Cache timer: 1 hour')
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), '1 hour by command').toBeDefined()
    expect(await run($, '5m'), '/context-pane 5m').toContain('Cache timer: 5 min')
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 5 min' }), '5 min by command').toBeDefined()
    expect((await v.find({ key: 'cache-keepwarm' }))?.text, 'keep warm icon').toBe('♨')
    expect(await v.find({ key: 'cache-hide' }), 'hide icon').toBeDefined()
    expect(await v.find({ text: 'REST' }), 'other rows still draw').toBeDefined()

    // 20 s left: WARNING, its caption in the theme's blue, its label light blue in dark mode.
    await clock.advance(4 * 60_000 + 10_000)
    v = await mount()
    expect((await v.find({ type: 'Text', text: /^0:20 left/ }))?.props.color, 'WARNING caption follows the theme').toBe('suggestion')
    if (surface === 'desktop') {
      const svgs = await v.findAll({ type: 'Svg' })
      const src = String(svgs[1]?.props.source ?? '')
      expect(src, 'dark-mode label colour').toContain('@media (prefers-color-scheme:dark){.z0{fill:#8AB4F8}}')
    }

    // 21 s later: the cache is lost and the row turns grey.
    await clock.advance(21_000)
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^lost$/ }), 'lost').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^lost$/ }))?.props.color, 'grey').toBe('#9AA0A6')

    // While Claude works the cache is in use.
    const busy = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props(true) })
    expect(await busy.find({ text: /in use/ }), 'in use while working').toBeDefined()
  })

  test(`the ✕ icon and /context-pane cache hide and show the cache bar (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { store, toasts } = setup(on, { ttl: () => '1h' })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), '1 hour cache detected').toBeDefined()
    await v.press({ key: 'cache-hide' })
    v = await mount()
    expect(await v.find({ text: /Cache/ }), 'cache bar hidden').toBeUndefined()
    expect(await v.find({ text: /182k/ }), 'context row stays').toBeDefined()
    expect(store.cacheHidden, 'hidden is saved for every chat').toBe(true)
    expect(toasts.join(' '), 'the toast names the way back').toContain('/context-pane cache')

    expect(await run($, 'cache'), 'show reply').toContain('Cache bar shown')
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), 'cache bar back').toBeDefined()

    // Plain /context-pane still hides and shows the whole row.
    expect(await run($, ''), 'hide row').toContain('Context Pane hidden')
    v = await mount()
    expect(await v.find({ text: /182k/ }), 'row hidden').toBeUndefined()
    expect(await run($, ''), 'show row').toContain('Context Pane shown')
  })

  test(`keep warm: the ♨ icon turns it on, a ping fires before expiry, a prompt stops it (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { toasts, forks, files } = setup(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    expect(await run($, 'keepwarm'), 'nothing to keep warm before the first reply').toContain('Nothing to keep warm yet')
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    await v.press({ key: 'cache-keepwarm' })
    v = await mount()
    expect((await v.find({ key: 'cache-keepwarm' }))?.text, 'same icon while warming').toBe('♨')
    expect((await v.find({ key: 'cache-keepwarm' }))?.props.variant, 'lit while warming').toBe('primary')
    expect((await v.findAll({ type: 'Text', text: /Keep warm$/ })).some(x => x.props.color === '#FA7B17'), 'says Keep warm, in orange').toBe(true)
    expect(toasts.join(' '), 'toast').toContain('Keep warm on')

    // 4 min in: 60 s left, still too early. 45 s before the end: one ping.
    await clock.advance(4 * 60_000)
    expect(forks.length, 'no ping with 60 s left').toBe(0)
    await clock.advance(16_000)
    await clock.settle()
    expect(forks, 'one ping with the tiny prompt').toEqual(['Reply with the single word: ok'])
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^4:[45]\d left/ }), 'back to nearly 5:00 left').toBeDefined()
    const logPath = Object.keys(files).find(k => k === '/Users/test/.claude/mods-logs/context-pane-cache.log') ?? ''
    expect(files[logPath] ?? '', 'the ping is logged').toContain('ping 1: cache read 182000, cache write 0, error none')

    // Its own command does not stop it; a real prompt does.
    await $.prompt.submit({ text: '/context-pane keepwarm' } as never)
    await clock.settle()
    v = await mount()
    expect(await v.find({ type: 'Text', text: /Keep warm$/ }), 'still on after its own command').toBeDefined()
    await $.prompt.submit({ text: 'back again' } as never)
    await clock.settle()
    v = await mount()
    expect(await v.find({ type: 'Text', text: /Keep warm$/ }), 'stopped by a prompt').toBeUndefined()
    expect((await v.find({ key: 'cache-keepwarm' }))?.text, 'same icon').toBe('♨')
    expect((await v.find({ key: 'cache-keepwarm' }))?.props.variant, 'quiet again when stopped').toBeUndefined()
    expect(toasts.join(' '), 'the toast says why').toContain('you sent a message')
    await clock.advance(10 * 60_000)
    expect(forks.length, 'no more pings once stopped').toBe(1)

    // The command turns it on and off too.
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    expect(await run($, 'keepwarm'), 'on by command').toContain('Keep warm on')
    expect(await run($, 'keepwarm off'), 'off by command').toContain('Keep warm off')
  })

  test(`until the log answers it uses the saved length, then switches (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    let answer = 'unknown'
    const { store } = setup(on, { ttl: () => answer, store: { cacheTtl: '5m' } })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    let v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 5 min' }), 'the saved length while unknown').toBeDefined()

    // The log answers a moment later: the bar takes the real length within 5 s.
    answer = '1h'
    await clock.advance(6000)
    await clock.settle()
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), 'switched to 1 hour').toBeDefined()
    expect(store.cacheTtl, 'saved for the next chat').toBe('1h')
  })

  test(`with nothing saved and no answer yet it guesses 1 hour (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on, { ttl: () => 'unknown' })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), '1 hour guess').toBeDefined()
  })

  test(`the session bar sits on top with the 5-hour window and when it resets (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const start = 1_000_000
    const limits: unknown[] = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(start + (2 * 60 + 14) * 60_000).toISOString() }, { kind: 'seven_day', percentUsed: 40 }]
    setup(on, { limits: () => limits })
    const clock = mock.clock(on, { now: start })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    expect(await v.find({ type: 'Text', text: /^24%$/ }), '23.5% shows as 24%').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^24%$/ }))?.props.color, 'OK zone colour').toBe('#34A853')
    expect(await v.find({ text: /resets in 2 h 14 min \[20:32\]/ }), 'reset countdown and clock time').toBeDefined()
    // On top: the session line comes before the context total.
    const texts = (await v.findAll({ type: 'Text' })).map(x => x.text)
    const at = (re: RegExp) => texts.findIndex(x => re.test(x))
    expect(at(/^24%$/), 'above the context total').toBeLessThan(at(/182k \/ 1m/))
    if (surface === 'desktop') {
      const svgs = await v.findAll({ type: 'Svg' })
      expect(String(svgs[0]?.props.alt), 'first drawing is the session bar').toBe('Session 24% used, resets in 2 h 14 min [20:32]')
    }

    // The countdown moves on its own every 30 s.
    await clock.advance(60 * 60_000)
    v = await mount()
    expect(await v.find({ text: /resets in 1 h 14 min \[20:32\]/ }), 'an hour later, same clock time').toBeDefined()

    // Past the reset time: a fresh window.
    await clock.advance(75 * 60_000)
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^0%$/ }), 'fresh window').toBeDefined()
    expect(await v.find({ text: /reset$/ }), 'says reset').toBeDefined()
  })

  test(`no session bar without a subscription's figures (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on)
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /182k/ }), 'context row').toBeDefined()
    expect(await v.find({ text: /Session/ }), 'no session bar').toBeUndefined()
  })

  test(`the demo runs one 60 s countdown, then goes back to the real length (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { toasts } = setup(on, { ttl: () => '1h' })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    await clock.advance(10 * 60_000)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await run($, 'demo'), 'demo on').toContain('one 60 s demo countdown')
    let v = await mount()
    expect(await v.find({ type: 'Text', text: /^1:00 left/ }), 'starts at 1:00 from now').toBeDefined()
    for (let i = 0; i < 61; i++) await clock.advance(1000)
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^lost$/ }), 'lost at the end').toBeDefined()
    for (let i = 0; i < 3; i++) await clock.advance(1000)
    await clock.settle()
    v = await mount()
    expect(await v.find({ type: 'Button', text: '⏱ 1 h' }), 'back to 1 hour').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^48:5\d left/ }), 'the real time since the last reply').toBeDefined()
    expect(toasts.join(' '), 'says the demo is over').toContain('Demo over')
  })

  test(`keep warm stops by itself after 30 pings (${surface})`, { timeoutMs: 120000 }, async ($, on) => {
    const { toasts, forks } = setup(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    // The 60 s demo cache pings every 15 s, so 30 pings fit well inside the 2 hour cap.
    expect(await run($, 'demo'), 'demo').toContain('60 s demo')
    // Keep warm refreshes the demo before it is lost, so the demo lasts as long as the pings.
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    expect(await run($, 'keepwarm'), 'on').toContain('Keep warm on')
    for (let i = 0; i < 600 && forks.length < 31; i++) await clock.advance(1000)
    await clock.settle()
    expect(forks.length, 'exactly 30 pings').toBe(30)
    expect(toasts.join(' '), 'the stop toast names the cap').toContain('after 30 pings')
  })
}

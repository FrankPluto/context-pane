import { expect, mock, test } from 'claude-code/testing'

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

// Everything outside the mod, answered beneath it: usage, the session id, the
// system commands, files, the store and toasts.
type Os = 'macos' | 'windows' | 'linux' | 'unknown'

function setup(on: TestOn, opts: { store?: Record<string, unknown>; limits?: () => unknown[]; dow?: number; os?: Os; linuxTools?: string[] } = {}) {
  const os = opts.os ?? 'macos'
  const files: Record<string, string> = {}
  const store: Record<string, unknown> = opts.store ?? {}
  const toasts: string[] = []
  const config: Record<string, unknown> = {}
  const killed: string[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async () => ({}) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('prompt.submit', async ($, e) => ({ text: (e as { text: string }).text }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.id', async () => ({ value: 'sid' }) as never)
  // Windows is told by its OS variable; the other variables read as a home folder.
  on('env.get', async ($, e) => {
    const name = (e as { name: string }).name
    if (name === 'OS') return { value: os === 'windows' ? 'Windows_NT' : undefined } as never
    return { value: '/Users/test' } as never
  })
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
    if (argv[0] === 'spd-say' && argv[1] === '--cancel') {
      killed.push(argv.join(' '))
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (argv[0] === 'uname') {
      // macOS and Linux by name; Windows has no uname, and an unknown system names something else.
      if (os === 'windows') throw new Error('uname: not found')
      return { value: { exitCode: 0, stdout: os === 'macos' ? 'Darwin\n' : os === 'linux' ? 'Linux\n' : 'FreeBSD\n', stderr: '' } } as never
    }
    if (argv[1] === '--version') {
      // A speech tool answers only when the test installs it.
      if (!(opts.linuxTools ?? []).includes(argv[0]!)) return { value: { exitCode: 127, stdout: '', stderr: `${argv[0]}: not found\n` } } as never
      return { value: { exitCode: 0, stdout: `${argv[0]} 1.0\n`, stderr: '' } } as never
    }
    if (argv[0] === 'date' && argv.includes('+%u')) {
      // The weekday the week window started on, when a test gives one; else the command fails.
      return { value: opts.dow ? { exitCode: 0, stdout: `${opts.dow}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } } as never
    }
    if (argv[0] === 'date') return { value: { exitCode: 0, stdout: '20:32\n', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
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
  on('config.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    config[key] = value
    return { value } as never
  })
  on('ui.toast', async ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>REST</Text>
  })
  return { files, store, toasts, config, killed }
}

const props = (isWorking = false) => ({ isWorking, hasSurvey: false, maxRows: 10, bodyColumns: 120 }) as never
/** The speaker button's text. */
async function speakerSays(v: { find: (q: object) => Promise<unknown> }) {
  return ((await v.find({ key: 'read-aloud' })) as { text?: string } | undefined)?.text
}

const run = async ($: TestDollar, args: string) => JSON.stringify(await $.command.run({ command: 'context-pane', args } as never))

type Mounted = { findAll(q: { type: 'Svg' }): Promise<Array<{ props: Record<string, unknown> }>>; find(q: { type: 'Text'; text: RegExp }): Promise<{ props: { color?: unknown } } | undefined> }


for (const surface of ['desktop', 'terminal'] as const) {
  test(`a monthly window adds a 1px month bar above the week bar (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const limits: unknown[] = [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 40 }, { kind: 'monthly', percentUsed: 12 }]
    setup(on, { limits: () => limits })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Text', text: /^ +Month $/ }), 'Month caption').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^12%$/ }))?.props.color, 'in indigo').toBe('#3F51B5')
    if (surface === 'desktop') {
      const svgs = await v.findAll({ type: 'Svg' })
      expect(String(svgs[0]?.props.alt), 'month bar first').toBe('Month 12% used')
      expect(String(svgs[0]?.props.source), 'month bar is a 1px line').toContain('height="1"')
      expect(String(svgs[0]?.props.source), 'month bar markers stay 4px').toMatch(/width="3" height="4"/)
      expect(String(svgs[1]?.props.alt), 'then the week bar').toBe('Week 40% used, 7 days')
    }
  })

  test(`the week bar is split into 7 days, or 5 with the Week switch (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const limits: unknown[] = [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 40 }]
    const { config } = setup(on, { limits: () => limits })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    const dayMarks = async (v: Awaited<ReturnType<typeof mount>>) => {
      const svg = (await v.findAll({ type: 'Svg' })).find(s => /^Week/.test(String(s.props.alt)))
      return (String(svg?.props.source).match(/fill-opacity="0.25"/g) ?? []).length
    }
    let v = await mount()
    if (surface === 'desktop') expect(await dayMarks(v), 'full week: 7 day sections').toBe(7)

    await v.press({ key: 'switches' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '7d' }), 'switch reads 7d').toBeDefined()
    await v.press({ key: 'switch-week-days' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '5d' }), 'switch reads 5d').toBeDefined()
    expect(config['context-pane.workWeek'], 'saved as a setting').toBe(true)
    if (surface === 'desktop') expect(await dayMarks(v), 'work week: 5 day sections').toBe(5)

    expect(await run($, '7d'), '/context-pane 7d').toContain('full week')
    v = await mount()
    expect(await v.find({ type: 'Button', text: '7d' }), 'back to 7d').toBeDefined()
    expect(config['context-pane.workWeek'], 'saved off').toBe(false)
  })

  // The week's reset 4.5 days ahead of the mocked clock: the window started 2.5 days ago, so today is its third 24 h slot.
  const weekReset = new Date(1_000_000 + 4.5 * 86_400_000).toISOString()
  const weekLimits = (percent: number) => [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: percent, resetsAt: weekReset }]
  const weekSvgOf = async (v: { findAll: (q: object) => Promise<unknown[]> }) =>
    ((await v.findAll({ type: 'Svg' })) as { props: { alt?: string; source: string } }[]).find(x => /^Week/.test(String(x.props.alt)))

  test(`full week: usage past today's share turns the later days red (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on, { limits: () => weekLimits(55), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    // 3 of 7 days are due: 42.9%. 55% is 12% ahead, with 4.5 days left until the reset and 45% left.
    const note = await v.find({ type: 'Text', text: /^ · ahead 12% · 4\.5 d left · 10%\/day$/ })
    expect(note, 'ahead, days left and per-day budget').toBeDefined()
    expect(note!.props.color, 'the note is red').toBe('#EA4335')
    expect((await v.find({ type: 'Text', text: /^55%$/ }))?.props.color, 'the figure is red').toBe('#EA4335')
    if (surface === 'desktop') {
      const svg = (await weekSvgOf(v))!
      expect(svg.props.source, 'within pace is green').toContain('#34A853')
      expect(svg.props.source, 'beyond pace is red').toContain('#EA4335')
      expect(svg.props.alt, 'alt says it').toBe('Week 55% used, 7 days from MONDAY, day 3 now, 12% ahead of pace')
      expect(svg.props.source, 'one 4px section per day').toMatch(/(fill-opacity="0.25"[\s\S]*){7}/)
      // The day we are in (the third section, index 2) has a light grey bar, 1 px tall, just above it. It is still.
      const src = svg.props.source
      const w = (1000 - 5 * 6) / 7
      const from = 2 * (w + 5)
      const marker = /<svg y="8" width="100%" height="1" viewBox="0 0 1000 1" preserveAspectRatio="none"><rect class="td" x="([\d.]+)" y="0" width="([\d.]+)" height="1" fill="#9AA0A6"\/><\/svg>/.exec(src)
      expect(marker, 'a light grey 1 px bar above today').not.toBeNull()
      expect(Math.abs(Number(marker![1]) - from), 'starts where today starts').toBeLessThan(0.02)
      expect(Math.abs(Number(marker![2]) - w), 'as wide as today').toBeLessThan(0.02)
      expect(src.match(/class="td"/g), 'one marker').toHaveLength(1)
      expect(src, 'the bars sit under the names and the marker').toContain('<svg y="10" width="100%" height="4"')
      expect(src, 'names, marker, bars and gap: 17 px tall').toContain('width="100%" height="17"')
      expect(src, 'nothing moves').not.toMatch(/animation|@keyframes|<clipPath|class="g[0-3]|class="bm"|class="bp"/)
    }
  })

  test(`the days start on the weekday the week resets, and no reset text (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // Resets on a Tuesday: the sections run Tue to Mon, and today (the third slot) is Thursday.
    setup(on, { limits: () => weekLimits(30), dow: 2 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    let v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Text', text: /resets Tue/ }), 'no reset text in the caption').toBeUndefined()
    if (surface === 'desktop') {
      const svg = (await weekSvgOf(v))!
      const names = [...svg.props.source.matchAll(/<text[^>]*>([A-Z]+)<\/text>/g)].map(m => m[1])
      expect(names, 'Tuesday first').toEqual(['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY', 'MONDAY'])
      expect(svg.props.source, 'today is full strength').toMatch(/fill="#34A853" fill-opacity="1">THURSDAY</)
      expect(svg.props.alt, 'alt says where it starts').toContain('7 days from TUESDAY')
      await run($, '5d')
      v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
      const work = [...(await weekSvgOf(v))!.props.source.matchAll(/<text[^>]*>([A-Z]+)<\/text>/g)].map(m => m[1])
      expect(work, 'work week from Tuesday, Monday last').toEqual(['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'MONDAY'])
    }
  })

  test(`within pace stays green and shows what is left (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on, { limits: () => weekLimits(30), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    // 30% is under the 42.9% that is due.
    expect(await v.find({ type: 'Text', text: /4\.5 d left · 16%\/day/ }), 'days left, nothing ahead').toBeDefined()
    expect(await v.find({ type: 'Text', text: /ahead/ }), 'not ahead').toBeUndefined()
    expect((await v.find({ type: 'Text', text: /^30%$/ }))?.props.color, 'green').toBe('#34A853')
    if (surface === 'desktop') expect((await weekSvgOf(v))!.props.source, 'no red').not.toContain('#EA4335')
  })

  test(`work week: only Mon-Fri count, so the weekend adds no budget (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    // The window started on a Monday: Mon, Tue, Wed are due by today, 3 of 5 = 60%.
    setup(on, { limits: () => weekLimits(70), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    expect(await run($, '5d'), '/context-pane 5d').toContain('work week')
    let v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Text', text: /ahead 10% · 2\.5 d left · 12%\/day/ }), 'ahead of the 60% due').toBeDefined()
    if (surface === 'desktop') {
      expect((await weekSvgOf(v))!.props.source, '5 sections').toMatch(/(fill-opacity="0.25"[\s\S]*){5}/)
      expect((await weekSvgOf(v))!.props.alt, 'Wednesday is the third day').toContain('day 3 now')
    }
  })

  test(`work week on a weekend: the days since Friday are not counted (${surface})`, { timeoutMs: 30000, options: { workWeek: true } }, async ($, on) => {
    // Started on a Friday: Fri, Sat, Sun so far, of which only Friday counts, 1 of 5 = 20%.
    setup(on, { limits: () => weekLimits(30), dow: 5 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Text', text: /ahead 10% · 4\.0 d left · 18%\/day/ }), 'weekend is not a day').toBeDefined()
    // No work day is under way, so there is no day marker.
    if (surface === 'desktop') expect((await weekSvgOf(v))!.props.source, 'no marker on a weekend').not.toContain('class="td"')
  })

  test(`work week on a Saturday with only Monday left reads 1.0 d left, not last day (${surface})`, { timeoutMs: 30000, options: { workWeek: true } }, async ($, on) => {
    // Started on a Tuesday 4.5 days ago instead: it is Saturday afternoon, Tue to Fri are due (80%), only Monday is left.
    const reset = new Date(1_000_000 + 2.5 * 86_400_000).toISOString()
    setup(on, { limits: () => [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 85, resetsAt: reset }], dow: 2 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ type: 'Text', text: /ahead 5% · 1\.0 d left · 15%\/day/ }), 'Monday still to come').toBeDefined()
    expect(await v.find({ type: 'Text', text: /last day/ }), 'not the last day').toBeUndefined()
  })

  test(`the Today switch turns the grey bar above today on and off (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { config } = setup(on, { limits: () => weekLimits(30), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    const hasMarker = async (v: Awaited<ReturnType<typeof mount>>) => String((await weekSvgOf(v))?.props.source).includes('class="td"')
    let v = await mount()
    if (surface === 'desktop') expect(await hasMarker(v), 'on by default').toBe(true)

    await v.press({ key: 'switches' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '• Today' }), 'switch shows on').toBeDefined()
    if (surface === 'desktop') {
      // Same size as the captions under the bars.
      const label = await v.find({ type: 'Text', text: '• Today' })
      expect(label?.props.size, 'caption size').toBe('caption')
    }
    await v.press({ key: 'switch-today' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '◦ Today' }), 'switch shows off').toBeDefined()
    expect(config['context-pane.showToday'], 'saved as a setting').toBe(false)
    if (surface === 'desktop') {
      expect(await hasMarker(v), 'marker gone').toBe(false)
      expect((await weekSvgOf(v))!.props.alt, 'alt no longer names the day').not.toContain('now')
    }

    expect(await run($, 'today'), '/context-pane today').toContain('shown')
    v = await mount()
    expect(await v.find({ type: 'Button', text: '• Today' }), 'back on').toBeDefined()
    if (surface === 'desktop') expect(await hasMarker(v), 'marker back').toBe(true)
  })

  test(`Today saved off stays off in a new chat (${surface})`, { timeoutMs: 30000, options: { showToday: false } }, async ($, on) => {
    setup(on, { limits: () => weekLimits(30), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    if (surface === 'desktop') expect(String((await weekSvgOf(v))?.props.source), 'no marker').not.toContain('class="td"')
  })

  test(`the settings row: no "Show", 7d then Today follow Week, small dots (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    setup(on, { limits: () => weekLimits(30), dow: 1 })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    let v = await mount()
    await v.press({ key: 'switches' })
    v = await mount()
    expect(await v.find({ type: 'Text', text: 'Show' }), 'no Show label').toBeUndefined()
    const names = ((await v.findAll({ type: 'Button' })) as { text: string }[]).map(b => b.text)
    const row = names.slice(names.indexOf('• Week'))
    expect(row, 'the week controls together, then the other bars; no Read aloud, its button is beside ⚙').toEqual([
      '• Week', '7d', '• Today', '• 5h Session', '• Context',
    ])
    expect(names.some(n => n.includes('●') || n.includes('○')), 'only the small dot and ring').toBe(false)
    expect(names.includes('Week: 7d'), 'no "Week: 7d"').toBe(false)
  })

  test(`a work week saved on stays on in a new chat (${surface})`, { timeoutMs: 30000, options: { workWeek: true } }, async ($, on) => {
    setup(on, { limits: () => [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 40 }] })
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    await v.press({ key: 'switches' })
    const v2 = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v2.find({ type: 'Button', text: '5d' }), 'work week kept').toBeDefined()
  })

  test(`every bar starts on, and the switches turn each one off and back on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const limits: unknown[] = [{ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 40 }]
    const { config } = setup(on, { limits: () => limits })
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: '' } as never)
    await clock.settle()
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    expect(await v.find({ type: 'Text', text: /^ +Week Session $/ }), 'week on').toBeDefined()
    expect(await v.find({ text: /182k/ }), 'context on').toBeDefined()
    expect(await v.find({ type: 'Button', text: /Context$/ }), 'switches closed').toBeUndefined()

    await v.press({ key: 'switches' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: '• Context' }), 'Context switch on').toBeDefined()
    expect(await v.find({ type: 'Button', text: /Month/ }), 'no Month switch').toBeUndefined()

    await v.press({ key: 'bar-context' })
    v = await mount()
    expect(await v.find({ text: /182k/ }), 'context hidden').toBeUndefined()
    expect(await v.find({ type: 'Button', text: '◦ Context' }), 'Context switch off').toBeDefined()
    expect(config['context-pane.showContext'], 'saved as a setting').toBe(false)

    expect(await run($, 'week'), 'command hides the week').toContain('Week bar hidden')
    v = await mount()
    expect(await v.find({ type: 'Text', text: /^ +Week Session $/ }), 'week hidden').toBeUndefined()
    expect(await v.find({ type: 'Text', text: /^10%$/ }), 'session stays').toBeDefined()

    await run($, 'session')
    v = await mount()
    expect(await v.find({ text: /all bars off/ }), 'a line keeps the ⚙ when every bar is off').toBeDefined()
    expect(await v.find({ type: 'Button', key: 'switches' }), 'the ⚙ stays').toBeDefined()

    for (const id of ['context', 'week', 'session']) await run($, id)
    v = await mount()
    expect(await v.find({ text: /182k/ }), 'context back').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^ +Week Session $/ }), 'week back').toBeDefined()
  })

  test(`the speaker reads replies aloud and is the Read aloud switch (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { config } = setup(on)
    const spoken: string[] = []
    on('process.spawn', async function* (_: unknown, e: unknown) {
      const { argv, input } = e as { argv: string[]; input?: string }
      spoken.push(`${argv.join(' ')}: ${input ?? ''}`)
      return { value: { code: 0, signal: null } }
    } as never)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const mount = () => $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })

    let v = await mount()
    expect(await speakerSays(v), 'on by default: Speaking').toBe('Speaking')

    await $.turn.complete({ answer: '**Done.** See [the file](a/b.png) and `x.css`.', reason: 'answer' } as never)
    await clock.settle()
    expect(spoken, 'the reply read as words').toEqual(['say: Done. See the file and x.css.'])

    // A helper's reply and an interrupted one are not read.
    await $.turn.complete({ answer: 'helper', reason: 'answer', agentId: 'a1' } as never)
    await $.turn.complete({ answer: 'cut off', reason: 'aborted' } as never)
    await clock.settle()
    expect(spoken.length, 'only the main reply').toBe(1)

    // The button is the switch: off mutes it, stops any reading and is saved.
    await v.press({ key: 'read-aloud' })
    v = await mount()
    expect(await speakerSays(v), 'off: Silent').toBe('Silent')
    expect(config['context-pane.readAloud'], 'saved as a setting').toBe(false)
    await $.turn.complete({ answer: 'Quiet now.', reason: 'answer' } as never)
    await clock.settle()
    expect(spoken.length, 'nothing read while off').toBe(1)

    // The settings row has no Read aloud switch: the speaker button beside ⚙ is the switch. The command works too.
    await v.press({ key: 'switches' })
    v = await mount()
    expect(await v.find({ type: 'Button', text: /Read aloud/ }), 'no Read aloud in the settings row').toBeUndefined()
    expect(await speakerSays(v), 'the button beside ⚙ shows Silent').toBe('Silent')
    expect(await run($, 'speak'), '/context-pane speak').toContain('Read aloud on')
    v = await mount()
    expect(await speakerSays(v), 'and Speaking again').toBe('Speaking')
  })

  /** Starts a chat on `os` and reads one reply; what was spoken, and the mounted row. */
  async function speakOn($: TestDollar, on: TestOn, os: Os, linuxTools: string[] = []) {
    const { killed } = setup(on, { os, linuxTools })
    const spoken: { argv: string[]; input?: string }[] = []
    on('process.spawn', async function* (_: unknown, e: unknown) {
      const { argv, input } = e as { argv: string[]; input?: string }
      spoken.push({ argv, input })
      return { value: { code: 0, signal: null } }
    } as never)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: 'Hej, **världen**.', reason: 'answer' } as never)
    await clock.settle()
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    return { spoken, v, killed }
  }

  test(`macOS reads with say (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken, v } = await speakOn($, on, 'macos')
    expect(spoken, 'say reads the reply').toEqual([{ argv: ['say'], input: 'Hej, världen.' }])
    expect(await speakerSays(v), 'Speaking').toBe('Speaking')
  })

  test(`Windows reads with its built-in speech through PowerShell (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken, v } = await speakOn($, on, 'windows')
    expect(spoken.length, 'one reading').toBe(1)
    expect(spoken[0]!.argv[0], 'PowerShell').toBe('powershell.exe')
    expect(spoken[0]!.argv.at(-1), 'System.Speech, reading UTF-8').toMatch(/InputEncoding.*UTF8.*System\.Speech.*SpeechSynthesizer/)
    expect(spoken[0]!.input, 'the reply as words, å ä ö kept').toBe('Hej, världen.')
    expect(await speakerSays(v), 'Speaking').toBe('Speaking')
  })

  test(`Linux reads with espeak-ng when it is installed (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken } = await speakOn($, on, 'linux', ['espeak-ng', 'espeak', 'spd-say'])
    expect(spoken, 'espeak-ng comes first').toEqual([{ argv: ['espeak-ng', '--stdin'], input: 'Hej, världen.' }])
  })

  test(`Linux falls back to espeak, then spd-say (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken } = await speakOn($, on, 'linux', ['spd-say'])
    expect(spoken, 'spd-say when it is the only one').toEqual([{ argv: ['spd-say', '--wait', '--pipe-mode'], input: 'Hej, världen.' }])
  })

  test(`Linux without a speech tool hides the speaker and says what to install (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken, v } = await speakOn($, on, 'linux')
    expect(spoken, 'nothing read').toEqual([])
    expect(await speakerSays(v), 'no speaker button').toBeUndefined()
    expect(await run($, 'speak'), '/context-pane speak says what to install').toContain('install espeak-ng')
  })

  test(`an unknown system hides the speaker (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { spoken, v } = await speakOn($, on, 'unknown')
    expect(spoken, 'nothing read').toEqual([])
    expect(await speakerSays(v), 'no speaker button').toBeUndefined()
    expect(await v.find({ key: 'switches' }), 'the ⚙ stays').toBeDefined()
  })

  test(`Silent and a new reply stop the reading on every system (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { killed } = setup(on, { os: 'linux', linuxTools: ['spd-say'] })
    const ended: string[] = []
    // A reading that goes on until the mod closes it: closing the stream aborts the child's signal.
    on('process.spawn', async function* (_: unknown, e: unknown, next: { signal: AbortSignal }) {
      const { input } = e as { input?: string }
      try {
        yield { stream: 'stdout', text: input ?? '' }
        await new Promise(done => next.signal.addEventListener('abort', done))
        return { value: { code: null, signal: 'SIGTERM' } }
      } finally {
        ended.push(input ?? '')
      }
    } as never)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    await $.turn.complete({ answer: 'First.', reason: 'answer' } as never)
    await clock.settle()
    await $.turn.complete({ answer: 'Second.', reason: 'answer' } as never)
    await clock.settle()
    expect(ended, 'a new reply cuts off the one being read').toEqual(['First.'])
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    await v.press({ key: 'read-aloud' })
    await clock.settle()
    expect(ended, 'Silent stops the reading').toEqual(['First.', 'Second.'])
    expect(killed, 'and spd-say is cancelled in speech-dispatcher too').toEqual(['spd-say --cancel', 'spd-say --cancel'])
  })

  test(`Read aloud saved off stays off in a new chat (${surface})`, { timeoutMs: 30000, options: { readAloud: false } }, async ($, on) => {
    setup(on)
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await speakerSays(v), 'Silent').toBe('Silent')
  })

  test(`a switch saved off stays off in a new chat (${surface})`, { timeoutMs: 30000, options: { showContext: false } }, async ($, on) => {
    setup(on)
    mock.clock(on, { now: 1_000_000 })
    await $.session.start({ source: 'startup', cwd: '/Users/test', surface, isInteractive: true } as never)
    const v = await $.ui.mount({ plugin: 'context-pane', surface, component: 'AbovePrompt', props: props() })
    expect(await v.find({ text: /182k/ }), 'context off').toBeUndefined()
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
    expect(await v.find({ type: 'Text', text: /^ +Week Session $/ }), 'Week beside Session').toBeDefined()
    expect((await v.find({ type: 'Text', text: /^40%$/ }))?.props.color, 'in the week colour').toBe('#D81B60')
    if (surface === 'desktop') {
      expect(await v.find({ type: 'Text', text: /^resets in 2 h 14 min $/ }), 'reset countdown').toBeDefined()
      expect(await v.find({ type: 'Text', text: /^20:32$/ }), 'clock time in plain text').toBeDefined()
    } else {
      expect(await v.find({ text: /resets in 2 h 14 min 20:32/ }), 'reset countdown and clock time').toBeDefined()
    }
    // On top: the session line comes before the context total.
    const texts = (await v.findAll({ type: 'Text' })).map(x => x.text)
    const at = (re: RegExp) => texts.findIndex(x => re.test(x))
    expect(at(/^24%$/), 'above the context total').toBeLessThan(at(/182k \/ 1m/))
    if (surface === 'desktop') {
      const svgs = await v.findAll({ type: 'Svg' })
      expect(String(svgs[0]?.props.alt), 'first drawing is the week bar').toBe('Week 40% used, 7 days')
      expect(String(svgs[0]?.props.source), 'week bar has no labels').not.toContain('<text')
      expect(String(svgs[0]?.props.source), 'week bar is green within pace').toContain('#34A853')
      expect(String(svgs[0]?.props.source), 'week bar is 4px tall').toContain('height="4"')
      expect(String(svgs[0]?.props.source), 'no red without a reset time').not.toContain('#EA4335')
      expect(String(svgs[1]?.props.alt), 'then the session bar').toBe('Session 24% used, resets in 2 h 14 min 20:32')
    }

    // The countdown moves on its own every 30 s.
    await clock.advance(60 * 60_000)
    v = await mount()
    expect(await v.find({ text: surface === 'desktop' ? /^resets in 1 h 14 min $/ : /resets in 1 h 14 min 20:32/ }), 'an hour later').toBeDefined()

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

}

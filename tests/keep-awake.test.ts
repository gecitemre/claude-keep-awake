import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'keep-awake',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HOLD = '/Users/tester/.claude/keep-awake'
const CLAUDE_PID = '4242'

type FakeMac = {
  isSleepDisabled: boolean
  hasRule: boolean
  isDialogCancelled?: boolean
  files: Map<string, string>
  livePids: Set<string>
  ran: string[][]
  dialogs: string[]
  toasts: string[]
}

const newMac = (fields: Pick<FakeMac, 'hasRule'> & Partial<FakeMac>): FakeMac => ({
  isSleepDisabled: false,
  files: new Map(),
  livePids: new Set([CLAUDE_PID]),
  ran: [],
  dialogs: [],
  toasts: [],
  ...fields,
})

const pmsetWrites = (mac: FakeMac) => mac.ran.filter(argv => argv[0] === '/usr/bin/sudo' && !argv.includes('-l'))

const exited = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

function answer(mac: FakeMac, argv: string[]) {
  const command = argv.join(' ')
  if (command === '/usr/bin/pmset -g') {
    return exited(0, `System-wide power settings:\n SleepDisabled\t\t${mac.isSleepDisabled ? 1 : 0}\nCurrently in use:\n sleep 1\n`)
  }
  if (command === '/usr/bin/pmset -g assertions') return exited(0, 'Listed by owning process:\n')
  if (command === '/usr/bin/id -un') return exited(0, 'tester\n')
  if (command === '/bin/sh -c echo $PPID') return exited(0, `${CLAUDE_PID}\n`)
  if (argv[0] === '/bin/mkdir') return exited(0, '')
  if (argv[0] === '/bin/rm' && argv[2]?.startsWith(HOLD)) return exited(0, '', String(mac.files.delete(argv[2])))
  if (argv[0] === '/bin/kill') return exited(mac.livePids.has(argv[2] ?? '') ? 0 : 1, '')
  if (argv[0] === '/usr/bin/osascript') return answerDialog(mac, argv.at(-2) ?? '')
  if (argv[0] !== '/usr/bin/sudo') throw new Error(`unexpected command: ${command}`)
  if (!mac.hasRule) return exited(1, '', 'sudo: a password is required\n')

  if (!argv.includes('-l')) mac.isSleepDisabled = argv.at(-1) === '1'

  return exited(0, '')
}

// The macOS administrator dialog: what it runs as root, once the person authenticates.
function answerDialog(mac: FakeMac, command: string) {
  mac.dialogs.push(command)
  if (mac.isDialogCancelled) return exited(1, '', 'execution error: User canceled. (-128)\n')

  const pmset = /^\/usr\/bin\/pmset -a disablesleep ([01])$/.exec(command)
  if (pmset !== null) mac.isSleepDisabled = pmset[1] === '1'
  if (command.includes('/usr/bin/install -m 0440 -o root -g wheel')) mac.hasRule = true
  if (command.startsWith('/bin/rm -f /etc/sudoers.d/keep-awake')) mac.hasRule = false

  return exited(0, '')
}

// Stands in for macOS beneath the plugin, so no test runs the real pmset or sudo.
function fakeMac(on: On, mac: FakeMac) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 19) })
  on('ui.toast', ($, e) => {
    mac.toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  mock.env(on, { HOME: '/Users/tester' })
  on('fs.write', ($, e) => {
    mac.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: mac.files.get(e.path) ?? '' }))
  on('fs.exists', ($, e) => ({ value: [...mac.files.keys()].some(path => path === e.path || path.startsWith(`${e.path}/`)) }))
  on('fs.list', ($, e) => ({
    value: [...mac.files.keys()]
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    mac.ran.push([...e.argv])

    return answer(mac, [...e.argv])
  })

  return clock
}

async function awakeCommand($: Engine, args: string) {
  const { text } = await $.command.run({
    command: 'awake',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  return text ?? ''
}

test('the band toggles the real pmset value on every surface', async ($, on) => {
  const mac = newMac({ hasRule: true })
  fakeMac(on, mac)
  await awakeCommand($, 'status')

  for (const surface of ['terminal', 'desktop'] as const) {
    mac.isSleepDisabled = false
    await awakeCommand($, 'status')
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'toggle-sleep' }))?.text).toBe('🌙 Always awake: off')

    await ui.press({ key: 'toggle-sleep' })
    expect(mac.isSleepDisabled).toBe(true)
    expect(mac.ran).toContainEqual(['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '1'])
    expect((await ui.find({ key: 'toggle-sleep' }))?.text).toBe('☕ Always awake: on')
    await ui.unmount()
  }
})

test('a change made outside Claude Code is what a command acts on', async ($, on) => {
  const mac = newMac({ hasRule: true })
  fakeMac(on, mac)
  await awakeCommand($, 'status')
  mac.isSleepDisabled = true

  expect(await awakeCommand($, 'status')).toContain('system-wide): on')
  expect(await awakeCommand($, 'off')).toContain('is off')
  expect(mac.isSleepDisabled).toBe(false)
})

test('without the sudoers rule macOS asks for the password and the change goes through', async ($, on) => {
  const mac = newMac({ hasRule: false })
  fakeMac(on, mac)

  expect(await awakeCommand($, 'on')).toContain('is on')
  expect(mac.dialogs).toEqual(['/usr/bin/pmset -a disablesleep 1'])
  expect(mac.ran.some(argv => argv[0] === '/usr/bin/sudo' && !argv.includes('-l'))).toBe(false)
})

test('a cancelled dialog changes nothing and says so on the band', async ($, on) => {
  const mac = newMac({ hasRule: false, isDialogCancelled: true })
  fakeMac(on, mac)
  await awakeCommand($, 'status')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'toggle-sleep' })

  expect(mac.isSleepDisabled).toBe(false)
  expect(mac.toasts).toEqual(['keep-awake: Cancelled in the macOS dialog.'])
  expect((await ui.find({ key: 'toggle-sleep' }))?.text).toBe('🌙 Always awake: off')
  expect(await ui.find({ type: 'Text', text: 'Cancelled in the macOS dialog.' })).toBeDefined()
})

test('setup explains the exact rule and runs nothing privileged', async ($, on) => {
  const mac = newMac({ hasRule: false })
  fakeMac(on, mac)

  expect(await awakeCommand($, 'setup')).toContain(
    'tester ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0',
  )
  expect(mac.dialogs).toEqual([])
  expect(mac.ran.some(argv => argv[0] === '/usr/bin/sudo' && !argv.includes('-l'))).toBe(false)
})

test('setup install adds a visudo-checked rule that later changes use, and remove takes it out', async ($, on) => {
  const mac = newMac({ hasRule: false })
  fakeMac(on, mac)

  expect(await awakeCommand($, 'setup install')).toContain('without a password')
  const installScript = mac.dialogs[0] ?? ''
  expect(installScript).toContain('/usr/sbin/visudo -cf "$tmp"')
  expect(installScript).toContain("'tester ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0'")

  await awakeCommand($, 'on')
  expect(mac.dialogs).toHaveLength(1)
  expect(mac.ran).toContainEqual(['/usr/bin/sudo', '-n', '/usr/bin/pmset', '-a', 'disablesleep', '1'])

  expect(await awakeCommand($, 'setup remove')).toContain('asks for your password again and is on')
  expect(mac.hasRule).toBe(false)
})

test('restore puts back the value from before the first change', async ($, on) => {
  const mac = newMac({ hasRule: true })
  fakeMac(on, mac)

  await awakeCommand($, 'on')
  expect(mac.isSleepDisabled).toBe(true)
  expect(await awakeCommand($, 'restore')).toContain('is off')
  expect(mac.isSleepDisabled).toBe(false)
  expect(await awakeCommand($, 'restore')).toContain('No original value')
})

test('a change made in another session reaches this band through the power notification', async ($, on) => {
  const mac = newMac({ hasRule: true })
  const clock = fakeMac(on, mac)
  let postNotification = () => {}
  on('process.spawn', async function* () {
    await new Promise<void>(resolve => (postNotification = resolve))
    yield { stream: 'stdout' as const, text: 'com.apple.system.powermanagement.prefschange\n' }

    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'toggle-sleep' }))?.text).toBe('🌙 Always awake: off')

  mac.isSleepDisabled = true
  postNotification()
  await clock.settle()

  expect((await ui.find({ key: 'toggle-sleep' }))?.text).toBe('☕ Always awake: on')
})

async function startSession($: Engine, on: On, clock: { settle: () => Promise<void> }) {
  // notifyutil ends at once: these tests drive the turns, not the power notification.
  on('process.spawn', async function* () {
    return { value: { code: 0, signal: null } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
}

async function runTurn($: Engine, clock: { settle: () => Promise<void> }, turnId: string, onWork: () => Promise<void>) {
  await $.turn.start({ text: 'go', turnId })
  await clock.settle()
  await onWork()
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  await clock.settle()
}

test('while Claude works, a turn keeps the Mac awake and its end lets it sleep', async ($, on) => {
  const mac = newMac({ hasRule: true })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)

  await runTurn($, clock, 't1', async () => {
    expect(mac.isSleepDisabled).toBe(true)
    expect(mac.files.get(`${HOLD}/holders/session-a`)).toBe(CLAUDE_PID)
    expect(mac.files.has(`${HOLD}/auto-held`)).toBe(true)
  })

  expect(mac.isSleepDisabled).toBe(false)
  expect(mac.files.size).toBe(0)
})

test('another working session keeps the Mac awake after this turn ends', async ($, on) => {
  const mac = newMac({ hasRule: true, livePids: new Set([CLAUDE_PID, '777']) })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)

  await runTurn($, clock, 't1', async () => {
    mac.files.set(`${HOLD}/holders/session-b`, '777')
  })
  expect(mac.isSleepDisabled).toBe(true)

  mac.livePids.delete('777')
  await runTurn($, clock, 't2', async () => {})
  expect(mac.isSleepDisabled).toBe(false)
  expect(mac.files.has(`${HOLD}/holders/session-b`)).toBe(false)
})

test('while Claude works never turns off an Always awake set by hand', async ($, on) => {
  const mac = newMac({ hasRule: true, isSleepDisabled: true })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)

  await runTurn($, clock, 't1', async () => {})

  expect(mac.isSleepDisabled).toBe(true)
  expect(pmsetWrites(mac)).toEqual([])
})

test('without the passwordless rule while Claude works waits and opens no dialog', async ($, on) => {
  const mac = newMac({ hasRule: false })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)

  await runTurn($, clock, 't1', async () => expect(mac.isSleepDisabled).toBe(false))

  expect(mac.dialogs).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'needs /awake setup install' })).toBeDefined()
})

test('turning while Claude works off ends its hold at once', async ($, on) => {
  const mac = newMac({ hasRule: true })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)

  await runTurn($, clock, 't1', async () => {
    expect(await awakeCommand($, 'working off')).toContain('off')
    expect(mac.isSleepDisabled).toBe(false)
  })
  expect(mac.files.has(`${HOLD}/while-working-off`)).toBe(true)
})

test('background work a turn leaves running keeps the Mac awake until a later turn reports none', async ($, on) => {
  const mac = newMac({ hasRule: true })
  const clock = fakeMac(on, mac)
  await startSession($, on, clock)
  const shell = { id: 'b1', type: 'local_bash', status: 'running', description: 'npm test' }

  await runTurn($, clock, 't1', async () => {
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  })
  expect(mac.isSleepDisabled).toBe(true)

  await runTurn($, clock, 't2', async () => {
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  })
  expect(mac.isSleepDisabled).toBe(false)
})

test('Always awake and Awake while Claude works are never on together', async ($, on) => {
  const mac = newMac({ hasRule: true })
  fakeMac(on, mac)
  await awakeCommand($, 'status')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const labels = async () => [
    (await ui.find({ key: 'toggle-sleep' }))?.text,
    (await ui.find({ key: 'toggle-working' }))?.text,
  ]
  expect(await labels()).toEqual(['🌙 Always awake: off', '☕ Awake while Claude works: on'])

  await ui.press({ key: 'toggle-sleep' })
  expect(mac.isSleepDisabled).toBe(true)
  expect(await labels()).toEqual(['☕ Always awake: on', '🌙 Awake while Claude works: off'])

  await ui.press({ key: 'toggle-working' })
  expect(mac.isSleepDisabled).toBe(false)
  expect(await labels()).toEqual(['🌙 Always awake: off', '☕ Awake while Claude works: on'])
})

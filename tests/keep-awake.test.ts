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

type FakeMac = {
  isSleepDisabled: boolean
  hasRule: boolean
  isDialogCancelled?: boolean
  ran: string[][]
  dialogs: string[]
  toasts: string[]
}

const newMac = (fields: Pick<FakeMac, 'hasRule'> & Partial<FakeMac>): FakeMac => ({
  isSleepDisabled: false,
  ran: [],
  dialogs: [],
  toasts: [],
  ...fields,
})

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

  expect(await awakeCommand($, 'setup remove')).toContain('asks for your password again and is still on')
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

import type { EngineInterface } from 'claude-code'

import type { SleepStatus } from '../types'

export const PMSET = '/usr/bin/pmset'
export const RULE_FILE = '/etc/sudoers.d/keep-awake'
const SUDO = '/usr/bin/sudo'

// The sudoers rule allows exactly these argument vectors, so they must never vary beyond the 0/1.
const disableSleepArgv = (isPreventingSleep: boolean) => [
  PMSET,
  '-a',
  'disablesleep',
  isPreventingSleep ? '1' : '0',
]

// disablesleep is one system-wide value: `pmset -g` reports it as SleepDisabled,
// while `pmset -g custom` lists only the per-power-source settings and omits it.
export function parseSleepDisabled(pmsetOutput: string): boolean {
  const match = /^\s*SleepDisabled\s+([01])\s*$/m.exec(pmsetOutput)
  if (match === null) throw new Error('pmset -g reported no SleepDisabled value.')

  return match[1] === '1'
}

// -k ignores a cached sudo ticket, so only the NOPASSWD rule can make this succeed.
async function isAllowedWithoutPassword($: EngineInterface, isPreventingSleep: boolean) {
  const listed = await $.process.run([SUDO, '-n', '-k', '-l', ...disableSleepArgv(isPreventingSleep)])

  return listed.exitCode === 0
}

export async function readSleepStatus($: EngineInterface): Promise<SleepStatus> {
  const hasPmset = await $.fs.stat(PMSET).then(() => true, () => false)
  if (!hasPmset) return { kind: 'unsupported' }

  const [settings, canEnable, canDisable] = await Promise.all([
    $.process.run([PMSET, '-g']),
    isAllowedWithoutPassword($, true),
    isAllowedWithoutPassword($, false),
  ])
  if (settings.exitCode !== 0) throw new Error(`pmset -g failed: ${settings.stderr.trim()}`)

  return {
    kind: 'read',
    isPreventingSleep: parseSleepDisabled(settings.stdout),
    isPasswordless: canEnable && canDisable,
  }
}

// macOS's own authentication dialog takes the password; the command reaches AppleScript
// as an argument, never spliced into script source.
async function runAsAdministrator($: EngineInterface, command: string, prompt: string) {
  const ran = await $.process.run(
    [
      '/usr/bin/osascript',
      '-e',
      'on run argv',
      '-e',
      'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
      '-e',
      'end run',
      '--',
      command,
      prompt,
    ],
    // The person may take a while to authenticate.
    { timeoutMs: 600_000 },
  )
  if (ran.exitCode === 0) return
  if (ran.stderr.includes('(-128)')) throw new Error('Cancelled in the macOS dialog.')

  throw new Error(ran.stderr.trim() || `osascript failed with exit code ${ran.exitCode}`)
}

export async function writeSleepDisabled($: EngineInterface, isPreventingSleep: boolean, isPasswordless: boolean) {
  const argv = disableSleepArgv(isPreventingSleep)
  if (!isPasswordless) {
    const action = isPreventingSleep ? 'keep this Mac awake, lid closed included' : 'let this Mac sleep again'
    return runAsAdministrator($, argv.join(' '), `keep-awake wants to ${action} (${argv.join(' ')}).`)
  }

  const ran = await $.process.run([SUDO, '-n', ...argv])
  if (ran.exitCode !== 0) throw new Error(`pmset failed: ${ran.stderr.trim() || `exit code ${ran.exitCode}`}`)
}

export function sudoersRule(user: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`User name "${user}" has characters keep-awake does not put in sudoers.`)

  return `${user} ALL=(root) NOPASSWD: ${disableSleepArgv(true).join(' ')}, ${disableSleepArgv(false).join(' ')}`
}

// Checks the new file alone, then the whole configuration with it, and takes it out again
// if the whole fails, so a bad rule never stays installed.
export async function installPasswordlessRule($: EngineInterface, user: string) {
  const script = [
    'set -e',
    'tmp=$(/usr/bin/mktemp)',
    `trap '/bin/rm -f "$tmp"' EXIT`,
    `/usr/bin/printf '%s\\n' '# Installed by the keep-awake Claude Code mod; /awake setup remove deletes it.' '${sudoersRule(user)}' > "$tmp"`,
    '/usr/sbin/visudo -cf "$tmp" > /dev/null',
    `/usr/bin/grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\\.d[[:space:]]*$' /etc/sudoers || { echo '/etc/sudoers does not include /etc/sudoers.d' >&2; exit 1; }`,
    `/usr/bin/install -m 0440 -o root -g wheel "$tmp" ${RULE_FILE}`,
    `/usr/sbin/visudo -c > /dev/null || { /bin/rm -f ${RULE_FILE}; echo 'sudoers did not validate with the rule; it was removed' >&2; exit 1; }`,
  ].join('\n')

  await runAsAdministrator(
    $,
    script,
    `keep-awake wants to add ${RULE_FILE}, letting ${user} switch Always awake without a password. It allows only "pmset -a disablesleep 1" and "pmset -a disablesleep 0".`,
  )
}

export async function removePasswordlessRule($: EngineInterface) {
  await runAsAdministrator(
    $,
    `/bin/rm -f ${RULE_FILE}\n/usr/sbin/visudo -c > /dev/null`,
    `keep-awake wants to remove ${RULE_FILE}; Always awake will ask for your password again.`,
  )
}

// powerd posts this Darwin notification whenever a pmset setting changes, from any process.
export async function watchPowerPreferences($: EngineInterface, onChange: () => Promise<unknown>) {
  const changes = $.process.spawn({
    argv: ['/usr/bin/notifyutil', '-w', 'com.apple.system.powermanagement.prefschange'],
  })
  for await (const _change of changes) await onChange()
}

export async function currentUserName($: EngineInterface) {
  const ran = await $.process.run(['/usr/bin/id', '-un'])

  return ran.stdout.trim()
}

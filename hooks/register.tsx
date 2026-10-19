import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SleepStatus } from '../types'
import {
  claudeProcessId,
  countLiveHolders,
  isAutoHeld,
  isWhileWorkingOn,
  markAutoHeld,
  registerHolder,
  releaseHolder,
  setWhileWorking,
} from './hold'
import {
  currentUserName,
  installPasswordlessRule,
  PMSET,
  readSystemStatus,
  removePasswordlessRule,
  RULE_FILE,
  sudoersRule,
  watchPowerPreferences,
  writeSleepDisabled,
} from './power'

const status = atom({ plugin: 'keep-awake', key: 'status' } as const, null)
const isChanging = atom({ plugin: 'keep-awake', key: 'isChanging' } as const, false)
const error = atom({ plugin: 'keep-awake', key: 'error' } as const, null)

const ORIGINAL_KEY = 'originalSleepDisabled'
type OriginalValue = { isPreventingSleep: boolean; recordedAt: string }

const USAGE = 'Usage: /awake on | off | working on | working off | status | restore | setup [install | remove]'

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

type ReadStatus = SleepStatus & { kind: 'read' }
const isAlwaysAwake = (current: ReadStatus) => current.isPreventingSleep && !current.isAutoHeld
// The two modes are never on together: Always awake already covers every turn.
const isAwakeWhileWorking = (current: ReadStatus) => current.isWhileWorkingOn && !isAlwaysAwake(current)

// This session's share of the while-working hold; a reload starts it over at session.start.
let sessionId: string | undefined
let claudePid = ''
let isTurnRunning = false
let backgroundTaskCount = 0

// Changes run one at a time, so a turn's end never races a press or another turn's start.
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => {})

  return run
}

async function readStatus($: EngineInterface): Promise<SleepStatus> {
  const system = await readSystemStatus($)
  if (system.kind === 'unsupported') return system

  const [whileWorking, autoHeld] = await Promise.all([isWhileWorkingOn($), isAutoHeld($)])
  return { ...system, isWhileWorkingOn: whileWorking, isAutoHeld: autoHeld }
}

async function refresh($: EngineInterface) {
  const current: SleepStatus = await readStatus($).catch(failure => ({
    kind: 'unreadable' as const,
    reason: messageOf(failure),
  }))
  await update($, status, () => current)

  return current
}

async function readUsableStatus($: EngineInterface) {
  const current = await refresh($)
  if (current.kind !== 'read') throw new Error(describeUnusable(current))

  return current
}

function describeUnusable(current: SleepStatus) {
  if (current.kind === 'unsupported') return `keep-awake works on macOS only: ${PMSET} is missing.`
  if (current.kind === 'unreadable') return `Could not read the sleep setting: ${current.reason}`

  throw new Error(`describeUnusable called on a readable status`)
}

// Only the first change is recorded, so /awake restore returns to the value before keep-awake touched it.
async function recordOriginalValue($: EngineInterface, isPreventingSleep: boolean) {
  if ((await $.store.get(ORIGINAL_KEY)) !== undefined) return

  const original: OriginalValue = { isPreventingSleep, recordedAt: new Date(await $.clock.now()).toISOString() }
  await $.store.set(ORIGINAL_KEY, original)
}

// Every change reads the system first, so a toggle acts on the real value even when
// another session or a terminal changed it since the band was drawn.
async function changeAlwaysAwake($: EngineInterface, choose: (isAlwaysOn: boolean) => boolean) {
  await update($, isChanging, () => true)
  try {
    const before = await readUsableStatus($)
    const wanted = choose(isAlwaysAwake(before))
    if (wanted !== before.isPreventingSleep) {
      await recordOriginalValue($, before.isPreventingSleep)
      await writeSleepDisabled($, wanted, before.isPasswordless)
    }
    // Turning it on takes over a while-working hold, so the end of the work leaves it on.
    await markAutoHeld($, false)
    if (wanted) await setWhileWorking($, false)

    const after = await readUsableStatus($)
    if (after.isPreventingSleep !== wanted) throw new Error(`pmset still reports sleep prevention ${onOff(after.isPreventingSleep)}.`)
    await update($, error, () => null)

    return `Always awake is ${onOff(wanted)} (pmset disablesleep ${wanted ? 1 : 0}).`
  } catch (failure) {
    await update($, error, () => messageOf(failure))
    throw failure
  } finally {
    await update($, isChanging, () => false)
  }
}

async function startAutoHold($: EngineInterface) {
  await markAutoHeld($, true)
  await writeSleepDisabled($, true, true)
}

async function holdForWork($: EngineInterface, current: ReadStatus) {
  if (sessionId === undefined) throw new Error('The while-working hold ran before session.start.')

  await registerHolder($, sessionId, claudePid)
  if (!current.isPreventingSleep) await startAutoHold($)
}

async function releaseWork($: EngineInterface, current: ReadStatus) {
  if (sessionId !== undefined) await releaseHolder($, sessionId)
  if (!current.isAutoHeld) return
  if (current.isWhileWorkingOn && (await countLiveHolders($)) > 0) return

  if (current.isPreventingSleep && current.isPasswordless) await writeSleepDisabled($, false, true)
  await markAutoHeld($, false)
  // Another session may have started work after the count, seeing sleep prevention still on.
  if (current.isWhileWorkingOn && (await countLiveHolders($)) > 0) await startAutoHold($)
}

// Keeps the Mac awake while this session's turn or its background work runs, and lets it sleep
// once no session is working. It switches at every turn, so it acts only without a password.
async function followClaudeWork($: EngineInterface) {
  const current = await refresh($)
  if (current.kind !== 'read') return

  const isWorking = isTurnRunning || backgroundTaskCount > 0
  if (isWorking && current.isWhileWorkingOn && current.isPasswordless) await holdForWork($, current)
  else await releaseWork($, current)
  await refresh($)
}

function followClaudeWorkLater($: EngineInterface) {
  void serially(() => followClaudeWork($)).catch(failure => update($, error, () => messageOf(failure)))
}

async function changeWhileWorking($: EngineInterface, isOn: boolean) {
  if (isOn && isAlwaysAwake(await readUsableStatus($))) await changeAlwaysAwake($, () => false)
  await setWhileWorking($, isOn)
  await followClaudeWork($)
  const current = await readUsableStatus($)
  const hint = isOn && !current.isPasswordless ? ' It acts once /awake setup install lets it switch without a password.' : ''

  return `Awake while Claude works is ${onOff(isOn)}.${hint}`
}

async function restoreOriginalValue($: EngineInterface) {
  const original = (await $.store.get(ORIGINAL_KEY)) as OriginalValue | undefined
  if (original === undefined) return 'No original value is recorded: keep-awake has not changed the setting.'

  const result = await changeAlwaysAwake($, () => original.isPreventingSleep)
  await $.store.delete(ORIGINAL_KEY)

  return `Restored the value recorded ${original.recordedAt}. ${result}`
}

function describeWhileWorking(current: ReadStatus) {
  if (!isAwakeWhileWorking(current)) return 'off'
  if (!current.isPasswordless) return 'on, but waiting for /awake setup install'

  return current.isAutoHeld ? 'on, keeping the Mac awake now' : 'on, nothing running'
}

async function statusReport($: EngineInterface) {
  const current = await refresh($)
  if (current.kind !== 'read') return describeUnusable(current)

  const original = (await $.store.get(ORIGINAL_KEY)) as OriginalValue | undefined

  return [
    `Sleep prevention (pmset disablesleep, system-wide): ${onOff(current.isPreventingSleep)}`,
    `Awake while Claude works: ${describeWhileWorking(current)}`,
    `Always awake: ${onOff(isAlwaysAwake(current))}`,
    `Password: ${current.isPasswordless ? `not needed (${RULE_FILE})` : 'macOS asks on each change; /awake setup explains how to skip it'}`,
    original
      ? `Original value: ${onOff(original.isPreventingSleep)}, recorded ${original.recordedAt}; /awake restore puts it back`
      : 'Original value: not recorded (keep-awake has not changed the setting by hand)',
  ].join('\n')
}

async function explainSetup($: EngineInterface) {
  const current = await readUsableStatus($)
  const rule = sudoersRule(await currentUserName($))
  if (current.isPasswordless) {
    return `keep-awake switches without a password: ${RULE_FILE} holds\n  ${rule}\n/awake setup remove deletes it.`
  }

  return [
    'Always awake asks for your password in a macOS dialog on each change, and Awake while Claude works waits until it needs none.',
    `/awake setup install adds one visudo-checked file, ${RULE_FILE}:`,
    `  ${rule}`,
    'It allows only those two pmset commands. macOS asks for your password once to add it; keep-awake never sees it.',
    'Any process running as you can then keep this Mac awake. /awake setup remove deletes the file.',
  ].join('\n')
}

async function installSetup($: EngineInterface) {
  const before = await readUsableStatus($)
  if (before.isPasswordless) return 'keep-awake already switches without a password.'

  await installPasswordlessRule($, await currentUserName($))
  const after = await readUsableStatus($)
  if (!after.isPasswordless) throw new Error(`${RULE_FILE} was added, but sudo still asks for a password.`)
  await followClaudeWork($)

  return `Added ${RULE_FILE}. keep-awake now switches without a password.`
}

async function removeSetup($: EngineInterface) {
  const before = await readUsableStatus($)
  if (!before.isPasswordless) return 'Nothing to remove: keep-awake already asks for a password.'

  // Without the rule the while-working hold could not end by itself, so it ends now.
  if (before.isAutoHeld) {
    await writeSleepDisabled($, false, true)
    await markAutoHeld($, false)
  }
  await removePasswordlessRule($)
  const after = await readUsableStatus($)
  if (after.isPasswordless) throw new Error(`sudo still runs pmset without a password after removing ${RULE_FILE}.`)

  return `Removed ${RULE_FILE}. Always awake asks for your password again and is ${onOff(after.isPreventingSleep)}.`
}

function runAwakeCommand($: EngineInterface, args: string) {
  switch (args) {
    case 'on':
      return serially(() => changeAlwaysAwake($, () => true))
    case 'off':
      return serially(() => changeAlwaysAwake($, () => false))
    case 'working on':
      return serially(() => changeWhileWorking($, true))
    case 'working off':
      return serially(() => changeWhileWorking($, false))
    case '':
    case 'status':
      return statusReport($)
    case 'setup':
      return explainSetup($)
    case 'setup install':
      return serially(() => installSetup($))
    case 'setup remove':
      return serially(() => removeSetup($))
    case 'restore':
      return serially(() => restoreOriginalValue($))
    default:
      return USAGE
  }
}

async function pressing($: EngineInterface, action: () => Promise<string>) {
  try {
    await serially(action)
  } catch (failure) {
    $.ui.toast(`keep-awake: ${messageOf(failure)}`)
  }
}

function stateLabel(name: string, isOn: boolean, isBusy: boolean) {
  if (isBusy) return `⏳ ${name}: …`

  return `${isOn ? '☕' : '🌙'} ${name}: ${onOff(isOn)}`
}

// Each change reaches every session through the Darwin notification, so no band shows a stale value.
async function followSystemChanges($: EngineInterface) {
  const current = await refresh($)
  if (current.kind === 'unsupported') return

  try {
    await watchPowerPreferences($, () => refresh($))
  } catch (failure) {
    await update($, error, () => `Live updates stopped: ${messageOf(failure)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'awake',
      description: 'Keep this Mac awake, lid closed included: on, off, working on|off, status, restore, setup',
      argumentHint: 'on|off|working on|working off|status|restore|setup [install|remove]',
      immediate: true,
    })
    // A reload unloads the previous module and kills its notifyutil child with it.
    await update($, isChanging, () => false)
    sessionId = await $.session.id()
    claudePid = await claudeProcessId($)
    void followSystemChanges($)
    followClaudeWorkLater($)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      followClaudeWorkLater($)
    }

    return next(e)
  })

  // Raised at a main-loop turn's end, before turn.complete: what the turn leaves running wakes the session later.
  on('classic.Stop', ($, e, next) => {
    backgroundTaskCount = e.background_tasks?.length ?? 0

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      followClaudeWorkLater($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    isTurnRunning = false
    backgroundTaskCount = 0
    await serially(() => followClaudeWork($)).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'awake' }, async ($, e) => {
    try {
      return { text: await runAwakeCommand($, e.args.trim().replace(/\s+/g, ' ')) }
    } catch (failure) {
      return { text: `keep-awake: ${messageOf(failure)}` }
    }
  })

  // The notification covers the sleep value; this catches a sudoers rule installed or removed meanwhile.
  on('prompt.submit', ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    if (e.props.hasSurvey || current === null || current.kind === 'unsupported') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (current.kind === 'unreadable') return <Text color="warning">⚠ keep-awake: {current.reason}</Text>

    const failure = await read($, error)
    const isBusy = await read($, isChanging)
    const isAlwaysOn = isAlwaysAwake(current)
    const isWhileWorking = isAwakeWhileWorking(current)

    return (
      <Box gap={2}>
        <Button
          key="toggle-sleep"
          variant={isAlwaysOn ? 'primary' : 'secondary'}
          label={stateLabel('Always awake', isAlwaysOn, isBusy)}
          onPress={() => pressing($, () => changeAlwaysAwake($, isOn => !isOn))}
        />
        <Button
          key="toggle-working"
          variant={isWhileWorking ? 'primary' : 'secondary'}
          label={stateLabel('Awake while Claude works', isWhileWorking, false)}
          onPress={() => pressing($, () => changeWhileWorking($, !isWhileWorking))}
        />
        {isWhileWorking && !current.isPasswordless && <Text dimColor>needs /awake setup install</Text>}
        {current.isAutoHeld && <Text dimColor>awake now</Text>}
        {failure !== null && <Text color="error">{failure}</Text>}
      </Box>
    )
  })
}

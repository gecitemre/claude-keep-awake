import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SleepStatus } from '../types'
import {
  currentUserName,
  installPasswordlessRule,
  PMSET,
  readSleepStatus,
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

const USAGE = 'Usage: /awake on | off | status | restore | setup [install | remove]'

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
const onOff = (isOn: boolean) => (isOn ? 'on' : 'off')

async function refresh($: EngineInterface) {
  const current: SleepStatus = await readSleepStatus($).catch(failure => ({
    kind: 'unreadable' as const,
    reason: messageOf(failure),
  }))
  await update($, status, () => current)

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
async function changeSleepPrevention($: EngineInterface, choose: (isPreventingSleep: boolean) => boolean) {
  if (await read($, isChanging)) throw new Error('A change is already running.')
  await update($, isChanging, () => true)
  try {
    const before = await refresh($)
    if (before.kind !== 'read') throw new Error(describeUnusable(before))

    const wanted = choose(before.isPreventingSleep)
    if (wanted !== before.isPreventingSleep) {
      await recordOriginalValue($, before.isPreventingSleep)
      await writeSleepDisabled($, wanted, before.isPasswordless)
    }

    const after = await refresh($)
    if (after.kind !== 'read' || after.isPreventingSleep !== wanted) {
      throw new Error(`pmset still reports sleep prevention ${after.kind === 'read' ? onOff(after.isPreventingSleep) : 'unreadable'}.`)
    }
    await update($, error, () => null)

    return `Sleep prevention is ${onOff(wanted)} (pmset disablesleep ${wanted ? 1 : 0}).`
  } catch (failure) {
    await update($, error, () => messageOf(failure))
    throw failure
  } finally {
    await update($, isChanging, () => false)
  }
}

async function restoreOriginalValue($: EngineInterface) {
  const original = (await $.store.get(ORIGINAL_KEY)) as OriginalValue | undefined
  if (original === undefined) return 'No original value is recorded: keep-awake has not changed the setting.'

  const result = await changeSleepPrevention($, () => original.isPreventingSleep)
  await $.store.delete(ORIGINAL_KEY)

  return `Restored the value recorded ${original.recordedAt}. ${result}`
}

async function statusReport($: EngineInterface) {
  const current = await refresh($)
  if (current.kind !== 'read') return describeUnusable(current)

  const original = (await $.store.get(ORIGINAL_KEY)) as OriginalValue | undefined

  return [
    `Sleep prevention (pmset disablesleep, system-wide): ${onOff(current.isPreventingSleep)}`,
    `Password: ${current.isPasswordless ? `not needed (${RULE_FILE})` : 'macOS asks on each change; /awake setup explains how to skip it'}`,
    original
      ? `Original value: ${onOff(original.isPreventingSleep)}, recorded ${original.recordedAt}; /awake restore puts it back`
      : 'Original value: not recorded (keep-awake has not changed the setting)',
  ].join('\n')
}

async function explainSetup($: EngineInterface) {
  const current = await refresh($)
  if (current.kind !== 'read') return describeUnusable(current)

  const rule = sudoersRule(await currentUserName($))
  if (current.isPasswordless) {
    return `Always awake switches without a password: ${RULE_FILE} holds\n  ${rule}\n/awake setup remove deletes it.`
  }

  return [
    'Always awake asks for your password in a macOS dialog on each change.',
    `To switch it without one, /awake setup install adds one visudo-checked file, ${RULE_FILE}:`,
    `  ${rule}`,
    'It allows only those two pmset commands. macOS asks for your password once to add it; keep-awake never sees it.',
    'Any process running as you can then keep this Mac awake. /awake setup remove deletes the file.',
  ].join('\n')
}

async function installSetup($: EngineInterface) {
  const before = await refresh($)
  if (before.kind !== 'read') return describeUnusable(before)
  if (before.isPasswordless) return 'Always awake already switches without a password.'

  await installPasswordlessRule($, await currentUserName($))
  const after = await refresh($)
  if (after.kind !== 'read' || !after.isPasswordless) throw new Error(`${RULE_FILE} was added, but sudo still asks for a password.`)

  return `Added ${RULE_FILE}. Always awake now switches without a password.`
}

async function removeSetup($: EngineInterface) {
  const before = await refresh($)
  if (before.kind !== 'read') return describeUnusable(before)
  if (!before.isPasswordless) return 'Nothing to remove: Always awake already asks for a password.'

  await removePasswordlessRule($)
  const after = await refresh($)
  if (after.kind !== 'read' || after.isPasswordless) throw new Error(`sudo still runs pmset without a password after removing ${RULE_FILE}.`)

  return `Removed ${RULE_FILE}. Always awake asks for your password again and is still ${onOff(after.isPreventingSleep)}.`
}

async function runSleepCommand($: EngineInterface, args: string) {
  switch (args) {
    case 'on':
      return changeSleepPrevention($, () => true)
    case 'off':
      return changeSleepPrevention($, () => false)
    case '':
    case 'status':
      return statusReport($)
    case 'setup':
      return explainSetup($)
    case 'setup install':
      return installSetup($)
    case 'setup remove':
      return removeSetup($)
    case 'restore':
      return restoreOriginalValue($)
    default:
      return USAGE
  }
}

async function pressing($: EngineInterface, action: () => Promise<string>) {
  try {
    await action()
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
      description: 'Keep this Mac awake, lid closed included: on, off, status, restore, setup',
      argumentHint: 'on|off|status|restore|setup [install|remove]',
      immediate: true,
    })
    // A reload unloads the previous module and kills its notifyutil child with it.
    await update($, isChanging, () => false)
    void followSystemChanges($)

    return next(e)
  })

  on('command.run', { command: 'awake' }, async ($, e) => {
    try {
      return { text: await runSleepCommand($, e.args.trim().replace(/\s+/g, ' ')) }
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

    return (
      <Box gap={2}>
        <Button
          key="toggle-sleep"
          variant={current.isPreventingSleep ? 'primary' : 'secondary'}
          label={stateLabel('Always awake', current.isPreventingSleep, isBusy)}
          onPress={() => pressing($, () => changeSleepPrevention($, isOn => !isOn))}
        />
        {failure !== null && <Text color="error">{failure}</Text>}
      </Box>
    )
  })
}

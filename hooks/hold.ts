import type { EngineInterface } from 'claude-code'

// disablesleep is one system-wide value, so every session on this Mac shares one hold:
// each working session leaves a holder file naming its Claude process.
async function holdPaths($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('HOME is not set.')

  const dir = `${home}/.claude/keep-awake`
  return {
    dir,
    holders: `${dir}/holders`,
    // Present while the while-working mode, not a person, turned sleep prevention on.
    autoHeld: `${dir}/auto-held`,
    whileWorkingOff: `${dir}/while-working-off`,
  }
}

function removeFile($: EngineInterface, path: string) {
  return $.process.run(['/bin/rm', '-f', path])
}

async function isProcessAlive($: EngineInterface, pid: string) {
  const signalled = await $.process.run(['/bin/kill', '-0', pid])

  return signalled.exitCode === 0
}

// The shell's parent is the Claude Code process that runs this mod.
export async function claudeProcessId($: EngineInterface) {
  const ran = await $.process.run(['/bin/sh', '-c', 'echo $PPID'])

  return ran.stdout.trim()
}

export async function isWhileWorkingOn($: EngineInterface) {
  return !(await $.fs.exists((await holdPaths($)).whileWorkingOff))
}

export async function setWhileWorking($: EngineInterface, isOn: boolean) {
  const paths = await holdPaths($)
  if (isOn) return removeFile($, paths.whileWorkingOff)

  await $.process.run(['/bin/mkdir', '-p', paths.dir])
  await $.fs.write(paths.whileWorkingOff, '')
}

export async function isAutoHeld($: EngineInterface) {
  return $.fs.exists((await holdPaths($)).autoHeld)
}

export async function markAutoHeld($: EngineInterface, isHeld: boolean) {
  const paths = await holdPaths($)
  if (!isHeld) return removeFile($, paths.autoHeld)

  await $.process.run(['/bin/mkdir', '-p', paths.dir])
  await $.fs.write(paths.autoHeld, '')
}

export async function registerHolder($: EngineInterface, sessionId: string, pid: string) {
  const paths = await holdPaths($)
  await $.process.run(['/bin/mkdir', '-p', paths.holders])
  await $.fs.write(`${paths.holders}/${sessionId}`, pid)
}

export async function releaseHolder($: EngineInterface, sessionId: string) {
  await removeFile($, `${(await holdPaths($)).holders}/${sessionId}`)
}

// Counts the holders whose Claude process still runs, and clears the ones a crash left behind.
export async function countLiveHolders($: EngineInterface) {
  const paths = await holdPaths($)
  if (!(await $.fs.exists(paths.holders))) return 0

  let live = 0
  for (const holder of await $.fs.list(paths.holders)) {
    const path = `${paths.holders}/${holder.name}`
    if (await isProcessAlive($, (await $.fs.read(path)).trim())) live += 1
    else await removeFile($, path)
  }

  return live
}

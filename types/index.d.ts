export type SleepStatus =
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; reason: string }
  | {
      kind: 'read'
      isPreventingSleep: boolean
      isPasswordless: boolean
      isWhileWorkingOn: boolean
      // The while-working mode, not a person, turned sleep prevention on.
      isAutoHeld: boolean
    }

declare module 'claude-code' {
  interface PluginState {
    'keep-awake': {
      status: SleepStatus | null
      isChanging: boolean
      error: string | null
    }
  }
}

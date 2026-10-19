# claude-keep-awake

A Claude Code mod that keeps your Mac awake, **lid closed included**, from a button above the prompt or `/awake`.

![The Always awake button above the Claude Code prompt](docs/screenshot.png)

> Unofficial community mod, not affiliated with Anthropic. macOS only. Built on the Claude Code Mods API (early access), tested with Claude Code 2.1.299.

It switches macOS's `pmset disablesleep`, which stops all system sleep, closed lid included. The Claude desktop app's own "Keep computer awake while Claude works" setting only prevents idle sleep, so a closed lid still sleeps; this covers the lid, in the terminal and the desktop app alike.

The band above the prompt has two buttons; the one that is on uses the primary style:

- **`☕ While Claude works`** (default): awake while a session's turn runs, or background work it started (a background shell, monitor or agent), then the Mac sleeps as usual. It switches at every turn, so it acts only after `/awake setup install`; until then the band says so and nothing asks for a password.
- **`☕ Always awake`**: awake until you turn it off.

## Install

At the prompt of a terminal session:

```
/plugin install keep-awake --marketplace gecitemre/claude-keep-awake
```

From a shell:

```bash
claude plugin install keep-awake --marketplace gecitemre/claude-keep-awake
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `gecitemre/claude-keep-awake`, then Add plugin.

## Usage

```
/awake working on       keep the Mac awake while Claude works (the default)
/awake working off      stop doing that
/awake on               Always awake (pmset disablesleep 1)
/awake off              turn Always awake off (pmset disablesleep 0)
/awake status           the real setting, both modes, whether a password is needed, the recorded original value
/awake restore          return to the value from before keep-awake first changed it
/awake setup            explain passwordless switching
/awake setup install    switch without a password from now on
/awake setup remove     ask for the password again
```

## Passwords

`pmset disablesleep` needs root. By default every change opens **macOS's own authentication dialog**: nothing is installed, no privilege stays behind, and the mod never sees your password.

To switch without the dialog, run `/awake setup install`. macOS asks for your password once, and the mod adds one file, `/etc/sudoers.d/keep-awake` (root, `0440`):

```
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
```

The file is checked with `visudo -cf` before it is installed and the whole configuration with `visudo -c` after; if that fails, the file is removed again. Nothing else in sudoers is touched. `/awake setup remove` deletes it.

## How "while Claude works" is detected

- A session is working from `turn.start` to `turn.complete` of its main loop, and after that while the turn's `Stop` event still lists background tasks. Such work starts a new turn when it finishes, which checks again.
- `disablesleep` is one value for the whole Mac, so every working session leaves a holder file, `~/.claude/keep-awake/holders/<session id>`, naming its Claude Code process. The Mac sleeps again once no holder's process is alive.
- It turns sleep prevention off only if it turned it on itself, so an Always awake set by hand or by `sudo pmset` in a terminal is never undone.
- If Claude Code is force-quit mid-turn, its holder stays until another session's turn ends or Claude Code starts again, which clears holders whose process is gone. Until then the Mac stays awake.

## How state is read

- `disablesleep` is not in Apple's `man pmset`, but it is what every tool that keeps a Mac awake with the lid closed relies on; `caffeinate`'s assertions do not survive a closed lid.
- `disablesleep` is one **system-wide** value. `pmset -g` reports it as `SleepDisabled`; `pmset -g custom` lists only the per-power-source (AC, battery, UPS) settings and omits it.
- Each session listens for the `com.apple.system.powermanagement.prefschange` notification (`notifyutil -w`), which powerd posts whenever a pmset setting changes, so a change made in another session or a terminal shows in every band at once. No polling loop runs. The state is also re-read at session start, on every prompt and right before every change, so a toggle always acts on the real value.
- Always awake is never turned off when Claude Code exits. Only `/awake off` or `/awake restore` changes it back.

## Uninstall

Run `/awake setup remove` first if you installed the passwordless rule (it also ends a while-working hold), then:

```bash
claude plugin uninstall keep-awake
```

If the plugin is already gone, remove the rule by hand with `sudo rm /etc/sudoers.d/keep-awake`, and `~/.claude/keep-awake` with `rm -r`. Uninstalling leaves the sleep setting as it is; `sudo pmset -a disablesleep 0` turns it off.

## Security

- **Default (dialog):** no standing privilege. Each change needs your password, entered in macOS's dialog.
- **Passwordless rule:** your user can run exactly `/usr/bin/pmset -a disablesleep 1` and `… 0` as root without a password. sudo matches the full argument list, and `/usr/bin/pmset` is protected by System Integrity Protection, so no other command or argument gains root. The remaining risk: any process running as you (a script, a dependency, the model's Bash tool) can keep the Mac from sleeping with the lid closed, which can drain the battery or let a closed laptop overheat in a bag. It cannot read data or gain further privileges through this rule.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT
